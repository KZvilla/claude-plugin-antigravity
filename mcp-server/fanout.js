/**
 * Orquestador de fan-out concurrente de subagentes de Antigravity (FEAT-005).
 *
 * Cubre solo la FASE DE LANZAMIENTO del ciclo descrito en
 * docs/future-implementations/subagentes-concurrentes-agy.md §4.4: validar el
 * reparto, preparar la rama base, crear un worktree por tarea y ejecutarlas en
 * lotes con tope de concurrencia y reintento ante cuota agotada.
 *
 * Lo que este módulo NO hace, a propósito: auditar, testear e integrar. Esa
 * frontera se queda en Claude (Arquitectura A del documento). Mover la auditoría
 * acá dentro sería justamente lo que la arquitectura alternativa hace mal: quien
 * escribe el código no debe firmar su propia revisión, y quien la encarga
 * necesita ver los diffs.
 *
 * `ejecutar` se inyecta para poder probar la orquestación —el reparto en lotes,
 * el backoff, el mapeo tarea→worktree— sin lanzar un solo proceso de agy.
 */
const { validarReparto, explicarReparto } = require('./reparto.js');
const { prepararRamaBase, crearWorktrees } = require('./worktrees.js');

const CONCURRENCIA_POR_DEFECTO = 3;
const REINTENTOS_POR_CUOTA = 2;
const ESPERA_BASE_MS = 20000;

function esErrorDeCuota(texto) {
  const t = String(texto || '');
  return /\b429\b/.test(t) || /quota|rate.?limit/i.test(t);
}

const dormir = ms => new Promise(r => setTimeout(r, ms));

/**
 * Guardarraíles que van al principio del prompt de cada subagente.
 *
 * Son instrucciones, no controles: `allow`/`deny` viajan como texto en el prompt
 * y no tienen enforcement (H4 del documento). Lo único que sí confina de verdad
 * es el worktree — y confina la ESCRITURA, no la lectura.
 */
function reglasDelSubagente(tarea) {
  return [
    '[REGLAS DE ESTE SUBAGENTE — FAN-OUT CONCURRENTE]',
    '- Tu directorio de trabajo es un git worktree propio y aislado. Trabajá solo dentro de él.',
    `- Archivos que te corresponden: ${tarea.archivos.join(', ')}. No modifiques ningún otro.`,
    '- NO escribas ni ejecutes tests. De los tests se encarga el orquestador, no vos.',
    '- NO hagas merge, NO cambies de rama, NO toques otras ramas.',
    '- NO invoques subagentes.',
    '- Al terminar, commiteá tu trabajo en la rama actual con un mensaje descriptivo.',
    '',
    '[TAREA]',
    tarea.prompt
  ].join('\n');
}

/**
 * Ejecuta una tarea, reintentando solo si el fallo es por cuota. Un error de
 * código no se reintenta: repetirlo cuesta lo mismo y da lo mismo.
 */
async function ejecutarConReintento(ejecutar, peticion, { reintentos, esperaBaseMs, alDormir }) {
  let ultimo = null;
  // Los intentos REALIZADOS, no los presupuestados: un error de código sale del
  // bucle a la primera, y reportar el máximo haría creer que se reintentó.
  let realizados = 0;

  for (let intento = 0; intento <= reintentos; intento++) {
    realizados = intento + 1;
    const resultado = await ejecutar(peticion);
    if (resultado && resultado.success) return { ...resultado, intentos: realizados };

    ultimo = resultado;
    const mensaje = (resultado && resultado.error) || '';
    if (!esErrorDeCuota(mensaje) || intento === reintentos) break;

    // Backoff exponencial: la cuota se recupera con el tiempo, no con insistencia.
    await alDormir(esperaBaseMs * Math.pow(2, intento));
  }

  return { ...(ultimo || { success: false, error: 'sin respuesta del ejecutor' }), intentos: realizados };
}

/**
 * @param {object} opciones
 * @param {string} opciones.repoPath        Raíz del repositorio.
 * @param {string} opciones.slug            Nombre corto del lote (da nombre a ramas y worktrees).
 * @param {Array}  opciones.tareas          Tareas atómicas; ver reparto.js.
 * @param {number} [opciones.concurrencia]  Tamaño del lote paralelo.
 * @param {string} [opciones.modelo]        Modelo por defecto del lote.
 * @param {string} [opciones.effort]        Effort por defecto del lote.
 * @param {number} [opciones.timeoutMinutes]
 * @param {object} deps
 * @param {Function} deps.ejecutar          Recibe la petición y devuelve { success, ... }.
 */
