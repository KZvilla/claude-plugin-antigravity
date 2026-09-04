import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataFile } from './paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// El estado vive en un directorio de usuario, NO junto al código. `bot.js` y
// `notify.js` pueden ejecutarse desde copias distintas del bridge —el checkout
// de desarrollo y el plugin instalado— y con la ruta relativa a `__dirname`
// cada una escribía su propio `state.json`: el ask que registra notify.js no lo
// veía el bot que resuelve el botón. Ver paths.js.
//
// `TELEGRAM_BRIDGE_STATE_FILE` sigue siendo el override más específico, y es lo
// que usan los tests para no tocar el estado real del usuario.
// Perezoso, no en el cuerpo del módulo: `resolveDataFile` crea directorios y
// migra el fichero heredado, y eso no debe ocurrir por el mero hecho de
// importar `state.js`. Importar no es usar.
let _stateFile = null;

/**
 * Ruta efectiva del estado. La usan el arranque del bot para informarla y los
 * tests para comprobar dónde se está escribiendo.
 */
export function getStateFilePath() {
  if (_stateFile) return _stateFile;
  _stateFile = process.env.TELEGRAM_BRIDGE_STATE_FILE
    ? path.resolve(process.env.TELEGRAM_BRIDGE_STATE_FILE)
    : resolveDataFile('state.json', __dirname);
  return _stateFile;
}

function getLockFilePath() {
  return `${getStateFilePath()}.lock`;
}

// Un lock abandonado (proceso muerto a mitad de escritura) se considera obsoleto
// pasado este tiempo. Una escritura de estado tarda milisegundos.
const LOCK_STALE_MS = 5000;
// Cuánto se espera por el lock antes de escribir igualmente. Bloquear al bot es
// peor que una carrera improbable sobre un fichero de pocos kilobytes.
const LOCK_WAIT_MS = 2000;
// Los asks resueltos o expirados se purgan pasado este tiempo.
const ASK_RETENTION_HOURS = 24;
// Plazo de gracia que se añade al vencimiento declarado de un ask antes de
// darlo por huérfano. Cubre el desfase entre el reloj del proceso que espera y
// el del que purga, y el último tramo del bucle de sondeo de notify.js.
const ASK_GRACE_MS = 60 * 1000;
// Vencimiento de respaldo para asks registrados por una versión anterior, que
// no llevan `expiresAt`. Muy por encima de cualquier `timeoutSeconds` razonable
// para no cortar una espera viva.
const LEGACY_ASK_MAX_AGE_MS = 24 * 3600 * 1000;

