import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { runAgyTask, runAgyArgs, AGY_BIN, getAgyStatus, resolveWorkspace, resolveExtraDirs } from './executor.js';
import { replyWithSmartChunks, formatExecutionMeta, sendSafeChunk, formatElapsed, finalProgressLabel } from './formatter.js';
import { redactSecrets } from './policy.js';
import { startLogRotation } from './logrotate.js';
import {
  resolverRutaEnWorkspace,
  resumenDeCambios,
  diffDeArchivo,
  parsearLineasLogs,
  logsDelDaemon,
  componerRespuesta
} from './lectura.js';
import { resolveDataFile, legacyDataFile, loadBridgeEnv, describeEnvSearch, bridgeDataDirPath } from './paths.js';
import {
  getConversationId,
  setConversationId,
  clearConversationId,
  resolvePendingAsk,
  getPendingAsk,
  getStateFilePath
} from './state.js';
import { enqueueTask, dequeueTask, getQueueLength, getQueueSnapshot, clearQueue, CARRILES } from './queue.js';
import {
  getKnownWorkspaces,
  launchClaudeRemoteSession,
  stopClaudeRemoteSession,
  getActiveClaudeSession,
  isPidAlive,
  inspectClaudeWorktrees,
  pruneCleanClaudeWorktrees
} from './claude-launcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// FEAT-022 — `/cast` usa la MISMA orquestación que la tool MCP `cast_agent`,
// incluido el guardarrail contra el fail-open de `agy --agent`. El daemon corre
// siempre desde un clon del repo (ver Assert-DirectorioEstable en daemon.ps1),
// así que `mcp-server/` está al lado. Son módulos CommonJS sin efectos al
// cargarse.
const requireCjs = createRequire(import.meta.url);
const castAgentes = requireCjs('../mcp-server/agents/cast.js');
const registroAgentes = requireCjs('../mcp-server/agents/registry.js');

// ==============================================================================
// 1. Carga de Variables de Entorno (.env)
// ==============================================================================
//
// Nota de estructura: este módulo se divide en definiciones (arriba) y arranque
// (`main()`, abajo). Nada con efectos —tomar el lock, validar el token, abrir el
// long polling, terminar el proceso— ocurre al importarlo. Es lo que permite
// que `test-bridge.js` construya el bot con `createBot()` y le inyecte updates
// sintéticas: mientras `bot.js` hacía todo eso en el cuerpo del módulo, ningún
// handler suyo podía probarse, y los criterios de verificación que hablan de
// «simular un update» eran inaplicables.

// Incluye una ubicación duradera fuera del directorio versionado del plugin:
// `claude plugin update` instala cada versión en su propia carpeta y no
// arrastra el .env, así que uno colocado junto al código se pierde en cada
// actualización. Ver bridgeEnvCandidates() en paths.js.
const envSearch = loadBridgeEnv(__dirname);

/**
 * Whitelist de IDs autorizados. Se resuelve por llamada, no en el cuerpo del
 * módulo, para que un test pueda fijar `ALLOWED_USER_IDS` y construir bots con
 * distintas whitelists sin recargar el módulo.
 */
export function parseAllowedUserIds(raw = process.env.ALLOWED_USER_IDS || '') {
  return new Set(String(raw).split(',').map((id) => id.trim()).filter(Boolean));
}

// ==============================================================================
// 2. Lockfile de Instancia Única (Previene 409 Conflict en Telegram getUpdates)
// ==============================================================================
//
// El lock vive junto al estado, en el directorio de datos del usuario, no junto
// al código. Su cometido es «un solo `getUpdates` por token en esta máquina», y
// con la ruta relativa a `__dirname` dos copias del bridge —el checkout y el
// plugin instalado— tenían cada una su candado: ambas se creían la única
// instancia y Telegram devolvía 409 Conflict a las dos. Ver paths.js.
//
// Se resuelve de forma PEREZOSA, no en el cuerpo del módulo: `resolveDataFile`
// crea directorios y migra el fichero heredado, y eso no puede pasar por el
// mero hecho de importar `bot.js`. Cuando se resolvía al cargar, ejecutar la
// suite de tests movía el lockfile del bot que estuviera corriendo de verdad.
let LOCK_FILE = null;
let LEGACY_LOCK_FILE = null;

function ensureLockPaths() {
  if (LOCK_FILE) return;
  LOCK_FILE = resolveDataFile('bridge.lock', __dirname);
  // Durante un despliegue puede seguir vivo un bot de la versión anterior
  // sujetando el lock en la ruta antigua. Ignorarlo sería exactamente el fallo
  // que el lock existe para evitar, así que se comprueban las dos.
  LEGACY_LOCK_FILE = legacyDataFile('bridge.lock', __dirname);
}

/**
 * Lee un lockfile en el formato actual (JSON con metadatos) o en el legado
 * (solo el PID en texto). Devuelve null si no hay lock legible.
 */
function readLockFrom(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      return Number.isInteger(parsed.pid) ? parsed : null;
    }
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) ? { pid, startedAt: null, bootId: null } : null;
  } catch {
    return null;
  }
}

function readLock() {
  ensureLockPaths();
  return readLockFrom(LOCK_FILE);
}

/**
 * Identificador del arranque del sistema, en resolución de minuto. Si no
 * coincide con el del lock, el PID pertenece a otra sesión del SO y no dice
 * nada: `process.kill(pid, 0)` sobre un PID reciclado da un falso positivo y
 * el bot se negaría a arrancar con un mensaje engañoso.
 */
function currentBootId() {
  return String(Math.floor((Date.now() - os.uptime() * 1000) / 60000));
}

function acquireLock() {
  ensureLockPaths();
  const candidatos = [{ file: LOCK_FILE, lock: readLockFrom(LOCK_FILE) }];
  if (LEGACY_LOCK_FILE !== LOCK_FILE) {
    candidatos.push({ file: LEGACY_LOCK_FILE, lock: readLockFrom(LEGACY_LOCK_FILE) });
  }

  for (const { file, lock } of candidatos) {
    if (!lock) continue;

    const sameBoot = lock.bootId !== null && lock.bootId === currentBootId();
    let alive = false;
    try {
      process.kill(lock.pid, 0); // Señal 0 comprueba existencia sin matar
      alive = true;
    } catch {}

    if (alive && sameBoot) {
      console.error(`[LOCK ERROR] Ya existe otra instancia del bot en ejecución (PID: ${lock.pid}, desde ${lock.startedAt || 'desconocido'}).`);
      console.error(`[LOCK ERROR] Lock encontrado en ${file}.`);
      console.error('Telegram rechaza múltiples peticiones getUpdates concurrentes (HTTP 409 Conflict).');
      process.exit(1);
    }

    if (alive) {
      console.log(`[lock] El PID ${lock.pid} existe pero es de otra sesión del sistema (PID reciclado). Adquiriendo nuevo lock.`);
    } else {
      console.log(`[lock] Se encontró un lockfile huérfano del PID ${lock.pid} en ${file}. Adquiriendo nuevo lock.`);
    }

    // El lock antiguo ya no aporta nada y confundiría a la próxima lectura.
    if (file !== LOCK_FILE) {
      try { fs.unlinkSync(file); } catch {}
    }
  }

  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    bootId: currentBootId(),
    exe: process.execPath
  }), 'utf8');
}

