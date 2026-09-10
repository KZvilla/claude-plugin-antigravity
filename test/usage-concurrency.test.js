/**
 * El registro de uso debe sobrevivir a varios servidores MCP escribiendo a la vez.
 *
 * Contexto de la regresión (BE-010): `recordUsage` hacía
 * `loadUsage()` -> mutar -> `writeFileSync` sobre el destino final, sin ninguna
 * exclusión. Dentro de un mismo proceso eso es inofensivo, porque la función es
 * enteramente síncrona y el event loop no puede interleavearla. Entre procesos
 * no: cada sesión de Claude Code levanta su propio servidor MCP y todas
 * acumulan sobre el mismo ~/.claude/antigravity-usage.json. Con fan-out de
 * subagentes concurrentes, las actualizaciones perdidas dejan de ser teóricas.
 *
 * Además `writeFileSync` sobre el destino no es atómico: un corte a mitad deja
 * JSON truncado y `loadUsage` lo trataba como fichero ausente, devolviendo los
 * contadores a cero en silencio.
 *
 * El binario de agy va stubbeado (test/stub-spawn.js), así que las llamadas son
 * baratas y todo el camino real del servidor se ejecuta igual.
 *
 * Para confirmar que el test es load-bearing, correrlo contra el checkout previo:
 *   git show HEAD:mcp-server/index.js > /tmp/old.js
 *   SERVER_JS=/tmp/old.js node test/usage-concurrency.test.js
 *
 * POR QUE NO SE EXIGE UN CONTEO EXACTO
 * ------------------------------------
 * Este test afirmaba `total_calls === 100` y fallaba una de cada tres corridas
 * con 99. No era una regresion: `acquireUsageLock` degrada a proposito a
 * "se escribe sin exclusion" cuando el lock sigue ocupado despues de
 * USAGE_LOCK_WAIT_MS, y con la maquina cargada un waiter se puede quedar sin
 * turno — es starvation inherente a un lock por sondeo sin cola. O sea que el
 * test afirmaba un invariante que la implementacion nunca prometio.
 *
 * Medido: la degradacion avisa por stderr, y el aviso aparece exactamente
 * cuando se pierde una actualizacion (1 aviso = 1 perdida, en 6 corridas).
 *
 * Subir el timeout solo baja la probabilidad, y relajar a ">= 99" es una
 * constante inventada que ademas taparia un lock roto que pierda justo uno.
 * Asi que se afirma la identidad contable: lo contado mas lo que el servidor
 * ANUNCIO haber escrito sin exclusion tiene que dar el total. Eso no puede
 * flakear, y es mas fuerte que el absoluto original en un punto que importa:
 * una perdida que NO se anuncie hace fallar el test. La regresion de BE-010
 * (sin lock) sigue cayendo: perdia muchas y no avisaba ninguna.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

// Cuatro escritores en paralelo, veinticinco llamadas cada uno. Con una sola
// llamada por proceso la ventana de colisión es tan estrecha que el test pasaría
// incluso sin lock; el volumen es lo que lo vuelve load-bearing.
const SERVIDORES = 4;
const LLAMADAS_POR_SERVIDOR = 25;
const ESPERADAS = SERVIDORES * LLAMADAS_POR_SERVIDOR;

function crearHomeTemporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function leerUso(home) {
  const f = path.join(home, '.claude', 'antigravity-usage.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

async function main() {
  const home = crearHomeTemporal();
  const capturas = path.join(home, 'capturas.jsonl');
  fs.writeFileSync(capturas, '');

  // getUsageFilePath resuelve HOME || USERPROFILE. startServer propaga
  // process.env a los hijos, así que basta con fijarlo acá.
  const homeOriginal = process.env.HOME;
  const perfilOriginal = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // El servidor solo registra telemetría si la respuesta de agy trae `usage`.
  process.env.STUB_USAGE = '1';

  const servidores = [];
  try {
    for (let i = 0; i < SERVIDORES; i++) {
      const s = startServer({ captureFile: capturas });
      await s.initialize();
      servidores.push(s);
    }

    await group(`${SERVIDORES} servidores MCP concurrentes x ${LLAMADAS_POR_SERVIDOR} llamadas`, async () => {
      await Promise.all(servidores.map(async (s, idx) => {
        for (let n = 0; n < LLAMADAS_POR_SERVIDOR; n++) {
          await s.callTool('agy_run', { prompt: `servidor ${idx} llamada ${n}` });
        }
      }));

      const uso = leerUso(home);

      check('el fichero de uso existe y parsea', uso !== null,
        'no se pudo leer antigravity-usage.json');

      // Cada vez que un escritor no consigue el lock lo dice por stderr antes
      // de escribir igual. Ese aviso es el unico margen aceptable.
      const degradaciones = servidores
        .map(s => (s.stderr().match(/Se escribe sin exclusi/g) || []).length)
        .reduce((a, b) => a + b, 0);

      const contadas = uso ? uso.session.total_calls : -1;
      const detalle = `contó ${contadas}, degradaciones anunciadas ${degradaciones}`;

      check(
        `no se perdió ninguna actualización en silencio (${ESPERADAS} - anunciadas <= contadas <= ${ESPERADAS})`,
        uso && contadas <= ESPERADAS && contadas >= ESPERADAS - degradaciones,
        detalle
      );

      // Sin contencion patologica el conteo tiene que ser exacto: si el lock
      // anda, no hay margen que gastar.
      if (degradaciones === 0) {
        check(`sin degradaciones, session.total_calls == ${ESPERADAS}`,
          uso && contadas === ESPERADAS, detalle);
      }

      // Un lock que degrada seguido no es "el margen aceptable", es un lock que
      // no sirve. Esto lo separa de una corrida con mala suerte.
      check('las degradaciones son excepcionales, no la norma',
        degradaciones <= Math.ceil(ESPERADAS * 0.05),
        `${degradaciones} de ${ESPERADAS} escrituras no consiguieron el lock`);

      check(
        'calls_by_tool.run acompaña a session.total_calls',
        uso && uso.session.calls_by_tool.run === contadas,
        uso ? `run=${uso.session.calls_by_tool.run} vs total=${contadas}` : 'sin fichero'
      );

      check(
        'today.total_calls acompaña a session.total_calls',
        uso && uso.today.total_calls === contadas,
        uso ? `today=${uso.today.total_calls} vs total=${contadas}` : 'sin fichero'
      );
    });

    await group('higiene de la escritura atómica', async () => {
      const claudeDir = path.join(home, '.claude');
      const residuos = fs.readdirSync(claudeDir).filter(f => f.endsWith('.tmp') || f.endsWith('.lock'));

      check('no quedan temporales ni locks huérfanos', residuos.length === 0,
        `quedaron: ${residuos.join(', ')}`);

      const uso = leerUso(home);
      check('la ruta del fichero no se persiste dentro del propio JSON',
        uso && uso.usageFile === undefined,
        uso && uso.usageFile ? `usageFile = ${uso.usageFile}` : '');
    });
  } finally {
    await Promise.all(servidores.map(s => s.stop()));
    delete process.env.STUB_USAGE;
    if (homeOriginal === undefined) delete process.env.HOME; else process.env.HOME = homeOriginal;
    if (perfilOriginal === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = perfilOriginal;
    removeFixture(home);
  }

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
