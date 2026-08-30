import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'state.json');

const DEFAULT_STATE = {
  chats: {},
  pendingAsks: {}
};

/**
 * Carga el estado persistido desde state.json
 */
export function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE, chats: {}, pendingAsks: {} };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      chats: parsed.chats || {},
      pendingAsks: parsed.pendingAsks || {}
    };
  } catch (err) {
    console.error(`[state] Error leyendo state.json: ${err.message}. Reinicializando.`);
    return { ...DEFAULT_STATE, chats: {}, pendingAsks: {} };
  }
}

/**
 * Guarda el estado en state.json de forma segura
 */
export function saveState(state) {
  try {
    const data = JSON.stringify(state, null, 2);
    fs.writeFileSync(STATE_FILE, data, 'utf8');
  } catch (err) {
    console.error(`[state] Error guardando state.json: ${err.message}`);
  }
}

/**
 * Obtiene el último conversation_id asociado a un chat
 */
export function getConversationId(chatId) {
  const state = loadState();
  const chat = state.chats[String(chatId)];
  return chat ? chat.lastConversationId || null : null;
}

/**
 * Actualiza el conversation_id de un chat
 */
export function setConversationId(chatId, conversationId, meta = {}) {
  const state = loadState();
  const idStr = String(chatId);
  state.chats[idStr] = {
    ...(state.chats[idStr] || {}),
    lastConversationId: conversationId,
    updatedAt: new Date().toISOString(),
    ...meta
  };
  saveState(state);
}

/**
 * Limpia el conversation_id de un chat para iniciar sesión nueva
 */
export function clearConversationId(chatId) {
  const state = loadState();
  const idStr = String(chatId);
  if (state.chats[idStr]) {
    delete state.chats[idStr].lastConversationId;
    state.chats[idStr].updatedAt = new Date().toISOString();
    saveState(state);
  }
}

/**
 * Cola de tareas en memoria (NO persistida en state.json).
 *
 * Cada tarea lleva el `ctx` vivo de grammY (con sus métodos .reply,
 * .replyWithChatAction, etc.). Si se serializa a JSON y se vuelve a leer,
 * `ctx` se convierte en un objeto plano sin esos métodos: el bot llamaría
 * a `ctx.reply(...)` sobre `undefined` y la excepción resultante quedaría
 * sin capturar, terminando el proceso (unhandled rejection). Por eso la
 * cola se mantiene solo en memoria del proceso actual.
 */
let taskQueue = [];

/**
 * Agrega una tarea a la cola
 */
export function enqueueTask(task) {
  taskQueue.push({
    ...task,
    enqueuedAt: new Date().toISOString()
  });
  return taskQueue.length;
}

/**
 * Extrae la siguiente tarea de la cola
 */
export function dequeueTask() {
  if (taskQueue.length === 0) return null;
  return taskQueue.shift();
}

/**
 * Retorna la longitud actual de la cola
 */
export function getQueueLength() {
  return taskQueue.length;
}

/**
 * Registra una pregunta pendiente de aprobación (Human-in-the-loop)
 */
export function registerPendingAsk(askId, { question, options, chatId, messageId }) {
  const state = loadState();
  state.pendingAsks = state.pendingAsks || {};
  state.pendingAsks[askId] = {
    askId,
    question,
    options,
    chatId,
    messageId,
    createdAt: new Date().toISOString(),
    status: 'pending', // 'pending' | 'answered' | 'expired'
    answer: null,
    answeredBy: null,
    answeredAt: null
  };
  saveState(state);
}

/**
 * Resuelve una pregunta pendiente cuando el usuario pulsa un botón en Telegram
 */
export function resolvePendingAsk(askId, answer, answeredBy = null) {
  const state = loadState();
  if (state.pendingAsks && state.pendingAsks[askId]) {
    state.pendingAsks[askId].status = 'answered';
    state.pendingAsks[askId].answer = answer;
    state.pendingAsks[askId].answeredBy = answeredBy;
    state.pendingAsks[askId].answeredAt = new Date().toISOString();
    saveState(state);
    return state.pendingAsks[askId];
  }
  return null;
}

/**
 * Obtiene el estado actual de una pregunta pendiente
 */
export function getPendingAsk(askId) {
  const state = loadState();
  return (state.pendingAsks && state.pendingAsks[askId]) || null;
}
