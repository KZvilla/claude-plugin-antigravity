import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { runAgyTask, getAgyStatus, resolveWorkspace, resolveExtraDirs } from './executor.js';
import { replyWithSmartChunks, formatExecutionMeta, sendSafeChunk, formatElapsed, finalProgressLabel } from './formatter.js';
import { redactSecrets } from './policy.js';
import { startLogRotation } from './logrotate.js';
import { resolveDataFile, legacyDataFile, loadBridgeEnv, describeEnvSearch } from './paths.js';
import {
  getConversationId,
  setConversationId,
  clearConversationId,
  resolvePendingAsk,
  getPendingAsk,
  getStateFilePath
} from './state.js';
import { enqueueTask, dequeueTask, getQueueLength, getQueueSnapshot, clearQueue } from './queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
// 3. Estado de ejecución (Concurrency = 1)
// ==============================================================================

let isProcessingTask = false;
// Tarea en ejecución y forma de abortarla. `cancelCurrent` lo entrega el
// executor al lanzar el proceso hijo.
let currentTask = null;
let cancelCurrent = null;
// Bot activo del proceso. Lo necesitan `notifyChat` y el consumidor de la cola,
// que operan fuera de cualquier `Context` vivo.
let botRef = null;

/**
 * Reinicia el estado de ejecución. Solo para los tests: cada caso necesita
 * partir de una cola vacía y sin tarea en curso.
 */
