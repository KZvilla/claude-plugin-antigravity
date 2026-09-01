import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Sobreescribible para que los tests no operen sobre el estado real del usuario.
const STATE_FILE = process.env.TELEGRAM_BRIDGE_STATE_FILE
  ? path.resolve(process.env.TELEGRAM_BRIDGE_STATE_FILE)
  : path.join(__dirname, 'state.json');

function emptyState() {
  return { chats: {}, pendingAsks: {} };
}

/**
 * Carga el estado persistido desde state.json
 */
export function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return emptyState();
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // `queue` es un campo legado: la cola vive ahora en memoria (queue.js) y se
    // descarta al leer para no rehidratar Contexts muertos ni tokens antiguos.
    return {
      chats: parsed.chats || {},
      pendingAsks: parsed.pendingAsks || {}
    };
  } catch (err) {
    console.error(`[state] Error leyendo state.json: ${err.message}. Reinicializando.`);
    return emptyState();
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
