/**
 * Escritor de estado de fan-out (FEAT-005 V1).
 *
 * El lector real es un proceso Node aparte (fanout-statusline.js) que corre
 * cada pocos segundos; acá solo se prueba el escritor: que arranca con todas
 * las tareas en `pendiente`, que `marcar` hace merge sin pisar el resto, y
 * que `terminar` deja `terminado` seteado. La atomicidad del rename no se
 * puede observar desde un test síncrono de un solo proceso — se confía en que
 * `fs.renameSync` es atómico, mismo supuesto que ya hace `recordUsage` en
 * mcp-server/index.js para antigravity-usage.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { check, group, report } = require('./lib/assert');

const { rutaEstado, crearEscritorDeEstado } = require('../mcp-server/fanout-estado.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

async function main() {
  let repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-estado-'));
  try {
    await group('ciclo de vida completo', () => {
      const tareas = [{ id: 'a' }, { id: 'b' }];
      const escritor = crearEscritorDeEstado(repo, 'mi lote', tareas);

      check('la ruta usa el slug normalizado', escritor.rutaArchivo === rutaEstado(repo, 'mi lote'));
      check('no escribe nada hasta iniciar()', !fs.existsSync(escritor.rutaArchivo));

      escritor.iniciar({ ramaBase: 'feat/mi-lote', concurrencia: 2 });
      let datos = JSON.parse(fs.readFileSync(escritor.rutaArchivo, 'utf8'));
      check('arranca con ambas tareas pendientes',
        datos.tareas.a.estado === 'pendiente' && datos.tareas.b.estado === 'pendiente');
      check('guarda ramaBase y concurrencia', datos.ramaBase === 'feat/mi-lote' && datos.concurrencia === 2);
      check('todavía no terminó', datos.terminado === null);

      escritor.marcar('a', { estado: 'corriendo', inicio: '2026-01-01T00:00:00.000Z' });
      datos = JSON.parse(fs.readFileSync(escritor.rutaArchivo, 'utf8'));
      check('marca solo la tarea indicada', datos.tareas.a.estado === 'corriendo');
      check('no toca la otra tarea', datos.tareas.b.estado === 'pendiente');

      escritor.marcar('a', { estado: 'reintentando', intentos: 2, porCuota: true });
      datos = JSON.parse(fs.readFileSync(escritor.rutaArchivo, 'utf8'));
      check('el merge conserva `inicio` de la marca anterior', datos.tareas.a.inicio === '2026-01-01T00:00:00.000Z');
      check('y agrega los campos nuevos', datos.tareas.a.intentos === 2 && datos.tareas.a.porCuota === true);

      escritor.marcar('a', { estado: 'ok', fin: '2026-01-01T00:05:00.000Z' });
      escritor.marcar('b', { estado: 'error', porCuota: false });
      escritor.terminar();
      datos = JSON.parse(fs.readFileSync(escritor.rutaArchivo, 'utf8'));
      check('estado final de cada tarea', datos.tareas.a.estado === 'ok' && datos.tareas.b.estado === 'error');
      check('terminado queda seteado', typeof datos.terminado === 'string' && datos.terminado.length > 0);
      check('no deja temporales sueltos',
        fs.readdirSync(path.dirname(escritor.rutaArchivo)).every(n => !n.endsWith('.tmp')));
    });

    await group('marcar antes de iniciar no revienta', () => {
      const escritor = crearEscritorDeEstado(repo, 'sin-iniciar', [{ id: 'a' }]);
      let lanzo = false;
      try { escritor.marcar('a', { estado: 'corriendo' }); } catch { lanzo = true; }
      check('marcar es un no-op silencioso sin archivo previo', !lanzo);
      check('sigue sin crear el archivo', !fs.existsSync(escritor.rutaArchivo));
    });

    await group('slugs distintos no se pisan', () => {
      const e1 = crearEscritorDeEstado(repo, 'lote-uno', [{ id: 'a' }]);
      const e2 = crearEscritorDeEstado(repo, 'lote-dos', [{ id: 'a' }]);
      e1.iniciar({});
      e2.iniciar({});
      check('cada slug tiene su propio archivo', e1.rutaArchivo !== e2.rutaArchivo);
      check('ambos archivos existen', fs.existsSync(e1.rutaArchivo) && fs.existsSync(e2.rutaArchivo));
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
