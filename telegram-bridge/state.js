import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Sobreescribible para que los tests no operen sobre el estado real del usuario.
const STATE_FILE = process.env.TELEGRAM_BRIDGE_STATE_FILE
  ? path.resolve(process.env.TELEGRAM_BRIDGE_STATE_FILE)
  : path.join(__dirname, 'state.json');

const LOCK_FILE = `${STATE_FILE}.lock`;

// Un lock abandonado (proceso muerto a mitad de escritura) se considera obsoleto
// pasado este tiempo. Una escritura de estado tarda milisegundos.
const LOCK_STALE_MS = 5000;
// Cuánto se espera por el lock antes de escribir igualmente. Bloquear al bot es
// peor que una carrera improbable sobre un fichero de pocos kilobytes.
const LOCK_WAIT_MS = 2000;
// Los asks resueltos o expirados se purgan pasado este tiempo.
const ASK_RETENTION_HOURS = 24;

function emptyState() {
  return { chats: {}, pendingAsks: {} };
}

// ==============================================================================
// Exclusión mutua entre procesos
// ==============================================================================
//
// `bot.js` y `notify.js` son procesos distintos (el servidor MCP lanza notify.js
// por spawn) y ambos hacen ciclo completo leer-modificar-escribir sobre el mismo
// fichero. Sin exclusión, un registerPendingAsk puede pisar un setConversationId
// concurrente. Todo el ciclo va dentro del lock, no solo la escritura.

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      return fs.openSync(LOCK_FILE, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.error(`[state] No se pudo tomar el lock: ${err.message}. Se escribe sin exclusión.`);
        return null;
      }
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {
        continue; // el lock desapareció entre el stat y ahora: reintentar
      }
      if (Date.now() >= deadline) {
        console.error('[state] Lock ocupado más de lo razonable. Se escribe sin exclusión.');
        return null;
      }
      sleepSync(20);
    }
  }
}

function releaseStateLock(fd) {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

/**
 * Ejecuta un ciclo leer-modificar-escribir completo bajo lock.
 * `mutator` recibe el estado fresco de disco; lo que devuelva se propaga al
 * llamante. Si devuelve `false`, no se escribe nada.
 */
function mutateState(mutator) {
  const fd = acquireStateLock();
  try {
    const state = readStateFromDisk();
    purgeStaleAsks(state);
    const result = mutator(state);
    if (result !== false) {
      writeStateToDisk(state);
    }
    return result;
  } finally {
    releaseStateLock(fd);
  }
}

// ==============================================================================
// Lectura y escritura
// ==============================================================================

// Caché invalidada por mtime + tamaño. El bucle de espera de askTelegramQuestion
// relee el estado una vez por segundo durante hasta 300 s; sin caché eso es un
// parseo completo del fichero en cada vuelta.
let cache = null;

function readStateFromDisk() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
 * Carga el estado persistido desde state.json, con caché invalidada por mtime.
 */
export function loadState() {
  let stat = null;
  try {
    stat = fs.statSync(STATE_FILE);
  } catch {
    cache = null;
    return emptyState();
  }

  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.state;
  }

  const state = readStateFromDisk();
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, state };
  return state;
}

function writeStateToDisk(state) {
  // Escritura atómica: un corte a mitad de un writeFileSync directo deja JSON
  // truncado, y loadState lo reinicializaría a {} perdiendo en silencio todos
  // los conversation_id y asks pendientes. El rename sí es atómico.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    cache = null; // el mtime cambió; que la próxima lectura lo recoja
  } catch (err) {
    console.error(`[state] Error guardando state.json: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Guarda el estado en state.json de forma atómica.
 */
export function saveState(state) {
  const fd = acquireStateLock();
  try {
    writeStateToDisk(state);
  } finally {
    releaseStateLock(fd);
  }
}

// ==============================================================================
// Recolección de asks
// ==============================================================================

/**
 * Elimina los asks resueltos o expirados con más de `retentionHours`.
 * Los `pending` no se tocan: pueden tener un notify.js esperándolos.
 * @returns {number} entradas eliminadas
 */
function purgeStaleAsks(state, retentionHours = ASK_RETENTION_HOURS) {
  const cutoff = Date.now() - retentionHours * 3600 * 1000;
  let removed = 0;

  for (const [askId, ask] of Object.entries(state.pendingAsks || {})) {
    if (ask.status === 'pending') continue;
    const closedAt = Date.parse(ask.answeredAt || ask.expiredAt || ask.createdAt || '');
    if (Number.isNaN(closedAt) || closedAt < cutoff) {
      delete state.pendingAsks[askId];
      removed++;
    }
  }

  return removed;
}

/**
 * Fuerza una purga inmediata de asks cerrados. Expuesta para los tests y para
 * un futuro comando de mantenimiento.
 */
export function purgeAsks(retentionHours = ASK_RETENTION_HOURS) {
  return mutateState((state) => purgeStaleAsks(state, retentionHours));
}

// ==============================================================================
// Conversaciones por chat
// ==============================================================================

/**
 * Obtiene el último conversation_id asociado a un chat
 */
export function getConversationId(chatId) {
  const chat = loadState().chats[String(chatId)];
  return chat ? chat.lastConversationId || null : null;
}

/**
 * Actualiza el conversation_id de un chat
 */
export function setConversationId(chatId, conversationId, meta = {}) {
  mutateState((state) => {
    const idStr = String(chatId);
    state.chats[idStr] = {
      ...(state.chats[idStr] || {}),
      lastConversationId: conversationId,
      updatedAt: new Date().toISOString(),
      ...meta
    };
  });
}

/**
 * Limpia el conversation_id de un chat para iniciar sesión nueva
 */
export function clearConversationId(chatId) {
  mutateState((state) => {
    const idStr = String(chatId);
    if (!state.chats[idStr]) return false;
    delete state.chats[idStr].lastConversationId;
    state.chats[idStr].updatedAt = new Date().toISOString();
  });
}

// ==============================================================================
// Human-in-the-loop
// ==============================================================================

/**
 * Registra una pregunta pendiente de aprobación (Human-in-the-loop)
 */
export function registerPendingAsk(askId, { question, options, chatId, messageId }) {
  mutateState((state) => {
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
  });
}

/**
 * Resuelve una pregunta pendiente cuando el usuario pulsa un botón en Telegram
 */
export function resolvePendingAsk(askId, answer, answeredBy = null) {
  return mutateState((state) => {
    const ask = state.pendingAsks[askId];
    if (!ask) return false;
    ask.status = 'answered';
    ask.answer = answer;
    ask.answeredBy = answeredBy;
    ask.answeredAt = new Date().toISOString();
    return ask;
  }) || null;
}

/**
 * Marca una pregunta como expirada al agotarse su plazo de espera.
 * Sin esto los asks caducados quedan como `pending` para siempre y nunca se
 * recolectan.
 */
export function expirePendingAsk(askId) {
  return mutateState((state) => {
    const ask = state.pendingAsks[askId];
    if (!ask || ask.status !== 'pending') return false;
    ask.status = 'expired';
    ask.expiredAt = new Date().toISOString();
    return ask;
  }) || null;
}

/**
 * Obtiene el estado actual de una pregunta pendiente
 */
export function getPendingAsk(askId) {
  return loadState().pendingAsks[askId] || null;
}