function releaseLock() {
  // Nunca resuelve rutas por su cuenta: si el lock jamas se tomo -por ejemplo
  // en un proceso que solo importo el modulo- no hay nada que soltar.
  if (!LOCK_FILE) return;
  try {
    const lock = readLock();
    if (lock && lock.pid === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ==============================================================================
// 3. Estado de ejecución: un carril por clase de tarea (FEAT-026)
// ==============================================================================

// Cada carril tiene su tarea en curso y su forma de abortarla (`cancelar` lo
// entrega el executor al lanzar el proceso hijo). Uno a la vez POR CARRIL:
//   - `principal` (plan, run, resume, exec_plan, texto suelto) comparte la
//     conversación del chat: dos a la vez lanzarían dos `agy --conversation`
//     sobre el mismo hilo, y los dos harían `setConversationId` al terminar.
//   - `cast` no toca la sesión del chat, así que corre al lado de un /run; pero
//     dos casts al mismo agente compartirían su hilo, así que tampoco hay dos.
const carriles = {
  principal: { enCurso: null, cancelar: null },
  cast: { enCurso: null, cancelar: null }
};

// Punto de inyección para los tests: la ejecución real lanza `agy`. Sin esto
// la rama de ejecución no tenía un solo test de su camino feliz.
const ejecutoresPorDefecto = Object.freeze({ runAgyTask, castear: castAgentes.castear });
let ejecutores = ejecutoresPorDefecto;

/** Solo para los tests. `resetRuntimeState()` siempre vuelve a los reales. */
export function usarEjecutoresDePrueba(parciales = {}) {
  ejecutores = { ...ejecutoresPorDefecto, ...parciales };
}

/** Solo para los tests: ¿se volvió a los ejecutores reales? */
export function ejecutoresSonLosReales() {
  return ejecutores === ejecutoresPorDefecto;
}

/** Solo lectura, para los tests: ¿el carril tiene una tarea en curso? */
export function carrilOcupado(carril) {
  return carriles[carril].enCurso !== null;
}
// Bot activo del proceso. Lo necesitan `notifyChat` y el consumidor de la cola,
// que operan fuera de cualquier `Context` vivo.
let botRef = null;

// FEAT-022 — Casts esperando que el usuario elija workspace. `callback_data`
// tiene 64 bytes, así que el botón lleva un id corto y el pedido queda acá.
// En memoria a propósito, como la cola: un reinicio los pierde y el usuario
// vuelve a mandar el /cast.
const CAST_PENDIENTE_TTL_MS = 10 * 60 * 1000;
const castsPendientes = new Map();

export function guardarCastPendiente({ chatId, agent, prompt }, ahora = Date.now()) {
  for (const [id, p] of castsPendientes) {
    if (ahora - p.creado > CAST_PENDIENTE_TTL_MS) castsPendientes.delete(id);
  }
  const id = crypto.randomBytes(4).toString('hex');
  castsPendientes.set(id, { chatId: String(chatId), agent, prompt, creado: ahora });
  return id;
}

/** Consume un cast pendiente: un solo uso, del mismo chat y sin vencer. */
export function tomarCastPendiente(id, chatId, ahora = Date.now()) {
  const pendiente = castsPendientes.get(id);
  if (!pendiente || pendiente.chatId !== String(chatId)) return null;
  castsPendientes.delete(id);
  return ahora - pendiente.creado > CAST_PENDIENTE_TTL_MS ? null : pendiente;
}

/**
 * Reinicia el estado de ejecución. Solo para los tests: cada caso necesita
 * partir de colas vacías, sin tarea en curso y con los ejecutores reales, así
 * que un test que falla a mitad no contamina a los siguientes.
 */
export function resetRuntimeState() {
  for (const estado of Object.values(carriles)) {
    estado.enCurso = null;
    estado.cancelar = null;
  }
  ejecutores = ejecutoresPorDefecto;
  clearQueue();
  castsPendientes.clear();
}

/**
 * Envía un mensaje por `bot.api` sin depender de un `Context` vivo y sin lanzar
 * nunca. Es la vía de reporte de errores: si el fallo original fue justamente el
 * `ctx`, usar `ctx.reply` para avisar lo enmascara y tumba el proceso.
 */
async function notifyChat(chatId, text, extra = {}) {
  if (!botRef) return null;
  try {
    return await botRef.api.sendMessage(chatId, text, extra);
  } catch (err) {
    if (extra.parse_mode) {
      // Reintento en texto plano: el fallo puede venir del parser de Markdown.
      try {
        return await botRef.api.sendMessage(chatId, text, { ...extra, parse_mode: undefined });
      } catch (plainErr) {
        console.error(`[NOTIFY ERROR] chat ${chatId}: ${redactSecrets(plainErr.message)}`);
        return null;
      }
    }
    console.error(`[NOTIFY ERROR] chat ${chatId}: ${redactSecrets(err.message)}`);
    return null;
  }
}

/**
 * Arranca el consumidor de un carril (sin argumento, de los dos) sin devolver
 * una promesa pendiente al llamante. Todo fallo queda contenido aquí.
 */
function runQueue(carril) {
  for (const c of carril ? [carril] : CARRILES) {
    processTaskQueue(c).catch((err) => {
      console.error(`[QUEUE ERROR] carril ${c}:`, redactSecrets(err?.stack || err?.message || String(err)));
    });
  }
}

/**
 * Procesa la cola de un carril, una tarea a la vez. Los dos carriles corren en
 * paralelo; todo lo de abajo es local a la tarea salvo `carriles[carril]`.
 */
async function processTaskQueue(carril) {
  const estado = carriles[carril];
  if (estado.enCurso) return;
  const task = dequeueTask(carril);
  if (!task) return;

  estado.enCurso = task;
  const { ctx, chatId, prompt, mode, conversationId } = task;

  // Intervalo de acción typing mientras piensa Antigravity
  const startedAt = Date.now();
  let typingInterval = null;
  let progressInterval = null;

  // Un único mensaje de estado que se va editando. Para una tarea de 2 a 15
  // minutos, `typing` cada 4,5 s no dice si algo avanza o si se colgó.
  // Recibe el texto ya armado: en vivo lo compone `lineaDeProgreso` (con la
  // herramienta activa, FEAT-034); al cierre, la etiqueta final, nunca con
  // actividad.
  const segundos = () => (Date.now() - startedAt) / 1000;
  let actividad = null;
  const updateProgress = async (texto) => {
    if (!task.statusMessageId) return;
    try {
      await botRef.api.editMessageText(chatId, task.statusMessageId, texto);
    } catch {
      // «message is not modified» y el mensaje borrado por el usuario son
      // esperables; ninguno merece ruido.
    }
  };

  try {
    await botRef.api.sendChatAction(chatId, 'typing').catch(() => {});
    typingInterval = setInterval(() => {
      botRef.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4500);

    const etiqueta = task.kind === 'cast'
      ? `🎭 ${task.agent} trabajando`
      : (mode === 'plan' ? '🧠 Generando plan' : '⚙️ Ejecutando tarea');
    await updateProgress(lineaDeProgreso(etiqueta, segundos()));
    progressInterval = setInterval(() => { updateProgress(lineaDeProgreso(etiqueta, segundos(), actividad)); }, 15000);

    // FEAT-022 — Rama propia, separada a propósito del cierre de abajo: ese
    // cierre guarda el hilo como sesión del chat y ofrece `exec_plan`, y
    // cualquiera de los dos retomaría el hilo del agente SIN `--agent`, o sea
    // con el agente por defecto y escritura completa.
    if (task.kind === 'cast') {
      // `/cancel` tiene que valer también antes del spawn: verificar contra
      // `agy agents` y rehidratar la memoria llevan segundos, y sin esto el
      // bot contestaba que no había nada en curso mientras el cast avanzaba.
      let canceladoAntesDelSpawn = false;
      estado.cancelar = () => { canceladoAntesDelSpawn = true; return true; };
      const cast = await ejecutores.castear({
        agent: task.agent,
        prompt,
        cwd: task.cwd,
        agyBin: AGY_BIN,
        ejecutar: (cliArgs, op) => (canceladoAntesDelSpawn
          ? Promise.resolve({ success: false, cancelled: true, data: null, error: 'Cast cancelado antes de lanzar agy.' })
          : runAgyArgs(cliArgs, op)),
        opciones: { soloLectura: true, alcance: task.cwd, onSpawn: (cancel) => { estado.cancelar = cancel; } }
      });
      clearInterval(typingInterval);
      typingInterval = null;
      clearInterval(progressInterval);
      progressInterval = null;
      await updateProgress(`${finalProgressLabel({ success: cast.ok, cancelled: cast.cancelled })} ${formatElapsed(segundos())}`);
      await responderCast(ctx, task, cast, (Date.now() - startedAt) / 1000);
      return;
    }

    const result = await ejecutores.runAgyTask({
      prompt,
      mode,
      conversationId,
      onSpawn: (cancel) => { estado.cancelar = cancel; },
      // FEAT-034 — La última herramienta activa, para la próxima edición del
      // progreso. Solo la rama principal: los casts no van por stream.
      onActividad: (texto) => { actividad = recortarActividad(texto); }
    });

    clearInterval(typingInterval);
    typingInterval = null;
    clearInterval(progressInterval);
    progressInterval = null;

    // El separador « · » es para el mensaje vivo («Generando plan · 23s»); el
    // texto final ya lleva su propia preposición y quedaba «Completado en · 23s».
    // Una cancelación no es éxito, pero tampoco un error: sin su propia etiqueta
    // se anunciaba como «Terminado con error» y parecía que algo había fallado.
    await updateProgress(`${finalProgressLabel(result)} ${formatElapsed(segundos())}`);

    if (result.cancelled) {
      // El aviso ya lo dio /cancel; aquí solo se cierra el ciclo.
      console.log('[task] Tarea cancelada por el usuario.');
    } else if (result.success) {
      if (result.conversationId) {
        setConversationId(chatId, result.conversationId);
      }

      const meta = formatExecutionMeta(result.data, result.durationSeconds, result.conversationId, mode, result.sessionSeconds);
      // El texto lo produce un modelo con acceso al disco: si en algún momento
      // llega a leer el `.env` y lo cita, esto evita que el token acabe tanto en
      // el chat como en `daemon.log`. Barato, y no altera texto legítimo.
      const fullResponse = redactSecrets(result.responseText) + meta;

      // Si fue un /plan, ofrecer botón interactivo para ejecutarlo
      if (mode === 'plan' && result.conversationId) {
        const keyboard = new InlineKeyboard()
          .text('✅ Ejecutar cambios', `exec_plan:${result.conversationId}`)
          .text('❌ Descartar', 'cancel_plan');

        // FEAT-027 — Ajustar un plan ya se puede: el `setConversationId` de
        // arriba deja este plan como sesión del chat, y el texto suelto va en
        // modo plan sobre ella. Solo faltaba decirlo.
        const ayudaAjuste = '\n\n_¿Quieres ajustarlo? Responde con los cambios: sigue sobre este mismo plan._';
        await replyWithSmartChunks(ctx, fullResponse + ayudaAjuste, { reply_markup: keyboard });
      } else {
        await replyWithSmartChunks(ctx, fullResponse);
      }
    } else {
      let errMsg = `❌ *Error al ejecutar la tarea en Antigravity:*\n\n${redactSecrets(result.error)}`;
      if (result.conversationId) {
        errMsg += `\n\n*ID de conversación activa:* \`${result.conversationId}\``;
      }
      await notifyChat(chatId, errMsg, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('[TASK ERROR]', redactSecrets(err?.stack || err?.message || String(err)));
    await notifyChat(chatId, `❌ Ocurrió un error inesperado al procesar la tarea: ${redactSecrets(err.message)}`);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    if (progressInterval) clearInterval(progressInterval);
    // Solo este carril: el otro puede seguir con su tarea.
    estado.cancelar = null;
    estado.enCurso = null;
    if (getQueueLength(carril) > 0) {
      setImmediate(() => runQueue(carril));
    }
  }
}

/**
 * Texto del acuse inicial de una tarea recién encolada.
 *
 * La posición que se anuncia es la REAL en la fila, no el índice de la cola.
 * `enqueueTask` solo cuenta lo que está esperando: la tarea en ejecución ya
 * salió de la cola, así que devolver su índice tal cual decía «posición #1» a
 * quien en realidad iba segundo, detrás de la que se estaba ejecutando.
 *
 * Función pura y exportada para poder afirmarlo sin lanzar `agy` ni hablar con
 * Telegram.
 */
export function avisoDeDespacho({ habiaTareaEnCurso, posEnCola, mode }) {
  const encolada = habiaTareaEnCurso || posEnCola > 1;
  if (!encolada) {
    if (mode === 'cast') return '🎭 Casteando al agente...';
    return mode === 'plan'
      ? '🧠 Generando plan arquitectónico...'
      : '⚙️ Ejecutando tarea con Antigravity...';
  }
  const posicion = posEnCola + (habiaTareaEnCurso ? 1 : 0);
  // Un cast ya no espera detrás de un /run (FEAT-026): si queda encolado es
  // porque hay otro cast, y decir «Antigravity está ocupado» daría la razón
  // equivocada.
  if (mode === 'cast') return `⏳ Ya hay un cast en curso. El tuyo queda en la posición #${posicion}.`;
  return `⏳ Antigravity está ocupado con otra tarea. Tu solicitud queda en la posición #${posicion}.`;
}

/**
 * Texto vivo del mensaje de progreso: etiqueta, tiempo y, si la hay, la última
 * herramienta que abrió el agente (FEAT-034). Pura y exportada, como
 * `avisoDeDespacho`, para poder afirmarla sin lanzar `agy`.
 */
export function lineaDeProgreso(etiqueta, segundos, actividad = null) {
  return `${etiqueta} · ${formatElapsed(segundos)}${actividad ? ` · ${actividad}` : ''}`;
}

const ACTIVIDAD_MAX = 60;

/**
 * La actividad sale a Telegram en el mensaje de progreso, y un `CommandLine`
 * puede traer un secreto (`curl -H "Authorization: …"`). Se redacta ANTES de
 * recortar —recortar primero podría partir un token y dejarlo irreconocible
 * para el redactor— y se acota a una línea corta. `redactSecrets` solo conoce
 * tokens de Telegram: el recorte limita la exposición, no la elimina.
 */
export function recortarActividad(texto) {
  const plano = redactSecrets(String(texto ?? '')).replace(/\s+/g, ' ').trim();
  return plano.length > ACTIVIDAD_MAX ? `${plano.slice(0, ACTIVIDAD_MAX - 1)}…` : plano;
}

/**
 * Encola o despacha una tarea hacia Antigravity
 */
async function dispatchTask(ctx, prompt, mode = 'accept-edits', forceConvId = null, { freshSession = false } = {}) {
  const chatId = ctx.chat.id;
  let activeConvId = forceConvId !== null ? forceConvId : getConversationId(chatId);

  if (freshSession && forceConvId === null) {
    // `/run` arranca en limpio: se olvida la sesión previa del chat para que el
    // executor no pase --conversation y agy abra una nueva.
    clearConversationId(chatId);
    activeConvId = null;
  }

  // FEAT-022 — Punto único de defensa: el hilo de un agente persistido solo se
  // retoma con `--agent`, y esta vía no lo pasa. Cubre `/resume`, el texto
  // suelto y `exec_plan`, cuyo `callback_data` puede fabricarlo un cliente.
  if (activeConvId && castAgentes.esHiloDeAgente(activeConvId)) {
    if (forceConvId === null) clearConversationId(chatId);
    await ctx.reply('⛔ Esa conversación es el hilo de un agente persistido: por esta vía correría sin su identidad y con escritura. Usá /cast <agente> <pedido>.');
    return;
  }

  const task = { ctx, chatId, prompt, mode, conversationId: activeConvId, statusMessageId: null };

  const habiaTareaEnCurso = carriles.principal.enCurso !== null;
  const posEnCola = enqueueTask(task);

  // El mensaje inicial es el que luego se edita con el tiempo transcurrido, así
  // que se guarda su id en la propia tarea.
  const aviso = avisoDeDespacho({ habiaTareaEnCurso, posEnCola, mode });

  try {
    const sent = await ctx.reply(aviso);
    task.statusMessageId = sent?.message_id ?? null;
  } catch (err) {
    console.error(`[dispatch] No se pudo enviar el aviso inicial: ${redactSecrets(err.message)}`);
  }

  // Incondicional a propósito. `processTaskQueue` ya se protege con el
  // `enCurso` de su carril, así que llamarlo de más no cuesta nada, mientras
  // que llamarlo de menos deja la cola parada sin nadie que la drene.
  runQueue('principal');
}

// ==============================================================================
// FEAT-022 — Cast de agentes persistidos
// ==============================================================================

/**
 * ¿Se puede castear este agente desde el chat? Solo registrados y read-only:
 * un agente read/write disparado desde el celular escribiría sin que nadie vea
 * el diff antes. Pura salvo por la lectura del registro, para poder probarla.
 */
export function validarCastDesdeChat(nombre, homeDir = os.homedir()) {
  const agentes = registroAgentes.leerRegistro(homeDir).agents;
  const disponibles = Object.entries(agentes).filter(([, a]) => a && a.read_only).map(([n]) => n);
  const lista = disponibles.length
    ? `\n\nDisponibles: ${disponibles.map((n) => `\`${n}\``).join(', ')}`
    : '\n\nNo hay agentes read-only registrados. Se registran desde Claude Code con `cast_agent` action:"register".';

  // El nombre solo se repite si tiene forma de nombre: es texto del usuario y
  // va dentro de Markdown.
  if (!registroAgentes.nombreValido(nombre) || !agentes[nombre]) {
    const cual = registroAgentes.nombreValido(nombre) ? `\`${nombre}\`` : 'Ese nombre';
    return { ok: false, mensaje: `⚠️ ${cual} no es un agente registrado.${lista}` };
  }
  if (!agentes[nombre].read_only) {
    return { ok: false, mensaje: `⛔ \`${nombre}\` es read/write. Desde Telegram solo se castean agentes read-only.${lista}` };
  }
  return { ok: true };
}

export function buildCastWorkspacesKeyboard(castId, workspaces) {
  const keyboard = new InlineKeyboard();
  for (const ws of workspaces) {
    keyboard.text(`📁 ${ws.displayName}`, `cast_ws:${castId}:${ws.id}`).row();
  }
  keyboard.text('❌ Cancelar', `cast_cancel:${castId}`);
  return keyboard;
}

/** Pie de la respuesta: quién respondió, sobre qué, y si la memoria sirvió. */
export function formatearPieDeCast(task, cast, segundos) {
  const memoria = !cast.memoria?.usada
    ? 'desactivada'
    : (cast.memoria.recuperada ? 'recuperada' : `sin contexto (${cast.memoria.motivo || 'no disponible'})`);
  const partes = [
    `🎭 ${task.agent}`,
    `📁 ${task.workspaceName}`,
    segundos ? formatElapsed(segundos) : null,
    `memoria: ${memoria}`,
    cast.memoria?.guardadas
      ? `criterio guardado: ${cast.memoria.guardadas}`
      : (cast.memoria?.extraidas
        ? `criterio NO guardado (${cast.memoria.motivoCierre})`
        : 'criterio guardado: 0')
  ];
  return `\n\n—\n${partes.filter(Boolean).join(' · ')}`;
}

/**
 * Encola un cast en su carril. No lee `getConversationId(chatId)`: el cast no
 * hereda la sesión del chat, su hilo lo resuelve `castear()` desde el estado
 * del agente.
 *
 * Exportada solo para los tests de concurrencia: las validaciones de seguridad
 * (agente read-only, workspace de la lista, pendiente del mismo chat) ocurren
 * ANTES, en `/cast` y en el callback `cast_ws:`.
 */
export async function dispatchCast(ctx, { agent, prompt, cwd, workspaceName }) {
  const chatId = ctx.chat.id;
  const task = {
    ctx, chatId, kind: 'cast', agent, prompt, cwd, workspaceName,
    mode: 'cast', conversationId: null, statusMessageId: null
  };

  const habiaTareaEnCurso = carriles.cast.enCurso !== null;
  const posEnCola = enqueueTask(task);
  try {
    const sent = await ctx.reply(avisoDeDespacho({ habiaTareaEnCurso, posEnCola, mode: 'cast' }));
    task.statusMessageId = sent?.message_id ?? null;
  } catch (err) {
    console.error(`[cast] No se pudo enviar el aviso inicial: ${redactSecrets(err.message)}`);
  }
  runQueue('cast');
}

/** Sin teclado y sin `setConversationId`: ver la rama `cast` de processTaskQueue. */
async function responderCast(ctx, task, cast, segundos) {
  if (cast.cancelled) {
    console.log('[cast] Cancelado por el usuario.');
    return;
  }
  if (!cast.ok) {
    let msg = `❌ *Falló el cast de* \`${task.agent}\`:\n\n${redactSecrets(cast.error)}`;
    if (cast.conversationId) msg += '\n\nEl hilo del agente quedó guardado: el próximo /cast lo retoma.';
    await notifyChat(task.chatId, msg, { parse_mode: 'Markdown' });
    return;
  }
  // El agente lee el disco: si cita un `.env`, esto evita al menos que el
  // token del bot acabe en el chat y en `daemon.log`.
  await replyWithSmartChunks(ctx, redactSecrets(cast.respuesta) + formatearPieDeCast(task, cast, segundos));
}

// ==============================================================================
// 4. Construcción del bot
// ==============================================================================

/**
 * Construye el InlineKeyboard de selección de proyectos para Remote Control.
 * Mantiene los identificadores compactos (rc_start:<id>) para respetar el límite
 * de 64 bytes de la API de Telegram.
 */
export function buildWorkspacesKeyboard(workspaces) {
  const keyboard = new InlineKeyboard();
  for (const ws of workspaces) {
    keyboard.text(`📁 ${ws.displayName}`, `rc_start:${ws.id}`).row();
  }
  keyboard.text('❌ Cancelar', 'rc_cancel');
  return keyboard;
}

/**
 * Construye el mensaje y el teclado de confirmación para el cierre de sesión de Claude,
 * integrando la inspección de worktrees (Opción B).
 *
 * Invariantes de seguridad:
 * - Solo se ofrecen para purgar worktrees 100% limpios (status --porcelain limpio Y 0 commits ahead).
 * - Los worktrees con cambios o commits NUNCA se eliminan; se preservan y se alertan al usuario.
 *
 * @param {{ success: boolean, pid?: number, projectPath?: string, error?: string }} stopRes
 * @param {Array<Object>} [workspaces] Lista opcional de workspaces para testing
 * @param {Function} [inspectFn] Función opcional de inspección para testing
 * @returns {{ text: string, keyboard: InlineKeyboard | null }}
 */
export function buildStopMessageAndKeyboard(
  stopRes,
  workspaces = getKnownWorkspaces(),
  inspectFn = inspectClaudeWorktrees
) {
  if (!stopRes || !stopRes.success) {
    return {
      text: `⚠️ ${stopRes?.error || 'No se pudo detener la sesión.'}`,
      keyboard: null
    };
  }

  let text = `🛑 *Sesión de Claude Code finalizada* (PID: ${stopRes.pid}).\nEl túnel de Remote Control ha sido cerrado.`;
  let keyboard = null;

  if (stopRes.projectPath) {
    try {
      const { cleanWorktrees, dirtyWorktrees } = inspectFn(stopRes.projectPath);
      const ws = workspaces.find(
        (w) => path.resolve(w.path).toLowerCase() === path.resolve(stopRes.projectPath).toLowerCase()
      );
      const wsId = ws ? ws.id : null;

      if (dirtyWorktrees && dirtyWorktrees.length > 0) {
        text += `\n\n⚠️ *Worktrees con cambios detectados (conservados intactos):*\n` +
          dirtyWorktrees.map((w) => `• Rama: \`${w.branch}\` (${w.reason})`).join('\n');
      }

      if (cleanWorktrees && cleanWorktrees.length > 0 && wsId) {
        text += `\n\n🧹 Se detectaron *${cleanWorktrees.length}* worktree(s) temporales de Claude sin cambios.\n¿Deseas purgarlos para liberar espacio en disco?`;
        keyboard = new InlineKeyboard()
          .text(`🧹 Purgar ${cleanWorktrees.length} worktree(s) limpios`, `rc_clean:${wsId}`)
          .text('📁 Conservar', 'rc_keep');
      }
    } catch (err) {
      console.warn(`[claude-stop] Error inspeccionando worktrees: ${err.message}`);
    }
  }

  return { text, keyboard };
}

/**
 * Construye el bot con todos sus handlers registrados. No abre conexiones ni
 * toca el lockfile: eso es cosa de `main()`.
 */
export function createBot({
  token = process.env.TELEGRAM_BOT_TOKEN,
  allowedUserIds = parseAllowedUserIds(),
  // Inyectable para que los tests de /logs no lean el log real de la máquina.
  logFile = path.join(__dirname, 'daemon.log')
} = {}) {
  const bot = new Bot(token);
  botRef = bot;

  // Respeta `retry_after` de Telegram de forma transparente en cada llamada a la
  // API. Sin esto, un 429 se propaga como error de la tarea y el usuario pierde
  // la respuesta por una limitación temporal de tasa.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  // --------------------------------------------------------------------------
  // Middleware de acceso: whitelist de usuario Y chat estrictamente privado.
  //
  // La whitelist sola no basta. Autoriza a una PERSONA, no a un CANAL: basta
  // con que alguien añada el bot a un grupo donde participe un usuario de la
  // lista para que sus comandos se atiendan y la respuesta —código fuente,
  // diffs, rutas locales, salida de `/status`— se publique a todo el grupo. La
  // frontera de privacidad del bridge es el chat 1:1, así que se comprueba.
  //
  // El orden importa: primero la identidad, después el tipo de chat. Al revés,
  // un intento no autorizado dentro de un grupo se descartaría antes de llegar
  // al log de seguridad y no dejaría rastro de que ocurrió.
  // --------------------------------------------------------------------------
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowedUserIds.has(String(userId))) {
      console.warn(`[SEGURIDAD] Petición no autorizada descartada: ID ${userId} (@${ctx.from?.username || 'sin_alias'}) en chat ${ctx.chat?.id ?? '?'} (${ctx.chat?.type ?? 'sin_chat'})`);
      return; // Silent drop
    }

    if (ctx.chat?.type !== 'private') {
      console.warn(`[SEGURIDAD] Usuario autorizado ${userId} descartado por chat no privado: ${ctx.chat?.type ?? 'sin_chat'} (${ctx.chat?.id ?? '?'}).`);
      return; // Silent drop para grupos, supergrupos y canales
    }

    await next();
  });

  // ==============================================================================
  // Comandos
  // ==============================================================================

  bot.command(['start', 'help'], async (ctx) => {
    const convId = getConversationId(ctx.chat.id);
    const helpText = `🚀 *Antigravity Telegram Bridge*

Puente móvil autónomo conectado a tu entorno local.

*Comandos disponibles:*
• \`/plan <instrucción>\` — Genera un plan de acción de solo lectura con botón para aprobarlo.
• \`/run <instrucción>\` — Abre una sesión nueva y ejecuta, permitiendo edición de código y tests.
• \`/resume <instrucción>\` — Continúa la sesión de trabajo actual.
• \`/claude\` — Inicia o gestiona sesiones de Claude Code (\`/claude stop\`, \`/claude clean\`, \`/claude status\`).
• \`/cast <agente> <pedido>\` — Consulta a un agente persistido de solo lectura; eliges el proyecto con un botón.
• \`/status\` — Consulta estado del binario, versión, sesión activa y política de permisos.
• \`/queue\` — Muestra la tarea en curso y las encoladas.
• \`/diff [archivo]\` — Cambios sin commitear del workspace. El contenido sale a Telegram; lo que esté en \`deny_paths\` no.
• \`/logs [N]\` — Últimas líneas del log del daemon, para ver por qué falló algo. Si el bot está caído, esto tampoco responde.
• \`/cancel\` — Aborta lo que esté en curso y vacía las colas. \`/cancel cast\` corta solo el cast, sin tocar un /run.
• \`/reset\` — Reinicia la conversación y olvida el contexto actual.

*Sesión activa:* ${convId ? `\`${convId}\`` : '_Ninguna (el próximo mensaje abrirá una nueva)_'}

_El texto suelto se ejecuta en modo \`plan\` sobre la sesión activa: primero verás qué se haría y decides con el botón «Ejecutar cambios». Para escribir directamente sin ese paso, usa \`/run\`._`;

    await sendSafeChunk(ctx, helpText);
  });

  bot.command('claude', async (ctx) => {
    const rawMatch = ctx.match?.trim() || '';
    const parts = rawMatch.split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    const targetArg = parts.slice(1).join(' ').trim();

    if (sub === 'stop') {
      const res = stopClaudeRemoteSession();
      const { text, keyboard } = buildStopMessageAndKeyboard(res);
      return sendSafeChunk(ctx, text, keyboard ? { reply_markup: keyboard } : undefined);
    }

    if (sub === 'clean') {
      const workspaces = getKnownWorkspaces();
      let ws = null;
      if (targetArg) {
        const lowerArg = targetArg.toLowerCase();
        ws = workspaces.find((w) => String(w.id) === lowerArg || String(w.numericId) === lowerArg || w.name.toLowerCase() === lowerArg);
        if (!ws) {
          return sendSafeChunk(
            ctx,
            `⚠️ *Workspace no encontrado o no autorizado*\n\n` +
            `El identificador \`${targetArg}\` no coincide con ningún proyecto autorizado.\n` +
            `Usa \`/claude\` para ver tus proyectos permitidos.`
          );
        }
      } else {
        const active = getActiveClaudeSession();
        if (active) {
          ws = workspaces.find((w) => path.resolve(w.path).toLowerCase() === path.resolve(active.projectPath).toLowerCase());
        }
        if (!ws) {
          return sendSafeChunk(
            ctx,
            'ℹ️ Especifica qué proyecto deseas limpiar. Ejemplo:\n' +
            '`/claude clean <nombre_o_id>`\n' +
            'O escribe `/claude` para ver tus proyectos autorizados.'
          );
        }
      }

      const pruneRes = pruneCleanClaudeWorktrees(ws.path);
      let msg = `🧹 *Limpieza de worktrees en ${ws.name}*\n` +
        `• Worktrees limpios purgados: *${pruneRes.removedCount}*\n` +
        `• Worktrees con cambios preservados: *${pruneRes.preservedCount}*`;
      if (pruneRes.preservedCount > 0) {
        msg += `\n\n⚠️ *Worktrees conservados intactos:*\n` +
          pruneRes.preservedWorktrees.map((w) => `• Rama: \`${w.branch}\` (${w.reason})`).join('\n');
      }
      return sendSafeChunk(ctx, msg);
    }

    if (sub === 'status') {
      const active = getActiveClaudeSession();
      if (!active) {
        return sendSafeChunk(ctx, '📭 No hay ninguna sesión activa de Claude Code en este momento.\nUsa `/claude` para ver tus workspaces disponibles e iniciar una.');
      }
      const keyboard = new InlineKeyboard()
        .text('🛑 Detener sesión', 'rc_stop')
        .text('🔄 Ver workspaces', 'rc_list');
      const msg = `🎮 *Sesión de Claude Code Activa (Remote Control)*\n` +
        `• *Proyecto:* \`${active.projectPath}\`\n` +
        `• *Sesión:* \`${active.sessionName}\`\n` +
        `• *PID:* \`${active.pid}\`\n` +
        (active.spawnMode ? `• *Modo:* \`${active.spawnMode}\`\n` : '') +
        `• *Iniciada:* ${active.startedAt}\n\n` +
        `📲 Ya está disponible en tu aplicación móvil de Claude.`;
      return sendSafeChunk(ctx, msg, { reply_markup: keyboard });
    }

    // Si se pasa un argumento que no es status, stop ni clean, validar contra Project Allowlist (sin interpolar input crudo)
    if (sub) {
      const workspaces = getKnownWorkspaces();
      const ws = workspaces.find((w) => String(w.id) === sub || String(w.numericId) === sub || w.name.toLowerCase() === sub);
      if (!ws) {
        return sendSafeChunk(
          ctx,
          `⚠️ *Acceso denegado o workspace no reconocido*\n\n` +
          `El identificador \`${sub}\` no pertenece a la lista de proyectos autorizados (Project Allowlist).\n` +
          `Escribe \`/claude\` para ver la lista de proyectos permitidos.`
        );
      }

      const launch = launchClaudeRemoteSession({
        workspacePath: ws.path,
        spawnMode: ws.spawnMode,
        replaceActive: true
      });
      if (!launch.success) {
        return sendSafeChunk(ctx, `❌ *No se pudo iniciar Claude Code:*\n${launch.error}`);
      }

      if (launch.alreadyRunning) {
        const keyboard = new InlineKeyboard()
          .text('🛑 Detener sesión', 'rc_stop')
          .text('🔄 Ver workspaces', 'rc_list');
        const msg = `ℹ️ *Sesión de Claude Code ya activa*\n\n` +
          `Ya existe un proceso de Remote Control en ejecución para este workspace${launch.source === 'tmux' ? ' (en sesión de tmux)' : ''}:\n` +
          `• *Proyecto:* \`${launch.projectPath}\`\n` +
          `• *PID:* \`${launch.pid}\`\n` +
          (launch.environmentId ? `• *Entorno:* \`${launch.environmentId}\`\n` : '') +
          (launch.spawnMode ? `• *Modo:* \`${launch.spawnMode}\`\n` : '') +
          `\n📲 *Abre la app de Claude en tu teléfono* (o claude.ai/code) para continuar. No se disparó un proceso duplicado.`;
        return sendSafeChunk(ctx, msg, { reply_markup: keyboard });
      }

      // Verificación de estabilidad inicial: esperar 800ms para confirmar que el proceso no muera por trust/auth
      await new Promise((r) => setTimeout(r, 800));
      if (!isPidAlive(launch.pid)) {
        let errorDetail = '';
        try {
          const logContent = fs.readFileSync(path.join(bridgeDataDirPath(), 'claude-session.log'), 'utf8');
          const lines = logContent.trim().split(/\r?\n/).slice(-6);
          errorDetail = lines.join('\n');
        } catch {}

        return sendSafeChunk(
          ctx,
          `❌ *El proceso de Claude Code se cerró al arrancar*\n\n` +
          `El proceso (PID \`${launch.pid}\`) terminó de forma prematura.\n\n` +
          (errorDetail ? `*Salida de error detectada:*\n\`\`\`\n${errorDetail}\n\`\`\`\n\n` : '') +
          `💡 Abre una terminal en \`${launch.projectPath}\` y ejecuta \`claude\` para aceptar los permisos o diálogo de confianza.`
        );
      }

      let envUrl = null;
      try {
        const logContent = fs.readFileSync(path.join(bridgeDataDirPath(), 'claude-session.log'), 'utf8');
        const match = logContent.match(/https:\/\/claude\.ai\/code\?environment=(env_[a-zA-Z0-9_-]+)/g);
        if (match && match.length > 0) {
          envUrl = match[match.length - 1];
        }
      } catch {}

      const keyboard = new InlineKeyboard();
      if (envUrl) {
        keyboard.url('📲 Abrir en Claude', envUrl).row();
      }
      keyboard.text('🛑 Detener sesión', 'rc_stop').text('🔄 Ver workspaces', 'rc_list');

      const msg = `🚀 *Sesión de Claude Code iniciada con éxito*\n\n` +
        `• *Proyecto:* \`${launch.projectPath}\`\n` +
        `• *Nombre:* \`${launch.sessionName}\`\n` +
        `• *PID:* \`${launch.pid}\`\n` +
        `• *Modo:* \`${launch.spawnMode || 'same-dir'}\`\n\n` +
        (envUrl ? `🔗 [Abrir en Claude App o Web](${envUrl})\n\n` : '') +
        `📲 *Abre la app de Claude* (o pulsa el botón de abajo) y toca en **\`+\` (Nueva sesión)** para comenzar.\n\n` +
        `_Para detenerla más tarde, escribe_ \`/claude stop\` _o pulsa el botón de abajo._`;

      return sendSafeChunk(ctx, msg, { reply_markup: keyboard });
    }

    // Sin subcomando: comprobar si ya hay sesión activa o listar proyectos
    const active = getActiveClaudeSession();
    if (active) {
      const keyboard = new InlineKeyboard()
        .text('🛑 Detener sesión', 'rc_stop')
        .text('🔄 Cambiar de proyecto', 'rc_list');
      const msg = `🎮 *Sesión de Claude Code Activa*\n\n` +
        `Actualmente hay una sesión de Remote Control en ejecución:\n` +
        `• *Proyecto:* \`${active.projectPath}\`\n` +
        `• *Sesión:* \`${active.sessionName}\`\n` +
        `• *PID:* \`${active.pid}\`\n` +
        (active.spawnMode ? `• *Modo:* \`${active.spawnMode}\`\n` : '') +
        `\n¿Deseas detenerla o cambiar a otro workspace?`;
      return sendSafeChunk(ctx, msg, { reply_markup: keyboard });
    }

    const workspaces = getKnownWorkspaces();
    if (workspaces.length === 0) {
      return sendSafeChunk(ctx, '⚠️ No se encontraron workspaces registrados en `~/.claude.json` con carpetas existentes en tu equipo.');
    }

    const keyboard = buildWorkspacesKeyboard(workspaces);
    const msg = `📱 *Claude Code — Remote Control*\n\n` +
      `Selecciona el proyecto donde deseas iniciar la sesión interactiva:`;
    return sendSafeChunk(ctx, msg, { reply_markup: keyboard });
  });

  bot.command('status', async (ctx) => {
    const status = getAgyStatus();
    const convId = getConversationId(ctx.chat.id);
    const lineaCarril = (c) => `${getQueueLength(c)} pendientes (en curso: ${carriles[c].enCurso ? 'Sí' : 'No'})`;

    const msg = `📊 *Estado del Sistema Antigravity*
• *Binario:* \`${status.binPath}\`
• *Versión:* \`${status.version}\`
• *Workspace:* \`${status.workspaceDir}\`
${status.extraDirs.length > 0 ? `• *Directorios extra:* \`${status.extraDirs.join(', ')}\`
` : ''}
• *Sesión chat:* ${convId ? `\`${convId}\`` : '_Sin conversación activa_'}
• *Cola principal:* ${lineaCarril('principal')}
• *Cola de casts:* ${lineaCarril('cast')}

🔒 *Controles efectivos* (los impone el sistema)
• *Chats:* solo conversaciones privadas con usuarios en la whitelist
• *Aprobación de herramientas:* \`--dangerously-skip-permissions\` (auto-aprobada)
• *Texto libre:* entra en modo \`plan\`; escribir requiere pulsar «Ejecutar cambios»
• *Adjuntos salientes:* \`deny_paths\` se aplica de verdad a los archivos que el bridge sube
• *Secretos:* el token de Telegram no se hereda al proceso de \`agy\`
• *Workspace:* fija el \`cwd\` de \`agy\`; *no* limita dónde puede escribir
• *Sandbox de terminal:* ${status.enforcement.sandbox ? '`activo` — cada comando pide UAC' : '`inactivo`'} (restringe la terminal, no las rutas)

⚠️ *Guardrails solo sugeridos al modelo* (no exigibles: \`agy\` no expone flags de política por ruta o comando)
• *Comandos desaconsejados:* \`${status.denyCommands.join(', ')}\`
• *Rutas desaconsejadas:* \`${status.denyPaths.join(', ')}\`
• *Política cargada de:* ${status.configFile ? `\`${status.configFile}\`` : '_valores por defecto_'}`;

    await sendSafeChunk(ctx, msg);
  });

  bot.command('reset', async (ctx) => {
    clearConversationId(ctx.chat.id);
    await ctx.reply('🔄 Contexto de conversación reiniciado. Tu próximo mensaje iniciará una nueva sesión en blanco.');
  });

  bot.command('plan', async (ctx) => {
    const prompt = ctx.match?.trim();
    if (!prompt) {
      return sendSafeChunk(ctx, '⚠️ Por favor indica la tarea a planificar. Ejemplo:\n`/plan Analizar el sistema de login y proponer refactor`');
    }
    await dispatchTask(ctx, prompt, 'plan');
  });

  // `/run` abre sesión nueva y `/resume` continúa la activa. Antes eran
  // indistinguibles: ambos reutilizaban el conversationId del chat.
  bot.command('run', async (ctx) => {
    const prompt = ctx.match?.trim();
    if (!prompt) {
      return sendSafeChunk(ctx, '⚠️ Por favor indica la tarea a ejecutar. Ejemplo:\n`/run Corregir los imports en index.js`');
    }
    await dispatchTask(ctx, prompt, 'accept-edits', null, { freshSession: true });
  });

  bot.command('resume', async (ctx) => {
    const prompt = ctx.match?.trim();
    if (!prompt) {
      return sendSafeChunk(ctx, '⚠️ Por favor indica qué deseas continuar en la sesión. Ejemplo:\n`/resume Ahora ejecuta las pruebas unitarias`');
    }
    if (!getConversationId(ctx.chat.id)) {
      return ctx.reply('No hay sesión activa que continuar. Usa /run para abrir una nueva.');
    }
    await dispatchTask(ctx, prompt, 'accept-edits');
  });

  // FEAT-022 — `/cast <agente> <pedido>`. Valida en el acto, sin encolar, y
  // pide el proyecto con el mismo listado de `/claude` (getKnownWorkspaces):
  // nunca una ruta escrita a mano.
  bot.command('cast', async (ctx) => {
    const partes = (ctx.match || '').trim().match(/^(\S+)\s+([\s\S]+)$/);
    if (!partes) {
      return sendSafeChunk(ctx, '⚠️ Uso: `/cast <agente> <pedido>`\nEjemplo: `/cast lagrange-reviewer Revisá el último commit`');
    }
    const [, agente, pedido] = partes;

    const validacion = validarCastDesdeChat(agente);
    if (!validacion.ok) return sendSafeChunk(ctx, validacion.mensaje);

    const workspaces = getKnownWorkspaces();
    if (workspaces.length === 0) {
      return sendSafeChunk(ctx, '⚠️ No se encontraron workspaces registrados en `~/.claude.json` con carpetas existentes en tu equipo.');
    }

    const castId = guardarCastPendiente({ chatId: ctx.chat.id, agent: agente, prompt: pedido.trim() });
    await sendSafeChunk(ctx, `🎭 *Cast de* \`${agente}\`\n\n¿Sobre qué proyecto trabaja?\n\nSe le pide que lea solo esa carpeta, pero es una instrucción, no un permiso: puede leer cualquier ruta de tu usuario.`, {
      reply_markup: buildCastWorkspacesKeyboard(castId, workspaces)
    });
  });

  // `/cancel` corta todo, en los dos carriles: es el comando de emergencia y su
  // significado no cambia. `/cancel cast` corta solo el carril de casts, para
  // «el reviewer tarda, pero el /run que siga». Un argumento que no se entiende
  // NO cancela nada: ante la duda, no se hace la acción destructiva.
  bot.command('cancel', async (ctx) => {
    const arg = (ctx.match || '').trim().toLowerCase();
    if (arg && arg !== 'cast') {
      return ctx.reply('Uso: /cancel corta todo (lo que está en curso y las colas); /cancel cast corta solo el cast. No se canceló nada.');
    }

    const objetivo = arg === 'cast' ? ['cast'] : CARRILES;
    let descartadas = 0;
    const abortados = [];
    for (const c of objetivo) {
      descartadas += clearQueue(c);
      const cancelar = carriles[c].cancelar;
      if (typeof cancelar === 'function' && cancelar()) abortados.push(c);
    }

    if (abortados.length === 0 && descartadas === 0) {
      return ctx.reply(arg === 'cast'
        ? 'No hay ningún cast en curso ni encolado que cancelar.'
        : 'No hay ninguna tarea en curso ni encolada que cancelar.');
    }

    const nombres = { principal: 'tarea en curso abortada', cast: 'cast en curso abortado' };
    const partes = [];
    if (abortados.length > 0) {
      partes.push(`${abortados.map((c) => nombres[c]).join(' y ')} (cierre del árbol de procesos, forzado si no responde)`);
    }
    if (descartadas > 0) partes.push(`${descartadas} tarea(s) encolada(s) descartada(s)`);
    await ctx.reply(`🛑 Cancelado: ${partes.join(' y ')}.`);
  });

  bot.command('queue', async (ctx) => {
    if (!CARRILES.some((c) => carriles[c].enCurso || getQueueLength(c) > 0)) {
      return ctx.reply('📭 No hay nada en curso ni en cola.');
    }

    const titulos = { principal: '*Principal* (plan, run, resume)', cast: '*Casts*' };
    const que = (t) => (t.kind === 'cast' ? `agente \`${t.agent}\`` : `modo \`${t.mode}\``);
    const lineas = [];
    for (const c of CARRILES) {
      const enCurso = carriles[c].enCurso;
      const pendientes = getQueueSnapshot(c);
      if (!enCurso && pendientes.length === 0) continue;
      lineas.push(titulos[c]);
      if (enCurso) {
        lineas.push(`▶️ En curso (${que(enCurso)}, desde ${enCurso.enqueuedAt})`);
        lineas.push(`   ${enCurso.prompt.slice(0, 80)}`);
      }
      pendientes.forEach((t, i) => {
        lineas.push(`${i + 1}. ${que(t)} — ${t.promptPreview}`);
      });
      lineas.push('');
    }
    lineas.push('_Usa_ `/cancel` _para abortar todo, o_ `/cancel cast` _solo el cast._');

    await sendSafeChunk(ctx, lineas.join('\n'));
  });

  // FEAT-028 — Instantáneo, como /status: no pasa por la cola. Mira el mismo
  // workspace donde escribe /run. Los controles de ruta viven en lectura.js.
  bot.command('diff', async (ctx) => {
    const arg = (ctx.match || '').trim();
    const cwd = resolveWorkspace();
    try {
      let resultado;
      if (!arg) {
        resultado = resumenDeCambios({ cwd });
      } else {
        const ruta = resolverRutaEnWorkspace(arg, cwd);
        resultado = ruta.ok ? diffDeArchivo({ cwd, ...ruta }) : { aviso: `⚠️ ${ruta.motivo}` };
      }
      await replyWithSmartChunks(ctx, componerRespuesta(resultado));
    } catch (err) {
      await ctx.reply(`❌ No se pudo obtener el diff: ${redactSecrets(err.message)}`);
    }
  });

  // FEAT-029 — Sirve cuando el bot responde pero algo falló en silencio; si el
  // bot está caído, este comando tampoco llega.
  bot.command('logs', async (ctx) => {
    const { lineas, aviso } = parsearLineasLogs(ctx.match);
    try {
      const cuerpo = componerRespuesta(logsDelDaemon({ lineas, logFile }));
      await replyWithSmartChunks(ctx, aviso ? `⚠️ ${aviso}\n\n${cuerpo}` : cuerpo);
    } catch (err) {
      await ctx.reply(`❌ No se pudo leer el log: ${redactSecrets(err.message)}`);
    }
  });

  // ==============================================================================
  // Botones interactivos (Inline Keyboards)
  // ==============================================================================

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    // FEAT-022 — Elección de workspace para un /cast pendiente.
    if (data.startsWith('cast_ws:') || data.startsWith('cast_cancel:')) {
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}

      if (data.startsWith('cast_cancel:')) {
        tomarCastPendiente(data.slice('cast_cancel:'.length), ctx.chat?.id);
        await ctx.answerCallbackQuery({ text: 'Cast descartado' });
        return;
      }

      const partes = data.match(/^cast_ws:([0-9a-f]{8}):([A-Za-z0-9_-]{1,32})$/);
      const pendiente = partes ? tomarCastPendiente(partes[1], ctx.chat?.id) : null;
      if (!pendiente) {
        await ctx.answerCallbackQuery({ text: 'Este cast ya no está activo o expiró. Volvé a enviarlo.' });
        return;
      }
      const ws = getKnownWorkspaces().find((w) => String(w.id) === partes[2]);
      if (!ws) {
        await ctx.answerCallbackQuery({ text: 'Proyecto no encontrado o ya no existe en disco.' });
        return;
      }

      await ctx.answerCallbackQuery({ text: `Casteando sobre ${ws.name}...` });
      await dispatchCast(ctx, {
        agent: pendiente.agent,
        prompt: pendiente.prompt,
        cwd: ws.path,
        workspaceName: ws.displayName || ws.name
      });
      return;
    }

    if (data.startsWith('ask:')) {
      // Formato: ask:<askId>:<optionIndex>
      const parts = data.split(':');
      const askId = parts[1];
      const optionIndex = parseInt(parts[2], 10);
      const pending = getPendingAsk(askId);

      // FEAT-035 (hardening) — Solo el chat al que se mandó la pregunta puede
      // responderla: el `callback_data` lo puede fabricar un cliente propio.
      // Va antes del chequeo de estado para no revelar si un ask ajeno sigue
      // abierto, y sin `chatId` guardado no hay dueño contra el cual comparar.
      if (pending && (!pending.chatId || !ctx.chat?.id || String(pending.chatId) !== String(ctx.chat.id))) {
        console.warn(`[SEGURIDAD] Callback del ask ${askId} desde el chat ${ctx.chat?.id ?? '?'}, que no es el suyo. Ignorado.`);
        await ctx.answerCallbackQuery({ text: 'Esta consulta no pertenece a este chat.' });
        return;
      }

      if (pending && pending.status !== 'pending') {
        await ctx.answerCallbackQuery({
          text: pending.status === 'answered' ? 'Esta consulta ya fue respondida.' : 'Esta consulta expiró.'
        });
        try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
        return;
      }

      if (pending && pending.options && pending.options[optionIndex] !== undefined) {
        const selected = pending.options[optionIndex];

        // La comprobación de estado de arriba es informativa; la decisión real
        // la toma `resolvePendingAsk`, que revalida `status` dentro del lock.
        // Entre aquella lectura y esta escritura cabe otra pulsación o una
        // expiración, y confiar en la lectura previa resolvía dos veces el mismo
        // ask: la segunda respuesta pisaba a la primera y el usuario recibía dos
        // confirmaciones contradictorias.
        const resuelto = resolvePendingAsk(askId, selected, ctx.from?.id);
        if (!resuelto) {
          await ctx.answerCallbackQuery({ text: 'Esta consulta acaba de cerrarse. No se registró tu selección.' });
          try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
          return;
        }

        await ctx.answerCallbackQuery({ text: `Seleccionaste: ${selected}` });
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch {}
        await sendSafeChunk(ctx, `🔘 *Respuesta registrada:* \`${selected}\`\nEl agente continuará su tarea en tu equipo.`);
      } else {
        await ctx.answerCallbackQuery({ text: 'Esta consulta ya no está activa o expiró.' });
      }
      return;
    }

    if (data.startsWith('exec_plan:')) {
      const convId = data.slice('exec_plan:'.length).trim();

      // `callback_data` lo puede fabricar un cliente, no solo el botón que emitió
      // el bot. El id acaba en `agy --conversation <id>`: sin `shell: false` no
      // habría inyección posible, pero sí una reanudación de una conversación
      // arbitraria. Se exige la forma de un identificador antes de usarlo.
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(convId)) {
        await ctx.answerCallbackQuery({ text: 'Identificador de plan inválido.' });
        return;
      }

      // FEAT-022 — Antes del acuse «Aprobado». `dispatchTask` también lo
      // rechaza, pero para entonces el usuario ya leyó que se estaba ejecutando.
      if (castAgentes.esHiloDeAgente(convId)) {
        await ctx.answerCallbackQuery({ text: 'Ese hilo es de un agente persistido: no se ejecuta por esta vía.' });
        return;
      }

      await ctx.answerCallbackQuery({ text: 'Aprobado: Iniciando ejecución...' });
      // Sin try/catch, un fallo al quitar los botones —mensaje borrado, editado
      // ya, error de red— abortaba el handler DESPUÉS de haber confirmado
      // «Aprobado» al usuario: la ejecución no llegaba a despacharse nunca y no
      // quedaba señal de por qué. Quitar los botones es cosmético; despachar el
      // plan no lo es.
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch (err) {
        console.warn(`[exec_plan] No se pudieron retirar los botones: ${redactSecrets(err.message)}`);
      }
      await sendSafeChunk(ctx, '🚀 *Plan Aprobado*: Procediendo a implementar los cambios...');

      await dispatchTask(
        ctx,
        'Procede a implementar de forma concreta todos los cambios y pasos acordados en el plan anterior.',
        'accept-edits',
        convId
      );
    } else if (data === 'cancel_plan') {
      await ctx.answerCallbackQuery({ text: 'Plan descartado' });
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
      await ctx.reply('🗑️ Plan descartado. Puedes enviar una nueva solicitud cuando desees.');
    }

    if (data.startsWith('rc_start:')) {
      const idStr = data.slice('rc_start:'.length).trim();
      const workspaces = getKnownWorkspaces();
      const ws = workspaces.find((w) => String(w.id) === idStr || String(w.numericId) === idStr);

      if (!ws) {
        await ctx.answerCallbackQuery({ text: 'Proyecto no encontrado o ya no existe en disco.' });
        try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
        return;
      }

      // F-03: Si ya existía una sesión activa para OTRO proyecto, detenerla limpiamente primero
      const active = getActiveClaudeSession();
      if (active && path.resolve(active.projectPath).toLowerCase() !== path.resolve(ws.path).toLowerCase()) {
        stopClaudeRemoteSession();
      }

      await ctx.answerCallbackQuery({ text: `Conectando con ${ws.name}...` });
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}

      const launch = launchClaudeRemoteSession({
        workspacePath: ws.path,
        spawnMode: ws.spawnMode,
        replaceActive: true
      });
      if (!launch.success) {
        return sendSafeChunk(ctx, `❌ *No se pudo iniciar Claude Code:*\n${launch.error}`);
      }

      if (launch.alreadyRunning) {
        const keyboard = new InlineKeyboard().text('🛑 Detener sesión', 'rc_stop');
        const msg = `ℹ️ *Sesión de Claude Code ya activa*\n\n` +
          `Ya existe un proceso de Remote Control en ejecución para este workspace${launch.source === 'tmux' ? ' (en sesión de tmux)' : ''}:\n` +
          `• *Proyecto:* \`${launch.projectPath}\`\n` +
          `• *PID:* \`${launch.pid}\`\n` +
          (launch.environmentId ? `• *Entorno:* \`${launch.environmentId}\`\n` : '') +
          (launch.spawnMode ? `• *Modo:* \`${launch.spawnMode}\`\n` : '') +
          `\n📲 *Abre la app de Claude en tu teléfono* (o claude.ai/code) para continuar. No se inició un proceso duplicado.`;
        return sendSafeChunk(ctx, msg, { reply_markup: keyboard });
      }

      // Verificación de estabilidad inicial: esperar 800ms para confirmar que el proceso no muera por trust/auth
      await new Promise((r) => setTimeout(r, 800));
      if (!isPidAlive(launch.pid)) {
        let errorDetail = '';
        try {
          const logContent = fs.readFileSync(path.join(bridgeDataDirPath(), 'claude-session.log'), 'utf8');
          const lines = logContent.trim().split(/\r?\n/).slice(-6);
          errorDetail = lines.join('\n');
        } catch {}

        return sendSafeChunk(
          ctx,
          `❌ *El proceso de Claude Code se cerró al arrancar*\n\n` +
          `El proceso (PID \`${launch.pid}\`) terminó de forma prematura.\n\n` +
          (errorDetail ? `*Salida de error detectada:*\n\`\`\`\n${errorDetail}\n\`\`\`\n\n` : '') +
          `💡 Abre una terminal en \`${launch.projectPath}\` y ejecuta \`claude\` para aceptar los permisos o diálogo de confianza.`
        );
      }

      let envUrl = null;
      try {
        const logContent = fs.readFileSync(path.join(bridgeDataDirPath(), 'claude-session.log'), 'utf8');
        const match = logContent.match(/https:\/\/claude\.ai\/code\?environment=(env_[a-zA-Z0-9_-]+)/g);
        if (match && match.length > 0) {
          envUrl = match[match.length - 1];
        }
      } catch {}

      const keyboard = new InlineKeyboard();
      if (envUrl) {
        keyboard.url('📲 Abrir en Claude', envUrl).row();
      }
      keyboard.text('🛑 Detener sesión', 'rc_stop');

      const msg = `🚀 *Sesión de Claude Code iniciada con éxito*\n\n` +
        `• *Proyecto:* \`${launch.projectPath}\`\n` +
        `• *Nombre:* \`${launch.sessionName}\`\n` +
        `• *PID:* \`${launch.pid}\`\n` +
        `• *Modo:* \`${launch.spawnMode || 'same-dir'}\`\n\n` +
        (envUrl ? `🔗 [Abrir en Claude App o Web](${envUrl})\n\n` : '') +
        `📲 *Abre la app de Claude* (o pulsa el botón de abajo) y toca en **\`+\` (Nueva sesión)** para comenzar.\n\n` +
        `_Para detenerla más tarde, escribe_ \`/claude stop\` _o pulsa el botón de abajo._`;

      return sendSafeChunk(ctx, msg, { reply_markup: keyboard });
    }

    if (data === 'rc_stop') {
      await ctx.answerCallbackQuery({ text: 'Deteniendo sesión...' });
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}

      const res = stopClaudeRemoteSession();
      const { text, keyboard } = buildStopMessageAndKeyboard(res);
      return sendSafeChunk(ctx, text, keyboard ? { reply_markup: keyboard } : undefined);
    }

    if (data.startsWith('rc_clean:')) {
      const wsId = data.slice('rc_clean:'.length).trim();
      await ctx.answerCallbackQuery({ text: 'Purgando worktrees limpios...' });
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}

      const workspaces = getKnownWorkspaces();
      const ws = workspaces.find((w) => String(w.id) === wsId || String(w.numericId) === wsId);
      if (!ws) {
        return sendSafeChunk(ctx, '⚠️ No se encontró el proyecto asociado a la limpieza.');
      }

      const pruneRes = pruneCleanClaudeWorktrees(ws.path);
      let msg = `🧹 *Limpieza de worktrees completada en ${ws.name}*\n` +
        `• Se eliminaron *${pruneRes.removedCount}* worktree(s) limpios.`;
      if (pruneRes.preservedCount > 0) {
        msg += `\n\n⚠️ *Worktrees conservados por tener cambios o commits:*\n` +
          pruneRes.preservedWorktrees.map((w) => `• Rama: \`${w.branch}\` (${w.reason})`).join('\n');
      }
      return sendSafeChunk(ctx, msg);
    }

    if (data === 'rc_keep') {
      await ctx.answerCallbackQuery({ text: 'Worktrees conservados.' });
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
      return sendSafeChunk(ctx, '📁 *Worktrees temporales conservados sin cambios.*');
    }

    if (data === 'rc_list') {
      await ctx.answerCallbackQuery({ text: 'Cargando workspaces...' });
      const workspaces = getKnownWorkspaces();
      if (workspaces.length === 0) {
        return sendSafeChunk(ctx, '⚠️ No se encontraron workspaces registrados en `~/.claude.json`.');
      }
      const keyboard = buildWorkspacesKeyboard(workspaces);
      const msg = `📱 *Claude Code — Remote Control*\n\nSelecciona el proyecto donde deseas iniciar la sesión interactiva:`;
      try {
        await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: keyboard });
      } catch {
        await sendSafeChunk(ctx, msg, { reply_markup: keyboard });
      }
      return;
    }

    if (data === 'rc_cancel') {
      await ctx.answerCallbackQuery({ text: 'Operación cancelada' });
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch {}
      return ctx.reply('Operación cancelada.');
    }
  });

  // ==============================================================================
  // Mensajes
  // ==============================================================================

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    // Ignorar comandos no reconocidos que empiecen por /
    if (text.startsWith('/')) {
      return ctx.reply('Comando no reconocido. Usa /help para ver las opciones disponibles.');
    }

    // Modo `plan` por defecto: un mensaje mal escrito, un autocorrector o un toque
    // accidental en el historial no debe modificar el repositorio. El paso a
    // escritura es siempre explícito, vía el botón «Ejecutar cambios» del plan
    // o vía /run.
    await dispatchTask(ctx, text, 'plan');
  });

  // Tipos de mensaje sin soporte. Van DESPUÉS de `message:text` para no
  // interceptarlo. Sin ellos, mandar una nota de voz o una foto desde el móvil
  // no producía absolutamente nada: ni respuesta ni error, y desde el teléfono
  // eso es indistinguible de un bridge caído.
  bot.on(['message:voice', 'message:audio', 'message:video_note'], async (ctx) => {
    await ctx.reply('🎙️ Todavía no proceso audio entrante. Envíame la instrucción como texto.');
  });

  bot.on(['message:document', 'message:photo', 'message:video', 'message:sticker'], async (ctx) => {
    await ctx.reply('📎 Todavía no proceso archivos entrantes. Pega el contenido relevante como texto, o dime la ruta del archivo en tu equipo.');
  });

  // ==============================================================================
  // Errores
  // ==============================================================================

  bot.catch((err) => {
    // grammY entrega un BotError que ENVUELVE el error original: el código HTTP
    // vive en err.error.error_code, no en err.error_code. La comprobación
    // anterior era código muerto.
    const inner = err?.error ?? err;
    console.error('[grammY Error]', redactSecrets(err?.message || inner?.message || String(err)));

    if (inner?.error_code === 429) {
      const retryAfter = inner.parameters?.retry_after ?? 5;
      console.warn(`[RATE LIMIT] Telegram 429 (retry_after: ${retryAfter}s). autoRetry reintentará solo.`);
    } else if (inner?.error_code) {
      console.error(`[Telegram API] error_code=${inner.error_code} description="${redactSecrets(inner.description || '')}"`);
    }
  });

  return bot;
}

