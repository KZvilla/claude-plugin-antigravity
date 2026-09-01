/**
 * Cola de tareas en memoria (concurrency = 1).
 *
 * Las tareas transportan el `Context` vivo de grammY, que NO es serializable:
 * al pasar por `JSON.stringify`/`JSON.parse` pierde todos sus métodos
 * (`ctx.reply`, `ctx.replyWithChatAction`, …) y además arrastra el
 * `TELEGRAM_BOT_TOKEN` dentro de `ctx.api`. Por eso la cola vive únicamente
 * en el proceso del bot y nunca toca disco.
 *
 * Consecuencia asumida: la cola no sobrevive a un reinicio del bot. Es el
 * comportamiento correcto — un `Context` de una petición ya cerrada no se
 * puede reanimar en otro proceso.
 */

/** @type {Array<object>} */
const queue = [];

/**
 * Agrega una tarea al final de la cola.
 * @returns {number} posición de la tarea en la cola (1-indexada)
 */
export function enqueueTask(task) {
  queue.push({
    ...task,
    enqueuedAt: new Date().toISOString()
  });
  return queue.length;
}

/**
 * Extrae la siguiente tarea de la cola.
 * @returns {object|null} la misma referencia que se encoló, con sus métodos intactos
 */
export function dequeueTask() {
  return queue.length === 0 ? null : queue.shift();
}

/**
 * Retorna la longitud actual de la cola.
 */
export function getQueueLength() {
  return queue.length;
}

/**
 * Vista serializable de la cola, sin handles vivos. Apta para `/status`,
 * logs o cualquier salida que pudiera acabar en disco.
 */
export function getQueueSnapshot() {
  return queue.map(({ chatId, prompt, mode, conversationId, enqueuedAt }) => ({
    chatId,
    mode,
    conversationId: conversationId || null,
    enqueuedAt,
    promptPreview: typeof prompt === 'string' ? prompt.slice(0, 80) : ''
  }));
}

/**
 * Descarta todas las tareas pendientes y devuelve cuántas se descartaron.
 */
export function clearQueue() {
  const discarded = queue.length;
  queue.length = 0;
  return discarded;
}
