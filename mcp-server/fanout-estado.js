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
      tareas: Object.fromEntries(tareas.map(t => [t.id, { estado: 'pendiente', intentos: 0 }]))
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

module.exports = { rutaEstado, crearEscritorDeEstado, DIR_WORKTREES };
