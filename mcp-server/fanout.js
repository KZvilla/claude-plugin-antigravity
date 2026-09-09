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
 *
 * `taskId` viaja dentro de la petición que recibe `ejecutar` (además de en las
 * opciones de `ejecutarConReintento`) para que el ejecutor real pueda
 * atender un pedido de detención por tarea (FEAT-012) — ver
 * mcp-server/fanout-estado.js. Un resultado con `stopped: true` no cuenta
 * como error de cuota (esErrorDeCuota no lo reconoce) y no se reintenta.
 *
 * `deps.limpiarControlPrevio` (FEAT-012) se llama UNA VEZ por tarea, antes
 * del primer lote — nunca dentro de `ejecutar` — para no arriesgarse a
 * borrar un pedido de detención legítimo escrito mientras una tarea espera
 * turno en un lote siguiente o durante el backoff de un reintento por
 * cuota. Una auditoría adversarial (agy_audit, 2026-09-09) encontró esa
 * carrera en la primera versión, que limpiaba por intento dentro de
 * `ejecutar`.
 */
const { validarReparto, explicarReparto } = require('./reparto.js');
const { prepararRamaBase, crearWorktrees } = require('./worktrees.js');

// No-op por defecto: si el llamador no inyecta deps.registrarEstado (como
// hacen hoy todos los tests existentes), el orquestador se comporta
// exactamente igual que antes de FEAT-005 V1.
const ESTADO_NULO = { iniciar() {}, marcar() {}, terminar() {} };