function emptyState() {
  return { chats: {}, pendingAsks: {}, claudeSession: null };
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
      return fs.openSync(getLockFilePath(), 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.error(`[state] No se pudo tomar el lock: ${err.message}. Se escribe sin exclusión.`);
        return null;
      }
      try {
        if (Date.now() - fs.statSync(getLockFilePath()).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(getLockFilePath());
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
  try { fs.unlinkSync(getLockFilePath()); } catch {}
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

// Caché del *parseo*, no de la lectura. El bucle de espera de
// askTelegramQuestion relee el estado una vez por segundo durante hasta 300 s;
// sin caché eso es un JSON.parse completo en cada vuelta.
//
// La clave es el contenido crudo, no `mtime` + tamaño: Windows sella los
// tiempos de escritura con una granularidad muy por encima del milisegundo, así
// que dos escrituras seguidas del mismo tamaño (dos IDs de conversación de
// igual longitud, por ejemplo) compartían mtime y la caché seguía sirviendo
// estado obsoleto. Leer unos pocos KB es barato; parsearlos no tanto.
let cache = null;

function parseState(raw) {
  try {
    const parsed = JSON.parse(raw);
    // `queue` es un campo legado: la cola vive ahora en memoria (queue.js) y se
    // descarta al leer para no rehidratar Contexts muertos ni tokens antiguos.
    return {
      chats: parsed.chats || {},
      pendingAsks: parsed.pendingAsks || {},
      claudeSession: parsed.claudeSession || null
    };
  } catch (err) {
    console.error(`[state] Error leyendo state.json: ${err.message}. Reinicializando.`);
    return emptyState();
  }
}

/**
 * Lectura sin caché, para el ciclo leer-modificar-escribir bajo lock: ahí
 * servir un parseo anterior podría pisar lo que otro proceso acabe de escribir.
 */
function readStateFromDisk() {
  try {
    return parseState(fs.readFileSync(getStateFilePath(), 'utf8'));
  } catch {
    return emptyState();
  }
}

/**
 * Carga el estado persistido desde state.json, cacheando el parseo.
 */
export function loadState() {
  let raw = null;
  try {
    raw = fs.readFileSync(getStateFilePath(), 'utf8');
  } catch {
    cache = null;
    return emptyState();
  }

  if (cache && cache.raw === raw) return cache.state;

  const state = parseState(raw);
  cache = { raw, state };
  return state;
}

function writeStateToDisk(state) {
  // Escritura atómica: un corte a mitad de un writeFileSync directo deja JSON
  // truncado, y loadState lo reinicializaría a {} perdiendo en silencio todos
  // los conversation_id y asks pendientes. El rename sí es atómico.
  const tmp = `${getStateFilePath()}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, getStateFilePath());
    cache = null; // el contenido cambió; que la próxima lectura lo recoja
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
 * ¿Ha vencido ya el plazo de espera de un ask pendiente?
 *
 * La condición NO es una antigüedad fija. Un ask lleva su propio vencimiento
 * (`expiresAt = createdAt + timeoutSeconds`) porque `timeoutSeconds` lo elige
 * el llamante de `askTelegramQuestion`: con un umbral constante de, digamos,
 * dos horas, un ask con timeout mayor se marcaría `expired` mientras su
 * `notify.js` sigue vivo esperándolo. A partir de ahí el botón de Telegram
 * responde «esta consulta expiró» y no resuelve nada, y el proceso que espera
 * se queda colgado hasta su propio timeout. El vencimiento declarado es el
 * único dato que distingue un ask huérfano de uno con dueño.
 *
 * @returns {boolean|null} `null` si no hay forma de fecharlo (registro corrupto)
 */
function pendingAskVencido(ask, now = Date.now()) {
  const expiresAt = Date.parse(ask.expiresAt || '');
  if (!Number.isNaN(expiresAt)) return now > expiresAt + ASK_GRACE_MS;

  // Registro de una versión anterior: se cae al respaldo por antigüedad.
  const createdAt = Date.parse(ask.createdAt || '');
  if (!Number.isNaN(createdAt)) return now - createdAt > LEGACY_ASK_MAX_AGE_MS;

  return null;
}

/**
 * Recolector de asks. Hace dos cosas:
 *
 *  1. Marca `expired` los `pending` cuyo plazo ya venció. Sin esto, un cliente
 *     (`notify.js`) cerrado a la fuerza antes de su timeout deja el ask en
 *     `pending` para siempre: el purgador lo saltaba por diseño y la entrada
 *     no salía nunca de `state.json`.
 *  2. Elimina los cerrados —`answered` o `expired`— con más de `retentionHours`.
 *
 * Un `pending` sin ninguna marca de tiempo utilizable no se puede fechar ni
 * atribuir a un esperador concreto, así que se elimina: dejarlo era justo la
 * fuga que se quiere cerrar.
 *
 * @returns {number} entradas eliminadas
 */
function purgeStaleAsks(state, retentionHours = ASK_RETENTION_HOURS) {
  const now = Date.now();
  const cutoff = now - retentionHours * 3600 * 1000;
  let removed = 0;

  for (const [askId, ask] of Object.entries(state.pendingAsks || {})) {
    if (ask.status === 'pending') {
      const vencido = pendingAskVencido(ask, now);
      if (vencido === null) {
        delete state.pendingAsks[askId];
        removed++;
        continue;
      }
      if (!vencido) continue;
      ask.status = 'expired';
      ask.expiredAt = new Date(now).toISOString();
      ask.expiredBy = 'gc';
      // Recién marcado: entra en el periodo de retención, no se borra ahora.
      continue;
    }

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
export function registerPendingAsk(askId, { question, options, chatId, messageId, timeoutSeconds = 300 }) {
  const createdAt = Date.now();
  mutateState((state) => {
    state.pendingAsks[askId] = {
      askId,
      question,
      options,
      chatId,
      messageId,
      createdAt: new Date(createdAt).toISOString(),
      // Vencimiento explícito: es lo que permite al recolector distinguir un
      // ask huérfano de uno que todavía tiene un proceso esperándolo.
      expiresAt: new Date(createdAt + timeoutSeconds * 1000).toISOString(),
      timeoutSeconds,
      status: 'pending', // 'pending' | 'answered' | 'expired'
      answer: null,
      answeredBy: null,
      answeredAt: null
    };
  });
}

/**
 * Resuelve una pregunta pendiente cuando el usuario pulsa un botón en Telegram.
 *
 * La comprobación de `status` va DENTRO del ciclo leer-modificar-escribir bajo
 * lock, no en el llamante. Comprobarla fuera es un TOCTOU: dos pulsaciones
 * seguidas del mismo botón —o dos clientes— pasaban ambas el filtro y
 * resolvían dos veces, sobrescribiendo la primera respuesta y notificando dos
 * veces al usuario.
 *
 * @returns {object|null} el ask resuelto, o `null` si no existía o ya no
 *          estaba `pending` (respuesta previa, expiración o recolección)
 */
export function resolvePendingAsk(askId, answer, answeredBy = null) {
  return mutateState((state) => {
    const ask = state.pendingAsks[askId];
    if (!ask || ask.status !== 'pending') return false;
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

// ==============================================================================
// Sesión Remota de Claude Code (Phase 3)
// ==============================================================================

/**
 * Obtiene la sesión remota activa de Claude Code si su proceso sigue vivo.
 * Si el proceso registrado ya terminó, limpia el estado de forma atómica y retorna null.
 *
 * @param {Object} [options]
 * @param {(pid: number) => boolean} [options.isAliveFn] Función de verificación para tests
 * @returns {{ pid: number, projectPath: string, sessionName: string, startedAt: string }|null}
 */
export function getActiveClaudeSession({ isAliveFn = null } = {}) {
  const session = loadState().claudeSession;
  if (!session || !session.pid) return null;

  let alive = false;
  if (typeof isAliveFn === 'function') {
    try {
      alive = Boolean(isAliveFn(session.pid));
    } catch {
      alive = false;
    }
  } else {
    try {
      process.kill(session.pid, 0);
      alive = true;
    } catch (err) {
      alive = err.code === 'EPERM';
    }
  }

  if (!alive) {
    clearActiveClaudeSession();
    return null;
  }

  return {
    pid: session.pid,
    projectPath: session.projectPath,
    sessionName: session.sessionName,
    startedAt: session.startedAt
  };
}

/**
 * Registra una sesión remota activa de Claude Code en state.json de forma atómica.
 *
 * @param {Object} params
 * @param {number} params.pid
 * @param {string} params.projectPath
 * @param {string} params.sessionName
 * @returns {{ pid: number, projectPath: string, sessionName: string, startedAt: string }}
 */
export function setActiveClaudeSession({ pid, projectPath, sessionName }) {
  const session = {
    pid,
    projectPath,
    sessionName,
    startedAt: new Date().toISOString()
  };

  mutateState((state) => {
    state.claudeSession = session;
  });

  return session;
}

/**
 * Elimina la sesión remota activa de Claude Code de state.json de forma atómica.
 */
export function clearActiveClaudeSession() {
  mutateState((state) => {
    delete state.claudeSession;
  });
}

