/**
 * Estado de orquestación de un fan-out, persistido a disco (FEAT-005 V1).
 *
 * `agy_fanout` es una única llamada MCP bloqueante que puede tardar 15+
 * minutos; mientras corre, Claude Code no tiene ninguna señal intermedia. Este
 * módulo le da a algo EXTERNO a esa llamada —el script de statusline en
 * fanout-statusline.js— una forma de saber en qué va cada subagente, sin
 * esperar a que la tool call termine.
 *
 * A propósito, esto trackea solo el estado de ORQUESTACIÓN que fanout.js ya
 * conoce (pendiente/corriendo/reintentando/ok/error), no el stdout interno de
 * cada `agy`. Verlo en detalle es trabajo de una vista más rica (V2); acá
 * alcanza con la señal barata.
 *
 * Todas las escrituras de una corrida vienen del mismo proceso Node (el MCP
 * server) y usan fs síncrono, así que no hay carrera dentro del proceso — el
 * único lector concurrente real es el script de statusline, en un proceso
 * aparte. Para que nunca vea un archivo a medio escribir, se escribe a un
 * temporal y se hace `renameSync` (atómico), mismo patrón que ya usa
 * `recordUsage` en index.js para antigravity-usage.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR_WORKTREES = path.join('.claude', 'worktrees');

function slugificarArchivo(slug) {
  return String(slug || 'tarea')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tarea';
}

function rutaEstado(repoPath, slug) {
  return path.join(repoPath, DIR_WORKTREES, `.fanout-status-${slugificarArchivo(slug)}.json`);
}

/**
 * Igual que slugificarArchivo, pero pensado para un `taskId` que va a
 * formar parte de un NOMBRE DE ARCHIVO junto al de otras tareas del mismo
 * lote — no alcanza con truncar a 40 chars y listo: dos ids que solo
 * difieren después del carácter 40 producirían el mismo archivo y
 * terminarían compartiendo el mismo centinela (encontrado por auditoría
 * adversarial, agy_audit, 2026-09-09). El sufijo hash hace la colisión
 * computacionalmente despreciable sin perder la parte legible para debug.
 */
function idParaArchivo(taskId) {
  const legible = slugificarArchivo(taskId).slice(0, 24);
  const hash = crypto.createHash('sha1').update(String(taskId)).digest('hex').slice(0, 10);
  return `${legible}-${hash}`;
}

/**
 * Centinela de detención por tarea (FEAT-012).
 *
 * A propósito NO es un único archivo compartido con un array de ids: eso
 * reintroduce entre procesos (varios panes, o un pane y la CLI) exactamente
 * la carrera que BE-010 tuvo que resolver con un lock para
 * antigravity-usage.json. Con un archivo por `taskId`, cada uno tiene como
 * máximo un escritor posible por construcción — nada más que quien apunta a
 * ese taskId va a crear ese path exacto — así que no hace falta lock.
 */
function rutaControl(repoPath, slug, taskId) {
  return path.join(repoPath, DIR_WORKTREES, `.fanout-stop-${slugificarArchivo(slug)}-${idParaArchivo(taskId)}.json`);
}

const RENAME_REINTENTOS = 5;
const RENAME_ESPERA_MS = 15;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * No hay un escritor rival del que protegerse (rutaControl es un archivo por
 * taskId), pero SÍ hay un lector-y-borrador rival: `consumirDetencion` del
 * lado del orquestador hace su propio `readFileSync`/`unlinkSync` sobre este
 * mismo path, en otro proceso. En Windows eso puede dejar el destino
 * brevemente tomado y `renameSync` tira `EPERM`/`EBUSY` — no hipotético:
 * reproducido escribiendo en loop rápido mientras el otro lado sondea
 * (auditoría adversarial, agy_audit, 2026-09-09). No hace falta un lock como
 * el de antigravity-usage.json (BE-010): el conflicto es transitorio, no una
 * carrera de datos — `consumirDetencion` ya tolera un archivo ausente o a
 * medio escribir. Alcanza con reintentar el rename unos milisegundos.
 */
function renombrarConReintento(origen, destino) {
  for (let intento = 0; ; intento++) {
    try {
      fs.renameSync(origen, destino);
      return;
    } catch (err) {
      const transitorio = err && (err.code === 'EPERM' || err.code === 'EBUSY');
      if (!transitorio || intento >= RENAME_REINTENTOS) throw err;
      sleepSync(RENAME_ESPERA_MS);
    }
  }
}

/**
 * Pide que se detenga una tarea en vuelo. La escritura es atómica
 * (temporal + rename), con reintento ante contención transitoria — ver
 * renombrarConReintento.
 */
function marcarDetencion(repoPath, slug, taskId, motivo) {
  const ruta = rutaControl(repoPath, slug, taskId);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ detenidoEn: new Date().toISOString(), motivo: motivo || null }, null, 2), 'utf8');
  renombrarConReintento(tmp, ruta);
}