const CONCURRENCIA_POR_DEFECTO = 3;
// Tope de lo que se persiste de un mensaje de error en el archivo de estado:
// alcanza para entender qué pasó sin engordar un JSON que se reescribe entero
// en cada `marcar`.
const MAX_LARGO_ERROR = 200;
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
async function ejecutarConReintento(ejecutar, peticion, { reintentos, esperaBaseMs, alDormir, taskId, registrarEstado }) {
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
    registrarEstado.marcar(taskId, { estado: 'reintentando', intentos: realizados });
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
  const registrarEstado = (deps && deps.registrarEstado) || ESTADO_NULO;
  // No-op por defecto, igual que registrarEstado: si no se inyecta, el
  // comportamiento es el de antes de FEAT-012.
  const limpiarControlPrevio = (deps && deps.limpiarControlPrevio) || (() => {});
  // Ídem para FEAT-009: sin inyectar, el log NDJSON simplemente no se limpia
  // (porque tampoco se escribe si el caller no lo activó).
  const limpiarProgresoPrevio = (deps && deps.limpiarProgresoPrevio) || (() => {});

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

  // Metadatos por tarea para quien mire la corrida (FEAT-015). Acá está todo
  // junto y sin plomería: `asignacion` ya tiene la tarea y su worktree.
  // `ruta` del worktree se omite a propósito: es una ruta absoluta larga que
  // en una tarjeta angosta es puro ruido, y nadie navega al worktree mientras
  // mira correr el fan-out.
  //
  // `modelo` puede quedar sin valor: acá se conoce `tarea.modelo || modelo`,
  // pero el último fallback (`config.defaultModel`) recién se aplica en
  // index.js. Se persiste lo que se sabe y quien lo muestre decide cómo
  // representar "el que venga por defecto" — mentir con un nombre concreto
  // sería peor que no decir nada.
  registrarEstado.iniciar({
    ramaBase: base.rama,
    concurrencia,
    meta: Object.fromEntries(asignacion.map(({ tarea, worktree }) => [tarea.id, {
      archivos: tarea.archivos,
      rama: worktree.rama,
      modelo: tarea.modelo || modelo || null
    }]))
  });

  // Barrido de centinelas viejos de una corrida ANTERIOR con el mismo
  // slug/taskId (FEAT-012) — una sola vez acá, antes de que arranque el
  // primer lote. A propósito NO se limpia dentro de `ejecutar` (por
  // intento): eso borraría un pedido de detención legítimo escrito mientras
  // una tarea espera su turno en un lote siguiente, o durante el backoff de
  // un reintento por cuota — justo los dos casos que la feature existe para
  // cubrir. Después de este punto, cualquier centinela que aparezca es de
  // esta corrida y nadie más lo toca hasta que `stopCheck` lo consuma.
  //
  // Mismo barrido, mismo motivo, para el log NDJSON de FEAT-009: si quedara
  // el de una corrida anterior con el mismo slug/taskId, un `tail`/lector
  // externo vería eventos viejos mezclados con los de esta corrida.
  for (const { tarea } of asignacion) {
    limpiarControlPrevio(tarea.id);
    limpiarProgresoPrevio(tarea.id);
  }

  // 4. Ejecución en lotes. El tope existe por cuota, no por CPU: lanzar las N de
  //    golpe es la forma más rápida de comerse un 429 y perder el lote entero.
  const resultados = [];
  for (let inicio = 0; inicio < asignacion.length; inicio += concurrencia) {
    const lote = asignacion.slice(inicio, inicio + concurrencia);

    const delLote = await Promise.all(lote.map(async ({ tarea, worktree }) => {
      const inicioMs = Date.now();
      registrarEstado.marcar(tarea.id, { estado: 'corriendo', intentos: 0, inicio: new Date(inicioMs).toISOString() });

      const respuesta = await ejecutarConReintento(ejecutar, {
        prompt: reglasDelSubagente(tarea),
        cwd: worktree.ruta,
        model: tarea.modelo || modelo,
        effort: tarea.effort || effort,
        mode: tarea.soloLectura ? 'plan' : 'accept-edits',
        timeout_minutes: timeoutMinutes,
        taskId: tarea.id
      }, { reintentos: reintentosPorCuota, esperaBaseMs, alDormir, taskId: tarea.id, registrarEstado });

      const exito = !!respuesta.success;
      const porCuota = !exito && esErrorDeCuota(respuesta.error);
      // Un stop pedido a mano (FEAT-012) no es error de cuota ni de código: se
      // distingue aparte para que auditar la corrida no lo confunda con un bug.
      const detenido = !exito && respuesta.stopped === true;
      registrarEstado.marcar(tarea.id, {
        estado: exito ? 'ok' : 'error',
        intentos: respuesta.intentos,
        porCuota,
        detenido,
        // Sin esto, un timeout del watchdog, un fallo de spawn o un exit != 0
        // se persistían como `{estado:'error', porCuota:false, detenido:false}`
        // — o sea, sin una sola pista de qué pasó. El texto estaba acá al lado
        // (se devuelve en el resultado) pero nunca llegaba al archivo de
        // estado, así que ningún visor podía explicar el fallo (FEAT-015).
        error: exito ? null : String(respuesta.error || 'error desconocido').slice(0, MAX_LARGO_ERROR),
        // El motivo que escribió quien pidió la detención (FEAT-012).
        motivo: detenido && respuesta.motivo ? String(respuesta.motivo).slice(0, MAX_LARGO_ERROR) : null,
        fin: new Date().toISOString()
      });

      return {
        id: tarea.id,
        rama: worktree.rama,
        ruta: worktree.ruta,
        archivos: tarea.archivos,
        exito,
        error: exito ? null : (respuesta.error || 'error desconocido'),
        porCuota,
        detenido,
        intentos: respuesta.intentos,
        conversation_id: respuesta.conversation_id || (respuesta.data && respuesta.data.conversation_id) || null,
        duracionMs: Date.now() - inicioMs
      };
    }));

    resultados.push(...delLote);
  }

  const fallidas = resultados.filter(r => !r.exito);

  registrarEstado.terminar();

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
      fallidasPorCuota: fallidas.filter(r => r.porCuota).length,
      fallidasDetenidas: fallidas.filter(r => r.detenido).length
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
