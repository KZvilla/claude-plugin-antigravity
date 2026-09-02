import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { runAgyTask, getAgyStatus, resolveWorkspace, resolveExtraDirs } from './executor.js';
import { replyWithSmartChunks, formatExecutionMeta, sendSafeChunk, formatElapsed } from './formatter.js';
import {
  getConversationId,
  setConversationId,
  clearConversationId,
  resolvePendingAsk,
  getPendingAsk
} from './state.js';
import { enqueueTask, dequeueTask, getQueueLength, getQueueSnapshot, clearQueue } from './queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==============================================================================
// 1. Carga de Variables de Entorno (.env)
// ==============================================================================
const envLocal = path.join(__dirname, '.env');
const envRoot = path.join(__dirname, '..', '.env');

if (fs.existsSync(envLocal)) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envLocal);
  }
} else if (fs.existsSync(envRoot)) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envRoot);
  }
}

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
  console.error('[FATAL] Falta la variable TELEGRAM_BOT_TOKEN en el archivo .env.');
  console.error('Por favor copia telegram-bridge/.env.example a telegram-bridge/.env y configura tu token.');
  process.exit(1);
}

// Configuración de lista de IDs autorizados (Whitelist estricta)
const rawAllowedIds = process.env.ALLOWED_USER_IDS || '';
const ALLOWED_USER_IDS = new Set(
  rawAllowedIds.split(',').map((id) => id.trim()).filter(Boolean)
);

if (ALLOWED_USER_IDS.size === 0) {
  console.warn('[ADVERTENCIA] No se configuró ALLOWED_USER_IDS en .env. Todas las peticiones serán bloqueadas por seguridad.');
}

// ==============================================================================
// 2. Lockfile de Instancia Única (Previene 409 Conflict en Telegram getUpdates)
// ==============================================================================
const LOCK_FILE = path.join(__dirname, 'bridge.lock');

/**
 * Lee el lockfile en el formato actual (JSON con metadatos) o en el legado
 * (solo el PID en texto). Devuelve null si no hay lock legible.
 */
function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
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
  const lock = readLock();

  if (lock) {
    const sameBoot = lock.bootId !== null && lock.bootId === currentBootId();
    let alive = false;
    try {
      process.kill(lock.pid, 0); // Señal 0 comprueba existencia sin matar
      alive = true;
    } catch {}

    if (alive && sameBoot) {
      console.error(`[LOCK ERROR] Ya existe otra instancia del bot en ejecución (PID: ${lock.pid}, desde ${lock.startedAt || 'desconocido'}).`);
      console.error('Telegram rechaza múltiples peticiones getUpdates concurrentes (HTTP 409 Conflict).');
      process.exit(1);
    }

    if (alive) {
      console.log(`[lock] El PID ${lock.pid} existe pero es de otra sesión del sistema (PID reciclado). Adquiriendo nuevo lock.`);
    } else {
      console.log(`[lock] Se encontró un lockfile huérfano del PID ${lock.pid}. Adquiriendo nuevo lock.`);
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
  try {
    const lock = readLock();
    if (lock && lock.pid === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

acquireLock();
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  releaseLock();
  process.exit(1);
});
// Node >= 15 termina el proceso ante una promesa rechazada sin manejador. Para un
// bot de larga duración eso convierte cualquier fallo puntual de red o de la API
// de Telegram en una caída total: se registra y se sigue sirviendo.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ==============================================================================
// 3. Inicialización del Bot e Infraestructura de Cola (Concurrency = 1)
// ==============================================================================
const bot = new Bot(TELEGRAM_BOT_TOKEN);

// Respeta `retry_after` de Telegram de forma transparente en cada llamada a la
// API. Sin esto, un 429 se propaga como error de la tarea y el usuario pierde
// la respuesta por una limitación temporal de tasa.
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

let isProcessingTask = false;
// Tarea en ejecución y forma de abortarla. `cancelCurrent` lo entrega el
// executor al lanzar el proceso hijo.
let currentTask = null;
let cancelCurrent = null;

// Whitelist Middleware: descarta cualquier mensaje no autorizado silenciosamente
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !ALLOWED_USER_IDS.has(String(userId))) {
    console.warn(`[SEGURIDAD] Petición no autorizada descartada: ID ${userId} (@${ctx.from?.username || 'sin_alias'})`);
    return; // Silent drop
  }
  await next();
});

/**
 * Envía un mensaje por `bot.api` sin depender de un `Context` vivo y sin lanzar
 * nunca. Es la vía de reporte de errores: si el fallo original fue justamente el
 * `ctx`, usar `ctx.reply` para avisar lo enmascara y tumba el proceso.
 */
async function notifyChat(chatId, text, extra = {}) {
  try {
    return await bot.api.sendMessage(chatId, text, extra);
  } catch (err) {
    if (extra.parse_mode) {
      // Reintento en texto plano: el fallo puede venir del parser de Markdown.
      try {
        return await bot.api.sendMessage(chatId, text, { ...extra, parse_mode: undefined });
      } catch (plainErr) {
        console.error(`[NOTIFY ERROR] chat ${chatId}: ${plainErr.message}`);
        return null;
      }
    }
    console.error(`[NOTIFY ERROR] chat ${chatId}: ${err.message}`);
    return null;
  }
}

/**
 * Arranca el consumidor de la cola sin devolver una promesa pendiente al
 * llamante. Todo fallo queda contenido aquí.
 */
