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

      check(
        `session.total_calls == ${ESPERADAS} (sin actualizaciones perdidas)`,
        uso && uso.session.total_calls === ESPERADAS,
        uso ? `contó ${uso.session.total_calls}, se perdieron ${ESPERADAS - uso.session.total_calls}` : 'sin fichero'
      );

      check(
        `calls_by_tool.run == ${ESPERADAS}`,
        uso && uso.session.calls_by_tool.run === ESPERADAS,
        uso ? `contó ${uso.session.calls_by_tool.run}` : 'sin fichero'
      );

      check(
        `today.total_calls == ${ESPERADAS}`,
        uso && uso.today.total_calls === ESPERADAS,
        uso ? `contó ${uso.today.total_calls}` : 'sin fichero'
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