/**
 * Lector del lado del orquestador. `consumirDetencion` no solo chequea: borra
 * el centinela al leerlo, para que un pedido de esta corrida no sobreviva y
 * mate en silencio a un subagente de una corrida futura que reuse el mismo
 * slug/taskId (p. ej. reintentar un lote fallido).
 */
function crearLectorDeControl(repoPath, slug) {
  return {
    consumirDetencion(taskId) {
      const ruta = rutaControl(repoPath, slug, taskId);
      let datos;
      try {
        datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      } catch {
        return null; // no existe (el caso normal) o quedó a medio escribir: no hay pedido válido.
      }
      try { fs.unlinkSync(ruta); } catch {}
      return datos;
    },
    limpiar(taskId) {
      try { fs.unlinkSync(rutaControl(repoPath, slug, taskId)); } catch {}
    }
  };
}

/**
 * Log NDJSON por subagente (FEAT-009), un archivo por `taskId`.
 *
 * A propósito NO vive dentro del worktree del subagente (`<worktree>/.agy-
 * progress.jsonl`, como decía la propuesta original en §7.1) — un archivo
 * suelto ahí lo vería `git status --porcelain` como cambio sin commitear y
 * `inspeccionarWorktrees` (FEAT-003) clasificaría el worktree como "sucio"
 * aunque el subagente no haya tocado nada, bloqueando la limpieza automática.
 * Mismo escarmiento que ya dejó FEAT-012 con el centinela de control: los
 * archivos de orquestación van a nivel de repo, bajo `.claude/worktrees/`,
 * nunca dentro de cada worktree.
 */
function rutaProgreso(repoPath, slug, taskId) {
  return path.join(repoPath, DIR_WORKTREES, `.agy-progress-${slugificarArchivo(slug)}-${idParaArchivo(taskId)}.jsonl`);
}

/**
 * Borra el log de una corrida anterior con el mismo slug/taskId, para que no
 * se mezcle con el de esta — mismo motivo y mismo punto de enganche
 * (`limpiarControlPrevio`, una sola vez antes del primer lote) que FEAT-012.
 */
function limpiarProgreso(repoPath, slug, taskId) {
  try { fs.unlinkSync(rutaProgreso(repoPath, slug, taskId)); } catch {}
}

/**
 * @param {string} repoPath
 * @param {string} slug
 * @param {Array<{id:string}>} tareas
 *
 * `ramaBase` y `concurrencia` no se conocen todavía en este punto —
 * `lanzarFanout` recién los resuelve después de validar el reparto—, así que
 * se piden como argumento de `iniciar()` en vez de acá, para no forzar a
 * quien construye el escritor a duplicar `prepararRamaBase`.
 */
function crearEscritorDeEstado(repoPath, slug, tareas) {
  const rutaArchivo = rutaEstado(repoPath, slug);

  function escribir(datos) {
    fs.mkdirSync(path.dirname(rutaArchivo), { recursive: true });
    const tmp = `${rutaArchivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2), 'utf8');
    fs.renameSync(tmp, rutaArchivo);
  }

  function leer() {
    try {
      return JSON.parse(fs.readFileSync(rutaArchivo, 'utf8'));
    } catch {
      return null;
    }
  }

  function iniciar(meta = {}) {
    const ahora = new Date().toISOString();
    const datos = {
      slug,
      ramaBase: meta.ramaBase || null,
      concurrencia: meta.concurrencia || null,
      iniciado: ahora,
      actualizado: ahora,
      terminado: null,
      // `meta.meta[id]` trae lo que se sabe de la tarea al arrancar (archivos,
      // rama, modelo — FEAT-015). Es opcional: sin él, el arranque es el de
      // siempre. Los consumidores existentes ignoran propiedades que no
      // conocen, así que agrandar cada tarea no rompe la statusline.
      tareas: Object.fromEntries(tareas.map(t => [t.id, {
        estado: 'pendiente',
        intentos: 0,
        ...((meta.meta && meta.meta[t.id]) || {})
      }]))
    };
    escribir(datos);
  }

  function marcar(taskId, cambios) {
    const datos = leer();
    if (!datos) return; // iniciar() no se llamó o el archivo se perdió: no hay nada que fusionar.
    datos.tareas[taskId] = { ...(datos.tareas[taskId] || {}), ...cambios };
    datos.actualizado = new Date().toISOString();
    escribir(datos);
  }

  function terminar() {
    const datos = leer();
    if (!datos) return;
    datos.terminado = new Date().toISOString();
    datos.actualizado = datos.terminado;
    escribir(datos);
  }

  return { iniciar, marcar, terminar, rutaArchivo };
}

module.exports = {
  rutaEstado, crearEscritorDeEstado, DIR_WORKTREES,
  rutaControl, marcarDetencion, crearLectorDeControl,
  rutaProgreso, limpiarProgreso
};