function runQueue() {
  processTaskQueue().catch((err) => {
    console.error('[QUEUE ERROR]', err);
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
      await bot.api.editMessageText(chatId, task.statusMessageId, texto);
    } catch {
      // «message is not modified» y el mensaje borrado por el usuario son
      // esperables; ninguno merece ruido.
    }
  };

  try {
    await bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {});
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
    await updateProgress(result.success ? '✅ Completado en' : '⚠️ Terminado con error tras', ' ');

    if (result.cancelled) {
      // El aviso ya lo dio /cancel; aquí solo se cierra el ciclo.
      console.log('[task] Tarea cancelada por el usuario.');
    } else if (result.success) {
      if (result.conversationId) {
        setConversationId(chatId, result.conversationId);
      }

      const meta = formatExecutionMeta(result.data, result.durationSeconds, result.conversationId, mode, result.sessionSeconds);
      const fullResponse = result.responseText + meta;

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
      let errMsg = `❌ *Error al ejecutar la tarea en Antigravity:*\n\n${result.error}`;
      if (result.conversationId) {
        errMsg += `\n\n*ID de conversación activa:* \`${result.conversationId}\``;
      }
      await notifyChat(chatId, errMsg, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('[TASK ERROR]', err);
    await notifyChat(chatId, `❌ Ocurrió un error inesperado al procesar la tarea: ${err.message}`);
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

  const encolada = isProcessingTask;
  const pos = enqueueTask(task);

  // El mensaje inicial es el que luego se edita con el tiempo transcurrido, así
  // que se guarda su id en la propia tarea.
  const aviso = encolada
    ? `⏳ Antigravity está ocupado con otra tarea. Tu solicitud queda en la posición #${pos}.`
    : (mode === 'plan' ? '🧠 Generando plan arquitectónico...' : '⚙️ Ejecutando tarea con Antigravity...');

  try {
    const sent = await ctx.reply(aviso);
    task.statusMessageId = sent?.message_id ?? null;
  } catch (err) {
    console.error(`[dispatch] No se pudo enviar el aviso inicial: ${err.message}`);
  }

  if (!encolada) runQueue();
}

// ==============================================================================
// 4. Comandos del Bot
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

🔒 *Controles efectivos* (los impone el CLI)
• *Sandbox de terminal:* ${status.enforcement.sandbox ? '`activo`' : '`inactivo` — actívalo con `AGY_SANDBOX=true`'}
• *Aprobación de herramientas:* \`--dangerously-skip-permissions\` (auto-aprobada)
• *Texto libre:* entra en modo \`plan\`; escribir requiere pulsar «Ejecutar cambios»

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
  if (cancelled) partes.push('tarea en curso abortada (SIGTERM, y SIGKILL si no responde)');
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

// Manejador de botones interactivos (Inline Keyboards)
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
      resolvePendingAsk(askId, selected, ctx.from?.id);
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
    const convId = data.replace('exec_plan:', '');
    await ctx.answerCallbackQuery({ text: 'Aprobado: Iniciando ejecución...' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }); // Quitar botones
    await sendSafeChunk(ctx, '🚀 *Plan Aprobado*: Procediendo a implementar los cambios...');

    await dispatchTask(
      ctx,
      'Procede a implementar de forma concreta todos los cambios y pasos acordados en el plan anterior.',
      'accept-edits',
      convId
    );
  } else if (data === 'cancel_plan') {
    await ctx.answerCallbackQuery({ text: 'Plan descartado' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.reply('🗑️ Plan descartado. Puedes enviar una nueva solicitud cuando desees.');
  }
});

// Manejador para mensajes de texto genéricos (ejecución directa)
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

// ==============================================================================
// 5. Gestión de Errores Globales y Arranque (Long Polling)
// ==============================================================================
bot.catch((err) => {
  // grammY entrega un BotError que ENVUELVE el error original: el código HTTP
  // vive en err.error.error_code, no en err.error_code. La comprobación
  // anterior era código muerto.
  const inner = err?.error ?? err;
  console.error('[grammY Error]', err?.message || inner?.message || err);

  if (inner?.error_code === 429) {
    const retryAfter = inner.parameters?.retry_after ?? 5;
    console.warn(`[RATE LIMIT] Telegram 429 (retry_after: ${retryAfter}s). autoRetry reintentará solo.`);
  } else if (inner?.error_code) {
    console.error(`[Telegram API] error_code=${inner.error_code} description="${inner.description || ''}"`);
  }
});

console.log('------------------------------------------------------------');
console.log('🤖 Antigravity Telegram Bridge');
console.log(`• PID: ${process.pid}`);
console.log(`• Usuarios autorizados: ${Array.from(ALLOWED_USER_IDS).join(', ') || 'NINGUNO (Modo Bloqueo)'}`);
console.log(`• Workspace: ${resolveWorkspace()}${process.env.WORKSPACE_DIR ? '' : '  (sin WORKSPACE_DIR: es el cwd del proceso)'}`);
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
  console.error('[FATAL] No se pudo iniciar el long polling:', inner?.description || err?.message || err);
  if (inner?.error_code === 401) {
    console.error('Token rechazado por Telegram. Revisa TELEGRAM_BOT_TOKEN en telegram-bridge/.env.');
  } else if (inner?.error_code === 409) {
    console.error('Otra instancia está haciendo getUpdates con este mismo token.');
  }
  releaseLock();
  process.exit(1);
});