async function lanzarFanout(opciones, deps) {
  const {
    repoPath,
    slug,
    tareas,
    concurrencia = CONCURRENCIA_POR_DEFECTO,
    modelo,
    effort,
    timeoutMinutes,
    reintentosPorCuota = REINTENTOS_POR_CUOTA,
    esperaBaseMs = ESPERA_BASE_MS
  } = opciones || {};

  const ejecutar = deps && deps.ejecutar;
  if (typeof ejecutar !== 'function') throw new Error('lanzarFanout requiere deps.ejecutar');
  const alDormir = (deps && deps.alDormir) || dormir;

  if (!Number.isInteger(concurrencia) || concurrencia < 1) {
    throw new Error(`concurrencia debe ser un entero >= 1, recibido: ${concurrencia}`);
  }

  // 1. Validar el reparto ANTES de crear worktrees o gastar cuota.
  const veredicto = validarReparto(tareas);
  if (!veredicto.valido) {
    return {
      lanzado: false,
      motivo: 'reparto inválido',
      detalle: explicarReparto(veredicto),
      veredicto
    };
  }

  // 2. Rama base según la convención: nunca main/master.
  const base = prepararRamaBase(repoPath, slug);

  // 3. Un worktree por tarea, cada uno con su propia rama derivada de la base.
  const worktrees = crearWorktrees(repoPath, {
    slug,
    cantidad: tareas.length,
    ramaBase: base.rama
  });

  const asignacion = tareas.map((t, i) => ({ tarea: t, worktree: worktrees[i] }));

  // 4. Ejecución en lotes. El tope existe por cuota, no por CPU: lanzar las N de
  //    golpe es la forma más rápida de comerse un 429 y perder el lote entero.
  const resultados = [];
  for (let inicio = 0; inicio < asignacion.length; inicio += concurrencia) {
    const lote = asignacion.slice(inicio, inicio + concurrencia);

    const delLote = await Promise.all(lote.map(async ({ tarea, worktree }) => {
      const inicioMs = Date.now();
      const respuesta = await ejecutarConReintento(ejecutar, {
        prompt: reglasDelSubagente(tarea),
        cwd: worktree.ruta,
        model: tarea.modelo || modelo,
        effort: tarea.effort || effort,
        mode: tarea.soloLectura ? 'plan' : 'accept-edits',
        timeout_minutes: timeoutMinutes
      }, { reintentos: reintentosPorCuota, esperaBaseMs, alDormir });

      return {
        id: tarea.id,
        rama: worktree.rama,
        ruta: worktree.ruta,
        archivos: tarea.archivos,
        exito: !!respuesta.success,
        error: respuesta.success ? null : (respuesta.error || 'error desconocido'),
        porCuota: !respuesta.success && esErrorDeCuota(respuesta.error),
        intentos: respuesta.intentos,
        conversation_id: respuesta.conversation_id || (respuesta.data && respuesta.data.conversation_id) || null,
        duracionMs: Date.now() - inicioMs
      };
    }));

    resultados.push(...delLote);
  }

  const fallidas = resultados.filter(r => !r.exito);

  return {
    lanzado: true,
    ramaBase: base.rama,
    ramaBaseCreada: base.creada,
    concurrencia,
    lotes: Math.ceil(asignacion.length / concurrencia),
    resultados,
    resumen: {
      total: resultados.length,
      exitosas: resultados.length - fallidas.length,
      fallidas: fallidas.length,
      fallidasPorCuota: fallidas.filter(r => r.porCuota).length
    },
    // El siguiente paso es de Claude, no de este módulo.
    siguientePaso: 'Auditar los diffs de cada rama, correr los tests y mergear en orden. '
      + 'Los subagentes no testean ni mergean.'
  };
}

module.exports = {
  CONCURRENCIA_POR_DEFECTO,
  REINTENTOS_POR_CUOTA,
  esErrorDeCuota,
  reglasDelSubagente,
  lanzarFanout
};
