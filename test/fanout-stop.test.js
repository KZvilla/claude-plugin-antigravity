/**
 * CLI standalone fanout-stop.js (FEAT-012).
 *
 * Se prueba como proceso aparte (igual que fanout-statusline.js no tiene un
 * test de "requerir el módulo", sino de invocarlo) porque su contrato real es
 * la línea de comandos: `node fanout-stop.js <repoPath> <slug> <taskId>
 * [motivo...]`, pensada para invocarse a mano o desde un pane, no para
 * requerirse desde otro módulo.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const { rutaControl, crearLectorDeControl } = require('../mcp-server/fanout-estado.js');

const SCRIPT = path.join(__dirname, '..', 'mcp-server', 'fanout-stop.js');
const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

async function main() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-stop-'));
  try {
    await group('escribe el centinela con motivo', () => {
      const salida = execFileSync(process.execPath, [SCRIPT, repo, 'mi-lote', 'tarea-a', 'se', 'fue', 'por', 'las', 'ramas'], { encoding: 'utf8' });
      check('confirma el taskId', /tarea-a/.test(salida));
      check('confirma el lote', /mi-lote/.test(salida));
      check('el archivo queda en la ruta esperada', fs.existsSync(rutaControl(repo, 'mi-lote', 'tarea-a')));

      const lector = crearLectorDeControl(repo, 'mi-lote');
      const consumido = lector.consumirDetencion('tarea-a');
      check('el motivo llega entero, con espacios', consumido.motivo === 'se fue por las ramas');
    });

    await group('motivo es opcional', () => {
      execFileSync(process.execPath, [SCRIPT, repo, 'otro-lote', 'tarea-b'], { encoding: 'utf8' });
      const lector = crearLectorDeControl(repo, 'otro-lote');
      const consumido = lector.consumirDetencion('tarea-b');
      check('queda null sin motivo', consumido.motivo === null);
    });

    await group('sin argumentos suficientes falla con código distinto de 0', () => {
      let fallo = false;
      try {
        execFileSync(process.execPath, [SCRIPT, repo, 'lote-incompleto'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (err) {
        fallo = true;
        check('imprime el uso en stderr', /Uso:/.test(err.stderr.toString()));
      }
      check('no crea nada y sale con error', fallo);
    });
  } finally {
    borrar(repo);
  }

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
