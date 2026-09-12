/**
 * Script standalone de statusline para agy_fanout (FEAT-008 V1).
 *
 * Regresión concreta que motiva este archivo (2026-09-05): `ejecutarDelegado`
 * corría el comando delegado con el shell default de `execSync`, que en
 * Windows es `cmd.exe` — y el delegado real que guarda el setup (p. ej. el
 * propio comando de `claude-hud`) usa sintaxis POSIX (`case`, `${var:-x}`,
 * `$( )`) porque así es como Claude Code invoca `statusLine.command`. Sin
 * pedir `bash` explícitamente, el delegado fallaba con
 * "'cols' no se reconoce como un comando..." y se perdía. Detectado recién al
 * instalar la Track E de setup contra la statusline real del usuario — no lo
 * cubría ningún test hasta ahora.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { resolverBash } = require('../mcp-server/lib/bash');

const { crearEscritorDeEstado } = require('../mcp-server/fanout-estado.js');

const SCRIPT = path.join(__dirname, '..', 'mcp-server', 'fanout-statusline.js');
const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

function correr(cwd) {
  // HOME/USERPROFILE apuntan al mismo `cwd` de prueba: el script busca el
  // delegado global ahí, no en el ~/.claude real de quien corre los tests —
  // si no se aisla esto, un delegado configurado de verdad en la máquina
  // (como el de la Track E de setup) se cuela y rompe estos tests.
  return execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd }
  });
}

function escribirDelegado(cwd, delegado) {
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'antigravity.json'), JSON.stringify({ fanout_statusline_delegate: delegado }));
}

async function main() {
  let cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('sin corrida activa y sin delegado', () => {
      check('no imprime nada', correr(cwd) === '');
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('delegado con sintaxis POSIX (la regresión del shell en Windows)', () => {
      // `case` y `${VAR:-x}` no los entiende cmd.exe. Si ejecutarDelegado deja
      // de pedir `bash` explícitamente, esto vuelve a fallar en Windows.
      // Windows sin bash de Git: el script pierde el segmento a propósito
      // (lib/bash.js), así que no hay shell POSIX que probar.
      if (process.platform === 'win32' && !resolverBash()) {
        console.log('  (sin bash de Git: se omite)');
        check('el delegado corrió con un shell POSIX — omitido, sin bash de Git', true);
        return;
      }
      escribirDelegado(cwd, 'x=${NO_EXISTE:-marca-delegado}; case "$x" in marca-*) echo "$x";; esac');
      const salida = correr(cwd);
      check('el delegado corrió con un shell POSIX', salida.trim() === 'marca-delegado', JSON.stringify(salida));
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('delegado roto no rompe el script (cae al catch)', () => {
      escribirDelegado(cwd, 'comando_que_no_existe_seguro_xyz');
      const salida = correr(cwd);
      check('no revienta, imprime vacío', salida === '', JSON.stringify(salida));
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('corrida activa sin delegado', () => {
      const escritor = crearEscritorDeEstado(cwd, 'demo', [{ id: 'a' }, { id: 'b' }]);
      escritor.iniciar({ ramaBase: 'feat/demo', concurrencia: 2 });
      escritor.marcar('a', { estado: 'ok' });
      escritor.marcar('b', { estado: 'corriendo' });
      const salida = correr(cwd);
      check('muestra la línea de fanout', /fanout demo: 1\/2/.test(salida), salida);
      check('cuenta el que sigue corriendo', /1 corriendo/.test(salida), salida);
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('compone delegado + corrida activa, delegado primero', () => {
      escribirDelegado(cwd, 'echo "BASE"');
      const escritor = crearEscritorDeEstado(cwd, 'demo2', [{ id: 'a' }]);
      escritor.iniciar({});
      escritor.marcar('a', { estado: 'corriendo' });
      const salida = correr(cwd);
      const lineas = salida.trim().split('\n');
      check('primera línea es el delegado', lineas[0] === 'BASE', salida);
      check('segunda línea es el fanout', /fanout demo2/.test(lineas[1] || ''), salida);
    });
  } finally { borrar(cwd); }

  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-sl-'));
  try {
    await group('corrida terminada hace rato no se muestra (TTL)', () => {
      const escritor = crearEscritorDeEstado(cwd, 'vieja', [{ id: 'a' }]);
      escritor.iniciar({});
      escritor.marcar('a', { estado: 'ok' });
      escritor.terminar();
      const ruta = escritor.rutaArchivo;
      const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      datos.terminado = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      fs.writeFileSync(ruta, JSON.stringify(datos));
      check('no imprime nada', correr(cwd) === '');
    });
  } finally { borrar(cwd); }

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
