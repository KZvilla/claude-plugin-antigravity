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

const { rutaEstado, crearEscritorDeEstado, rutaControl, marcarDetencion, crearLectorDeControl } = require('../mcp-server/fanout-estado.js');

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
    await group('centinela de detención por tarea (FEAT-012)', () => {
      const lector = crearLectorDeControl(repo, 'mi lote');

      check('sin pedido no hay nada que consumir', lector.consumirDetencion('a') === null);

      marcarDetencion(repo, 'mi lote', 'a', 'se fue por las ramas');
      check('el archivo existe donde rutaControl dice', fs.existsSync(rutaControl(repo, 'mi lote', 'a')));

      const consumido = lector.consumirDetencion('a');
      check('devuelve el motivo', consumido && consumido.motivo === 'se fue por las ramas');
      check('trae timestamp', typeof consumido.detenidoEn === 'string' && consumido.detenidoEn.length > 0);
      check('lo borra al consumirlo', !fs.existsSync(rutaControl(repo, 'mi lote', 'a')));
      check('un segundo consumo ya no encuentra nada', lector.consumirDetencion('a') === null);

      marcarDetencion(repo, 'mi lote', 'b');
      check('motivo es null si no se pasa', lector.consumirDetencion('b').motivo === null);

      check('no deja temporales sueltos',
        fs.readdirSync(path.dirname(rutaControl(repo, 'mi lote', 'a'))).every(n => !n.endsWith('.tmp')));
    });

    await group('el centinela no cruza tareas ni slugs', () => {
      marcarDetencion(repo, 'lote-x', 'a');
      const lectorY = crearLectorDeControl(repo, 'lote-y');
      const lectorXOtraTarea = crearLectorDeControl(repo, 'lote-x');
      check('otro slug no lo ve', lectorY.consumirDetencion('a') === null);
      check('el mismo slug pero otra tarea no lo ve', lectorXOtraTarea.consumirDetencion('otra') === null);
      check('la tarea correcta sí lo ve', crearLectorDeControl(repo, 'lote-x').consumirDetencion('a') !== null);
    });

    await group('limpiar() borra sin exigir que exista', () => {
      const lector = crearLectorDeControl(repo, 'lote-limpieza');
      let lanzo = false;
      try { lector.limpiar('nunca-existio'); } catch { lanzo = true; }
      check('no revienta si no había nada', !lanzo);

      marcarDetencion(repo, 'lote-limpieza', 'a');
      lector.limpiar('a');
      check('borra un centinela existente', !fs.existsSync(rutaControl(repo, 'lote-limpieza', 'a')));
    });

    await group('taskIds con caracteres raros no rompen la ruta', () => {
      marcarDetencion(repo, 'lote-raro', 'Tarea Con Espacios/Barras');
      const lector = crearLectorDeControl(repo, 'lote-raro');
      check('se puede consumir igual', lector.consumirDetencion('Tarea Con Espacios/Barras') !== null);
    });

    await group('taskIds largos que solo difieren después del carácter 40 no colisionan', () => {
      // Regresión de la auditoría adversarial (agy_audit, 2026-09-09): con
      // slugificarArchivo solo (trunca a 40 chars), estos dos ids producían
      // el mismo nombre de archivo y compartían centinela.
      const idA = 'feature-subtask-implementation-step-001-parte-a';
      const idB = 'feature-subtask-implementation-step-001-parte-b';
      check('los primeros 40 chars son iguales a propósito', idA.slice(0, 40) === idB.slice(0, 40));

      const lector = crearLectorDeControl(repo, 'lote-colision');
      check('distintas rutas de archivo', rutaControl(repo, 'lote-colision', idA) !== rutaControl(repo, 'lote-colision', idB));

      marcarDetencion(repo, 'lote-colision', idA);
      check('B no ve el centinela de A', lector.consumirDetencion(idB) === null);
      check('A sigue teniendo el suyo', lector.consumirDetencion(idA) !== null);
    });

    await group('marcarDetencion reintenta ante EPERM/EBUSY transitorio (FEAT-012)', () => {
      // Regresión de la auditoría adversarial (agy_audit, 2026-09-09): en
      // Windows, escribir el centinela mientras el orquestador lo está
      // leyendo/borrando del otro lado (consumirDetencion, otro proceso) hace
      // que renameSync tire EPERM/EBUSY — reproducido de verdad corriendo el
      // test de integración de fanout.test.js en loop. Acá se simula sin
      // depender de una carrera real: se hace que renameSync falle dos veces
      // y a la tercera pase.
      const renameOriginal = fs.renameSync;
      let llamadas = 0;
      fs.renameSync = (origen, destino) => {
        llamadas++;
        if (llamadas <= 2) {
          const err = new Error('EPERM simulado');
          err.code = 'EPERM';
          throw err;
        }
        return renameOriginal(origen, destino);
      };

      try {
        let lanzo = false;
        try {
          marcarDetencion(repo, 'lote-eperm', 'a');
        } catch { lanzo = true; }
        check('no propaga el error transitorio', !lanzo);
        check('reintentó hasta pasar (3 intentos)', llamadas === 3, `llamadas = ${llamadas}`);

        const lector = crearLectorDeControl(repo, 'lote-eperm');
        check('el centinela quedó escrito de verdad', lector.consumirDetencion('a') !== null);
      } finally {
        fs.renameSync = renameOriginal;
      }
    });

    await group('marcarDetencion no reintenta un error que no es transitorio', () => {
      const renameOriginal = fs.renameSync;
      let llamadas = 0;
      fs.renameSync = () => {
        llamadas++;
        const err = new Error('ENOENT simulado');
        err.code = 'ENOENT';
        throw err;
      };

      try {
        let lanzo = false;
        try {
          marcarDetencion(repo, 'lote-enoent', 'a');
        } catch { lanzo = true; }
        check('propaga un error no transitorio', lanzo);
        check('un solo intento, no reintenta lo que no tiene sentido reintentar', llamadas === 1, `llamadas = ${llamadas}`);
      } finally {
        fs.renameSync = renameOriginal;
      }
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