export function resetRuntimeState() {
  isProcessingTask = false;
  currentTask = null;
  cancelCurrent = null;
  clearQueue();
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
 * Arranca el consumidor de la cola sin devolver una promesa pendiente al
 * llamante. Todo fallo queda contenido aquí.
 */
function runQueue() {
  processTaskQueue().catch((err) => {
    console.error('[QUEUE ERROR]', redactSecrets(err?.stack || err?.message || String(err)));
  });
}

/**
 * Procesa la cola de tareas secuencialmente
 */
async function processTaskQueue() {
  if (isProcessingTask) return;
  const task = dequeueTask();
  if (!task) return;

  isProcessingTask = true;
  currentTask = task;
  const { ctx, chatId, prompt, mode, conversationId } = task;

  // Intervalo de acción typing mientras piensa Antigravity
  const startedAt = Date.now();
  let typingInterval = null;
  let progressInterval = null;

  // Un único mensaje de estado que se va editando. Para una tarea de 2 a 15
  // minutos, `typing` cada 4,5 s no dice si algo avanza o si se colgó.
  const updateProgress = async (prefix, separador = ' · ') => {
    if (!task.statusMessageId) return;
    const texto = `${prefix}${separador}${formatElapsed((Date.now() - startedAt) / 1000)}`;
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

    const etiqueta = mode === 'plan' ? '🧠 Generando plan' : '⚙️ Ejecutando tarea';
    await updateProgress(etiqueta);
    progressInterval = setInterval(() => { updateProgress(etiqueta); }, 15000);

    const result = await runAgyTask({
      prompt,
      mode,
      conversationId,
      onSpawn: (cancel) => { cancelCurrent = cancel; }
    });

    clearInterval(typingInterval);
    typingInterval = null;
    clearInterval(progressInterval);
    progressInterval = null;

    // El separador « · » es para el mensaje vivo («Generando plan · 23s»); el
    // texto final ya lleva su propia preposición y quedaba «Completado en · 23s».
    // Una cancelación no es éxito, pero tampoco un error: sin su propia etiqueta
    // se anunciaba como «Terminado con error» y parecía que algo había fallado.
    await updateProgress(finalProgressLabel(result), ' ');

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

        await replyWithSmartChunks(ctx, fullResponse, { reply_markup: keyboard });
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
    cancelCurrent = null;
    currentTask = null;
    isProcessingTask = false;
    // Si quedan tareas en cola, procesar la siguiente
    if (getQueueLength() > 0) {
      setImmediate(runQueue);
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
    return mode === 'plan'
      ? '🧠 Generando plan arquitectónico...'
      : '⚙️ Ejecutando tarea con Antigravity...';
  }
  const posicion = posEnCola + (habiaTareaEnCurso ? 1 : 0);
  return `⏳ Antigravity está ocupado con otra tarea. Tu solicitud queda en la posición #${posicion}.`;
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
  const task = { ctx, chatId, prompt, mode, conversationId: activeConvId, statusMessageId: null };

  const habiaTareaEnCurso = isProcessingTask;
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

  // Incondicional a propósito. `processTaskQueue` ya se protege con
  // `if (isProcessingTask) return`, así que llamarlo de más no cuesta nada,
  // mientras que llamarlo de menos deja la cola parada sin nadie que la drene.
  runQueue();
}

// ==============================================================================
// 4. Construcción del bot
// ==============================================================================

/**
 * Construye el bot con todos sus handlers registrados. No abre conexiones ni
 * toca el lockfile: eso es cosa de `main()`.
 */
export function createBot({
  token = process.env.TELEGRAM_BOT_TOKEN,
  allowedUserIds = parseAllowedUserIds()
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
• \`/status\` — Consulta estado del binario, versión, sesión activa y política de permisos.
• \`/queue\` — Muestra la tarea en curso y las encoladas.
• \`/cancel\` — Aborta la tarea en curso y vacía la cola.
• \`/reset\` — Reinicia la conversación y olvida el contexto actual.

*Sesión activa:* ${convId ? `\`${convId}\`` : '_Ninguna (el próximo mensaje abrirá una nueva)_'}

_El texto suelto se ejecuta en modo \`plan\` sobre la sesión activa: primero verás qué se haría y decides con el botón «Ejecutar cambios». Para escribir directamente sin ese paso, usa \`/run\`._`;

    await sendSafeChunk(ctx, helpText);
  });

  bot.command('status', async (ctx) => {
    const status = getAgyStatus();
    const convId = getConversationId(ctx.chat.id);
    const queueLen = getQueueLength();

    const msg = `📊 *Estado del Sistema Antigravity*
• *Binario:* \`${status.binPath}\`
• *Versión:* \`${status.version}\`
• *Workspace:* \`${status.workspaceDir}\`
${status.extraDirs.length > 0 ? `• *Directorios extra:* \`${status.extraDirs.join(', ')}\`
` : ''}
• *Sesión chat:* ${convId ? `\`${convId}\`` : '_Sin conversación activa_'}
• *Cola de tareas:* ${queueLen} pendientes (Procesando: ${isProcessingTask ? 'Sí' : 'No'})

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

  bot.command('cancel', async (ctx) => {
    const discarded = clearQueue();
    const cancelled = typeof cancelCurrent === 'function' ? cancelCurrent() : false;

    if (!cancelled && discarded === 0) {
      return ctx.reply('No hay ninguna tarea en curso ni encolada que cancelar.');
    }

    const partes = [];
    if (cancelled) partes.push('tarea en curso abortada (cierre del árbol de procesos, forzado si no responde)');
    if (discarded > 0) partes.push(`${discarded} tarea(s) encolada(s) descartada(s)`);
    await ctx.reply(`🛑 Cancelado: ${partes.join(' y ')}.`);
  });

  bot.command('queue', async (ctx) => {
    const pending = getQueueSnapshot();

    if (!currentTask && pending.length === 0) {
      return ctx.reply('📭 No hay nada en curso ni en cola.');
    }

    const lineas = [];
    if (currentTask) {
      lineas.push(`▶️ *En curso* (modo \`${currentTask.mode}\`, desde ${currentTask.enqueuedAt})`);
      lineas.push(`   ${currentTask.prompt.slice(0, 80)}`);
    }
    pending.forEach((t, i) => {
      lineas.push(`${i + 1}. modo \`${t.mode}\` — ${t.promptPreview}`);
    });
    lineas.push('');
    lineas.push("_Usa_ `/cancel` _para abortar lo actual y vaciar la cola._");

    await sendSafeChunk(ctx, lineas.join('\n'));
  });

  // ==============================================================================
  // Botones interactivos (Inline Keyboards)
  // ==============================================================================

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('ask:')) {
      // Formato: ask:<askId>:<optionIndex>
      const parts = data.split(':');
      const askId = parts[1];
      const optionIndex = parseInt(parts[2], 10);
      const pending = getPendingAsk(askId);

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