// ==============================================================================
// 5. Arranque (Long Polling)
// ==============================================================================

function main() {
  // `process.loadEnvFile` existe desde Node 20.12 / 21.7. En una versión anterior
  // no se carga nada y el fallo se manifiesta como «Falta TELEGRAM_BOT_TOKEN»,
  // que apunta al .env en lugar de al runtime.
  if (typeof process.loadEnvFile !== 'function') {
    console.error(`[FATAL] Node ${process.versions.node} es demasiado antiguo: se requiere Node >= 20.12.`);
    console.error('El bridge carga el .env con process.loadEnvFile, disponible desde 20.12 / 21.7.');
    process.exit(1);
  }

  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[FATAL] Falta la variable TELEGRAM_BOT_TOKEN.');
    console.error(describeEnvSearch(envSearch.searched));
    console.error('Parte de telegram-bridge/.env.example para crearlo.');
    process.exit(1);
  }

  const allowedUserIds = parseAllowedUserIds();
  if (allowedUserIds.size === 0) {
    console.warn('[ADVERTENCIA] No se configuró ALLOWED_USER_IDS en .env. Todas las peticiones serán bloqueadas por seguridad.');
  }

  acquireLock();

  // Vigilancia del tamaño de `daemon.log`. Va aquí y no en `daemon.ps1` porque
  // el trigger `AtLogOn` de Task Scheduler arranca el shim directamente, sin
  // pasar por `Invoke-Start`, y porque el escenario que importa —meses sin
  // reiniciar— no lo cubre ningún chequeo de arranque. Ver logrotate.js para
  // por qué se trunca en lugar de renombrar.
  startLogRotation(path.join(__dirname, 'daemon.log'));

  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', redactSecrets(err?.stack || String(err)));
    releaseLock();
    process.exit(1);
  });
  // Node >= 15 termina el proceso ante una promesa rechazada sin manejador. Para un
  // bot de larga duración eso convierte cualquier fallo puntual de red o de la API
  // de Telegram en una caída total: se registra y se sigue sirviendo.
  process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', redactSecrets(reason?.stack || reason?.message || String(reason)));
  });

  const bot = createBot({ token: TELEGRAM_BOT_TOKEN, allowedUserIds });

  console.log('------------------------------------------------------------');
  console.log('🤖 Antigravity Telegram Bridge');
  console.log(`• PID: ${process.pid}`);
  console.log(`• Usuarios autorizados: ${Array.from(allowedUserIds).join(', ') || 'NINGUNO (Modo Bloqueo)'}`);
  console.log('• Chats admitidos: solo privados (grupos y canales se descartan)');
  // Se informa la ruta porque es lo que comparten el bot y notify.js: si ambos
  // no coinciden aquí, el human-in-the-loop no puede resolverse y el síntoma
  // —un ask que nunca se desbloquea— no apunta a su causa.
  console.log(`• Código: ${__dirname}`);
  console.log(`• Credenciales: ${envSearch.loaded || 'ninguna (.env no encontrado)'}`);
  console.log(`• Estado compartido: ${getStateFilePath()}`);
  console.log(`• Workspace: ${resolveWorkspace()}${process.env.WORKSPACE_DIR ? '' : '  (sin WORKSPACE_DIR: es el cwd del proceso)'}`);

  // Sin WORKSPACE_DIR, el workspace es el cwd — y bajo un gestor de servicios
  // ese cwd es la propia carpeta del bridge, porque tanto la unidad de systemd
  // como la tarea programada la fijan como directorio de trabajo. El resultado
  // es que un /run desde el movil opera sobre el codigo del propio puente.
  //
  // No se bloquea: puede ser deliberado, y negarse a arrancar por una
  // configuracion por defecto seria peor. Pero se dice, porque el banner por si
  // solo no delata que esa ruta es el codigo y no un proyecto.
  const ws = resolveWorkspace();
  if (path.resolve(ws) === path.resolve(__dirname) || path.resolve(ws) === path.resolve(__dirname, '..')) {
    console.warn('  ⚠️  Ese workspace es el CODIGO DEL PROPIO BRIDGE.');
    console.warn('      Una tarea lanzada desde Telegram editaria este plugin, no tu proyecto.');
    console.warn('      Fija WORKSPACE_DIR en el .env a un directorio de trabajo acotado.');
  }
  const extraDirs = resolveExtraDirs();
  if (extraDirs.length > 0) {
    console.log(`• Directorios extra: ${extraDirs.join(', ')}`);
  }
  if (!fs.existsSync(resolveWorkspace())) {
    console.error(`[FATAL] El workspace ${resolveWorkspace()} no existe. Créalo o corrige WORKSPACE_DIR en .env.`);
    releaseLock();
    process.exit(1);
  }
  console.log('• Conexión: Long Polling saliente (Compatible con CGNAT)');
  console.log('------------------------------------------------------------');

  // El fallo de arranque SÍ es fatal y debe llevar su propio catch: la red de
  // seguridad `unhandledRejection` está pensada para errores en caliente, y sin
  // esto un token inválido dejaría el proceso vivo pero sordo, sin decir nada.
  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Bot conectado exitosamente como @${botInfo.username}`);
    }
  }).catch((err) => {
    const inner = err?.error ?? err;
    console.error('[FATAL] No se pudo iniciar el long polling:', redactSecrets(inner?.description || err?.message || String(err)));
    if (inner?.error_code === 401) {
      console.error('Token rechazado por Telegram. Revisa TELEGRAM_BOT_TOKEN en telegram-bridge/.env.');
    } else if (inner?.error_code === 409) {
      console.error('Otra instancia está haciendo getUpdates con este mismo token.');
    }
    releaseLock();
    process.exit(1);
  });
}

// Solo arranca si se ejecuta como programa. Importado —por los tests— no hace
// nada más que exportar `createBot`.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
