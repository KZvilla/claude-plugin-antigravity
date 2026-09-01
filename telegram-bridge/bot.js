import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, InlineKeyboard } from 'grammy';
import { runAgyTask, getAgyStatus } from './executor.js';
import { replyWithSmartChunks, formatExecutionMeta } from './formatter.js';
import {
  getConversationId,
  setConversationId,
  clearConversationId,
  resolvePendingAsk,
  getPendingAsk
} from './state.js';
import { enqueueTask, dequeueTask, getQueueLength } from './queue.js';

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

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (lockPid && !isNaN(lockPid)) {
        // Verificar si el proceso con ese PID sigue corriendo
        try {
          process.kill(lockPid, 0); // Señal 0 comprueba existencia sin matar
          console.error(`[LOCK ERROR] Ya existe otra instancia del bot en ejecución (PID: ${lockPid}).`);
          console.error('Telegram rechaza múltiples peticiones getUpdates concurrentes (HTTP 409 Conflict).');
          process.exit(1);
        } catch (e) {
          // El PID no existe (cierre abrupto previo), sobreescribir lock
          console.log(`[lock] Se encontró un lockfile huérfano del PID ${lockPid}. Adquiriendo nuevo lock.`);
        }
      }
    } catch {}
  }

  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (lockPid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
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
let isProcessingTask = false;

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
  const { ctx, chatId, prompt, mode, conversationId } = task;

  // Intervalo de acción typing mientras piensa Antigravity
  let typingInterval = null;
  try {
    await bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4500);

    const result = await runAgyTask({
      prompt,
      mode,
      conversationId
    });

    clearInterval(typingInterval);
    typingInterval = null;

    if (result.success) {
      if (result.conversationId) {
        setConversationId(chatId, result.conversationId);
      }

      const meta = formatExecutionMeta(result.data, result.durationSeconds, result.conversationId, mode);
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
async function dispatchTask(ctx, prompt, mode = 'accept-edits', forceConvId = null) {
  const chatId = ctx.chat.id;
  const activeConvId = forceConvId !== null ? forceConvId : getConversationId(chatId);

  if (isProcessingTask) {
    const pos = enqueueTask({ ctx, chatId, prompt, mode, conversationId: activeConvId });
    await ctx.reply(`⏳ Antigravity está ocupado con otra tarea. Tu solicitud ha sido encolada en la posición #${pos}.`);
    return;
  }

  // Despachar inmediatamente
  enqueueTask({ ctx, chatId, prompt, mode, conversationId: activeConvId });
  await ctx.reply(mode === 'plan' ? '🧠 Generando plan arquitectónico...' : '⚙️ Ejecutando tarea con Antigravity...');
  runQueue();
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
• \`/run <instrucción>\` — Ejecuta tareas permitiendo edición de código y tests.
• \`/resume <instrucción>\` — Continúa la sesión de trabajo actual.
• \`/status\` — Consulta estado del binario, versión y sesión activa.
• \`/reset\` — Reinicia la conversación y olvida el contexto actual.

*Sesión activa:* ${convId ? `\`${convId}\`` : '_Ninguna (el próximo mensaje abrirá una nueva)_'}

_También puedes escribir tu consulta directamente como texto común y se ejecutará en la sesión activa._`;

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  const status = getAgyStatus();
  const convId = getConversationId(ctx.chat.id);
  const queueLen = getQueueLength();

  const msg = `📊 *Estado del Sistema Antigravity*
• *Binario:* \`${status.binPath}\`
• *Versión:* \`${status.version}\`
• *Workspace:* \`${status.workspaceDir}\`
• *Sesión chat:* ${convId ? `\`${convId}\`` : '_Sin conversación activa_'}
• *Cola de tareas:* ${queueLen} pendientes (Procesando: ${isProcessingTask ? 'Sí' : 'No'})
• *Comandos prohibidos:* \`${status.denyCommands.join(', ')}\`
• *Rutas protegidas:* \`${status.denyPaths.join(', ')}\``;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('reset', async (ctx) => {
  clearConversationId(ctx.chat.id);
  await ctx.reply('🔄 Contexto de conversación reiniciado. Tu próximo mensaje iniciará una nueva sesión en blanco.');
});

bot.command('plan', async (ctx) => {
  const prompt = ctx.match?.trim();
  if (!prompt) {
    return ctx.reply('⚠️ Por favor indica la tarea a planificar. Ejemplo:\n`/plan Analizar el sistema de login y proponer refactor`', { parse_mode: 'Markdown' });
  }
  await dispatchTask(ctx, prompt, 'plan');
});

bot.command('run', async (ctx) => {
  const prompt = ctx.match?.trim();
  if (!prompt) {
    return ctx.reply('⚠️ Por favor indica la tarea a ejecutar. Ejemplo:\n`/run Corregir los imports en index.js`', { parse_mode: 'Markdown' });
  }
  await dispatchTask(ctx, prompt, 'accept-edits');
});

bot.command('resume', async (ctx) => {
  const prompt = ctx.match?.trim();
  if (!prompt) {
    return ctx.reply('⚠️ Por favor indica qué deseas continuar en la sesión. Ejemplo:\n`/resume Ahora ejecuta las pruebas unitarias`', { parse_mode: 'Markdown' });
  }
  await dispatchTask(ctx, prompt, 'accept-edits');
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

    if (pending && pending.options && pending.options[optionIndex] !== undefined) {
      const selected = pending.options[optionIndex];
      resolvePendingAsk(askId, selected, ctx.from?.id);
      await ctx.answerCallbackQuery({ text: `Seleccionaste: ${selected}` });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {}
      await ctx.reply(`🔘 *Respuesta registrada:* \`${selected}\`\nEl agente continuará su tarea en tu equipo.`, { parse_mode: 'Markdown' });
    } else {
      await ctx.answerCallbackQuery({ text: 'Esta consulta ya no está activa o expiró.' });
    }
    return;
  }

  if (data.startsWith('exec_plan:')) {
    const convId = data.replace('exec_plan:', '');
    await ctx.answerCallbackQuery({ text: 'Aprobado: Iniciando ejecución...' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }); // Quitar botones
    await ctx.reply('🚀 *Plan Aprobado*: Procediendo a implementar los cambios...', { parse_mode: 'Markdown' });

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

  await dispatchTask(ctx, text, 'accept-edits');
});

// ==============================================================================
// 5. Gestión de Errores Globales y Arranque (Long Polling)
// ==============================================================================
bot.catch((err) => {
  console.error('[grammY Error]', err.message);
  if (err.error_code === 429) {
    console.warn(`[RATE LIMIT] Telegram 429. Esperando ${err.parameters?.retry_after || 5}s...`);
  }
});

console.log('------------------------------------------------------------');
console.log('🤖 Antigravity Telegram Bridge');
console.log(`• PID: ${process.pid}`);
console.log(`• Usuarios autorizados: ${Array.from(ALLOWED_USER_IDS).join(', ') || 'NINGUNO (Modo Bloqueo)'}`);
console.log(`• Workspace: ${process.env.WORKSPACE_DIR || path.resolve(__dirname, '..')}`);
console.log('• Conexión: Long Polling saliente (Compatible con CGNAT)');
console.log('------------------------------------------------------------');

bot.start({
  onStart: (botInfo) => {
    console.log(`✅ Bot conectado exitosamente como @${botInfo.username}`);
  }
});
