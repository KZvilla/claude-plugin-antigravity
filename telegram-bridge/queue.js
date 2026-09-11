/**
 * Colas de tareas en memoria, una por carril (FEAT-026).
 *
 * Las tareas transportan el `Context` vivo de grammY, que NO es serializable:
 * al pasar por `JSON.stringify`/`JSON.parse` pierde todos sus métodos
 * (`ctx.reply`, `ctx.replyWithChatAction`, …) y además arrastra el
 * `TELEGRAM_BOT_TOKEN` dentro de `ctx.api`. Por eso las colas viven únicamente
 * en el proceso del bot y nunca tocan disco.
 *
 * Consecuencia asumida: las colas no sobreviven a un reinicio del bot. Es el
 * comportamiento correcto — un `Context` de una petición ya cerrada no se
 * puede reanimar en otro proceso.
 *
 * Dos carriles, cada uno con su propia FIFO:
 *   - `principal`: plan, run, resume, exec_plan y texto suelto. Comparten la
 *     conversación del chat, así que no pueden correr en paralelo entre sí.
 *   - `cast`: agentes persistidos. No tocan la sesión del chat, y un cast de
 *     30 s no tiene por qué esperar detrás de un /run de 8 minutos.
 * Arreglos separados, no uno filtrado: con `[run, cast]` y el carril principal
 * ocupado, un `shift()` sobre una sola cola dejaba el cast bloqueado detrás del
 * run (head-of-line blocking).
 *
 * La API sin carril conserva su significado de siempre —el total, todo— para
 * los llamadores que no distinguen.
 */

export const CARRILES = Object.freeze(['principal', 'cast']);

const colas = { principal: [], cast: [] };

/** Carril al que va una tarea: solo un cast va al carril de casts. */
export function carrilDe(task) {
  return task && task.kind === 'cast' ? 'cast' : 'principal';
}

function colaDe(carril) {
  const cola = colas[carril];
  if (!cola) throw new Error(`Carril desconocido: ${carril}`);
  return cola;
}

/**
 * Agrega una tarea al final de la cola de su carril.
 *
 * Guarda la MISMA referencia que recibe (solo le añade `enqueuedAt` y
 * `carril`), no una copia: el llamante necesita seguir mutándola después de
 * encolar — por ejemplo para anotar el `statusMessageId` en cuanto Telegram
 * devuelve el id del mensaje de progreso.
 *
 * @returns {number} posición de la tarea en la cola de su carril (1-indexada)
 */
export function enqueueTask(task) {
  task.enqueuedAt = new Date().toISOString();
  task.carril = carrilDe(task);
  const cola = colas[task.carril];
  cola.push(task);
  return cola.length;
}

/**
 * Extrae la siguiente tarea de un carril. Nunca mira el otro.
 * @returns {object|null} la misma referencia que se encoló, con sus métodos intactos
 */
export function dequeueTask(carril = 'principal') {
  const cola = colaDe(carril);
  return cola.length === 0 ? null : cola.shift();
}

/**
 * Tareas esperando: sin carril, la suma de los dos.
 */
export function getQueueLength(carril) {
  if (carril === undefined) return CARRILES.reduce((n, c) => n + colas[c].length, 0);
  return colaDe(carril).length;
}

/**
 * Vista serializable, sin handles vivos. Apta para `/status`, `/queue`, logs o
 * cualquier salida que pudiera acabar en disco. Sin carril, los dos en orden:
 * primero el principal, después los casts.
 */
export function getQueueSnapshot(carril) {
  const pedidos = carril === undefined ? CARRILES : [carril];
  return pedidos.flatMap((c) => colaDe(c).map(({ chatId, prompt, mode, conversationId, enqueuedAt, kind, agent }) => ({
    carril: c,
    chatId,
    mode,
    kind: kind || null,
    agent: agent || null,
    conversationId: conversationId || null,
    enqueuedAt,
    promptPreview: typeof prompt === 'string' ? prompt.slice(0, 80) : ''
  })));
}

/**
 * Descarta lo pendiente (sin carril, en los dos) y devuelve cuántas tareas se
 * descartaron.
 */
export function clearQueue(carril) {
  const pedidos = carril === undefined ? CARRILES : [carril];
  let descartadas = 0;
  for (const c of pedidos) {
    const cola = colaDe(c);
    descartadas += cola.length;
    cola.length = 0;
  }
  return descartadas;
}
