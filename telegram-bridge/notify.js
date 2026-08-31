#!/usr/bin/env node

/**
 * Módulo cliente para envío de notificaciones salientes de Entorno ➔ Teléfono (Telegram).
 * Permite enviar texto, alertas de error, notas de voz de Voicebox y preguntas interactivas (Human-in-the-Loop).
 * Funciona de forma autónoma vía HTTPS nativo (fetch) con cero dependencias externas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPendingAsk, getPendingAsk } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Carga de Variables de Entorno
const envLocal = path.join(__dirname, '.env');
const envRoot = path.join(__dirname, '..', '.env');

if (fs.existsSync(envLocal)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(envLocal);
} else if (fs.existsSync(envRoot)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(envRoot);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const rawAllowedIds = process.env.ALLOWED_USER_IDS || '';
const ALLOWED_USER_IDS = rawAllowedIds.split(',').map(s => s.trim()).filter(Boolean);

/**
 * Obtiene el Chat ID por defecto (el primer ID autorizado)
 */
export function getDefaultChatId(targetChatId = null) {
  if (targetChatId) return String(targetChatId);
  if (ALLOWED_USER_IDS.length > 0) return ALLOWED_USER_IDS[0];
  throw new Error('No hay usuarios configurados en ALLOWED_USER_IDS ni se especificó un targetChatId.');
}

/**
 * Envía una petición JSON al Telegram Bot API
 */
async function telegramApiCall(method, payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('Falta TELEGRAM_BOT_TOKEN en el entorno.');
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error (${method}): ${data.description || 'Desconocido'}`);
  }
  return data.result;
}

/**
 * Envía un archivo binario (multipart/form-data) al Telegram Bot API
 */
async function telegramUploadCall(method, fieldName, filePath, extraParams = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('Falta TELEGRAM_BOT_TOKEN en el entorno.');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Archivo no encontrado: ${filePath}`);
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const formData = new FormData();

  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null) {
      formData.append(key, String(value));
    }
  }

  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const blob = new Blob([buffer]);
  formData.append(fieldName, blob, fileName);

  const res = await fetch(url, {
    method: 'POST',
    body: formData
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API upload error (${method}): ${data.description || 'Desconocido'}`);
  }
  return data.result;
}

/**
 * 1. Envía una notificación push estándar de texto con nivel de severidad
 */
export async function sendTelegramNotification(options = {}) {
  const {
    title,
    message,
    level = 'info', // 'info' | 'success' | 'warning' | 'error'
    filePath = null,
    targetChatId = null
  } = typeof options === 'string' ? { message: options } : options;

  const chatId = getDefaultChatId(targetChatId);

  const icons = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '🚨'
  };

  const icon = icons[level] || 'ℹ️';
  let formattedText = '';
  if (title) {
    formattedText += `${icon} *${title}*\n\n`;
  } else {
    formattedText += `${icon} `;
  }
  formattedText += message;

  // Si se adjunta un archivo, enviarlo como documento con caption
  if (filePath && fs.existsSync(filePath)) {
    return await telegramUploadCall('sendDocument', 'document', filePath, {
      chat_id: chatId,
      caption: formattedText.slice(0, 1024),
      parse_mode: 'Markdown'
    });
  }

  try {
    return await telegramApiCall('sendMessage', {
      chat_id: chatId,
      text: formattedText,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    // Degradación a texto plano si hay caracteres no escapados en Markdown
    return await telegramApiCall('sendMessage', {
      chat_id: chatId,
      text: formattedText
    });
  }
}

/**
 * 2. Envía un archivo de audio o nota de voz a Telegram
 */
export async function sendTelegramVoice(options = {}) {
  const {
    audioPath,
    caption = '🎙️ Nota de voz de Voicebox',
    targetChatId = null,
    waitForGeneration = false,
    generationId = null,
    beforeFiles = [],
    timeoutMs = 90000
  } = typeof options === 'string' ? { audioPath: options } : options;

  const chatId = getDefaultChatId(targetChatId);
  let resolvedPath = audioPath;
  // Solo se borra el .wav si esta función lo resolvió ella misma dentro de
  // generations/ (waitForVoiceboxGeneration) — nunca si vino como audioPath
  // explícito (podría ser cualquier archivo del caller) ni si cayó al fallback
  // findLatestVoiceboxAudio(), que también busca en profiles/ (muestras de voz
  // clonada, no generaciones descartables).
  const selfResolvedGeneration = !audioPath && (waitForGeneration || generationId);

  if (!resolvedPath && (waitForGeneration || generationId)) {
    resolvedPath = await waitForVoiceboxGeneration({
      generationId,
      beforeFiles,
      timeoutMs
    });
  } else if (!resolvedPath) {
    resolvedPath = findLatestVoiceboxAudio();
  }

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(`No se encontró ningún archivo de audio en: ${resolvedPath || '(ninguno)'}`);
  }

  // Intentar primero como Nota de Voz nativa (sendVoice)
  let uploadResult;
  try {
    uploadResult = await telegramUploadCall('sendVoice', 'voice', resolvedPath, {
      chat_id: chatId,
      caption,
      parse_mode: 'Markdown'
    });
  } catch (voiceErr) {
    console.warn(`[notify] sendVoice falló (${voiceErr.message}). Intentando sendAudio como fallback...`);
    // Fallback a reproductor de audio integrado (sendAudio) para archivos .wav
    uploadResult = await telegramUploadCall('sendAudio', 'audio', resolvedPath, {
      chat_id: chatId,
      caption,
      parse_mode: 'Markdown',
      title: path.basename(resolvedPath, path.extname(resolvedPath)),
      performer: 'Voicebox'
    });
  }

  // Limpieza: generations/ crece sin límite si nadie borra lo ya entregado.
  if (selfResolvedGeneration) {
    try {
      fs.unlinkSync(resolvedPath);
    } catch (delErr) {
      console.warn(`[notify] No se pudo borrar ${resolvedPath}: ${delErr.message}`);
    }
  }

  return uploadResult;
}

/**
 * 3. Pregunta interactiva Human-in-the-Loop (Espera respuesta desde el móvil)
 */
export async function askTelegramQuestion(options = {}) {
  const {
    question,
    options: choices = ['Aprobar', 'Rechazar'],
    timeoutSeconds = 300,
    targetChatId = null
  } = options;

  if (!question) throw new Error('Se requiere el parámetro "question".');
  const chatId = getDefaultChatId(targetChatId);
  const askId = 'ask_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

  // Construir teclado en línea
  const inlineKeyboard = [
    choices.map((label, index) => ({
      text: label,
      callback_data: `ask:${askId}:${index}`
    }))
  ];

  const text = `❓ *Consulta de Decisión (Human-in-the-loop)*\n\n${question}\n\n_Elige una opción desde tu móvil para autorizar o continuar:_`;

  const sentMsg = await telegramApiCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  });

  registerPendingAsk(askId, {
    question,
    options: choices,
    chatId,
    messageId: sentMsg.message_id
  });

  console.log(`[notify] Esperando respuesta del usuario para consulta "${askId}" (${timeoutSeconds}s máx)...`);

  // Bucle de espera no bloqueante
  const startTime = Date.now();
  const maxWaitMs = timeoutSeconds * 1000;

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const ask = getPendingAsk(askId);
      if (ask && ask.status === 'answered') {
        clearInterval(interval);
        resolve({
          answered: true,
          selected: ask.answer,
          answeredBy: ask.answeredBy,
          answeredAt: ask.answeredAt
        });
        return;
      }

      if (Date.now() - startTime >= maxWaitMs) {
        clearInterval(interval);
        // Quitar botones de Telegram por expiración
        try {
          telegramApiCall('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: sentMsg.message_id,
            reply_markup: { inline_keyboard: [] }
          }).catch(() => {});
        } catch {}

        resolve({
          answered: false,
          selected: null,
          error: `Tiempo de espera agotado (${timeoutSeconds}s) sin respuesta desde Telegram.`
        });
      }
    }, 1000);
  });
}

/**
 * 4. Localiza el archivo de audio más reciente generado por Voicebox
 */
export function findLatestVoiceboxAudio() {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const appDataRoaming = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const vbBase = path.join(appDataRoaming, 'sh.voicebox.app');

  const candidatesDirs = [
    path.join(vbBase, 'captures'),
    path.join(vbBase, 'generations')
  ];

  let latestFile = null;
  let latestMtime = 0;

  for (const dir of candidatesDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.wav') || file.endsWith('.ogg') || file.endsWith('.mp3')) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs > latestMtime) {
              latestMtime = stat.mtimeMs;
              latestFile = fullPath;
            }
          }
        }
      } catch {}
    }
  }

  // Fallback: si aún no hay grabaciones en captures o generations, buscar muestras en profiles
  if (!latestFile) {
    const profilesDir = path.join(vbBase, 'profiles');
    if (fs.existsSync(profilesDir)) {
      try {
        const subdirs = fs.readdirSync(profilesDir);
        for (const sub of subdirs) {
          const subPath = path.join(profilesDir, sub);
          if (fs.statSync(subPath).isDirectory()) {
            const files = fs.readdirSync(subPath);
            for (const file of files) {
              if (file.endsWith('.wav') || file.endsWith('.ogg') || file.endsWith('.mp3')) {
                const fullPath = path.join(subPath, file);
                const stat = fs.statSync(fullPath);
                if (stat.mtimeMs > latestMtime) {
                  latestMtime = stat.mtimeMs;
                  latestFile = fullPath;
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  return latestFile;
}

/**
 * 5. Obtiene la lista actual de archivos en la carpeta de generaciones de Voicebox (Snapshot)
 */
export function getVoiceboxGenerationsSnapshot() {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const appDataRoaming = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const genDir = path.join(appDataRoaming, 'sh.voicebox.app', 'generations');
  if (fs.existsSync(genDir)) {
    try {
      return fs.readdirSync(genDir);
    } catch {}
  }
  return [];
}

/**
 * 6. Espera de forma no bloqueante a que Voicebox termine de sintetizar y escribir el audio (.wav)
 */
export async function waitForVoiceboxGeneration(options = {}) {
  const {
    generationId,
    beforeFiles = [],
    timeoutMs = 90000
  } = options;

  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const appDataRoaming = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const genDir = path.join(appDataRoaming, 'sh.voicebox.app', 'generations');

  const beforeSet = new Set(beforeFiles);
  const startTime = Date.now();
  const targetFileById = generationId ? path.join(genDir, `${generationId}.wav`) : null;

  while (Date.now() - startTime < timeoutMs) {
    // 1. Detección directa por ID único de Voicebox
    if (targetFileById && fs.existsSync(targetFileById)) {
      try {
        const stat = fs.statSync(targetFileById);
        if (stat.size > 2000) {
          await new Promise(r => setTimeout(r, 400));
          return targetFileById;
        }
      } catch {}
    }

    // 2. FIFO / Snapshot Fallback: Nuevo archivo aparecido en generations/
    if (fs.existsSync(genDir)) {
      try {
        const currentFiles = fs.readdirSync(genDir);
        for (const file of currentFiles) {
          if ((file.endsWith('.wav') || file.endsWith('.ogg') || file.endsWith('.mp3')) && !beforeSet.has(file)) {
            const fullPath = path.join(genDir, file);
            const stat = fs.statSync(fullPath);
            if (stat.size > 2000) {
              await new Promise(r => setTimeout(r, 400));
              return fullPath;
            }
          }
        }
      } catch {}
    }

    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error(`Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s) sin completarse el audio en Voicebox.`);
}

// 7. Ejecución como script CLI directo
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = args[0];

  if (!flag || flag === '--help' || flag === '-h') {
    console.log(`
Uso de notify.js:
  node notify.js "Mensaje a enviar"
  node notify.js --success "Build completado" "Todos los tests pasaron"
  node notify.js --error "Fallo en tests" "Error en auth.spec.js"
  node notify.js --voice [ruta_al_audio.wav]
  node notify.js --ask "¿Deseas aplicar los cambios?" "Aprobar,Rechazar"
`);
    process.exit(0);
  }

  async function readPayloadInput(rawArg) {
    if (rawArg && rawArg !== '-') {
      return JSON.parse(rawArg);
    }
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const full = Buffer.concat(chunks).toString('utf8').trim();
    return JSON.parse(full || '{}');
  }

  (async () => {
    try {
      if (flag === '--notify-json') {
        const payload = await readPayloadInput(args[1]);
        const res = await sendTelegramNotification(payload);
        console.log(JSON.stringify({ ok: true, result: res }));
      } else if (flag === '--ask-json') {
        const payload = await readPayloadInput(args[1]);
        const res = await askTelegramQuestion(payload);
        console.log(JSON.stringify({ ok: true, ...res }));
      } else if (flag === '--voice-json') {
        const payload = await readPayloadInput(args[1]);
        const res = await sendTelegramVoice(payload);
        console.log(JSON.stringify({ ok: true, result: res }));
      } else if (flag === '--voice') {
        const audioPath = args[1] || findLatestVoiceboxAudio();
        console.log(`Enviando nota de voz: ${audioPath || 'buscando en Voicebox...'}`);
        await sendTelegramVoice({ audioPath, caption: '🎙️ Audio enviado desde la terminal' });
        console.log('✅ Nota de voz enviada exitosamente a Telegram.');
      } else if (flag === '--ask') {
        const question = args[1] || '¿Deseas continuar?';
        const rawOptions = args[2] ? args[2].split(',').map(s => s.trim()) : ['Aprobar', 'Rechazar'];
        const res = await askTelegramQuestion({ question, options: rawOptions });
        console.log('Resultado:', res);
      } else if (['--success', '--error', '--warning', '--info'].includes(flag)) {
        const level = flag.slice(2);
        const title = args[1] || '';
        const message = args[2] || title;
        await sendTelegramNotification({ title: args[2] ? title : undefined, message, level });
        console.log(`✅ Notificación (${level}) enviada a Telegram.`);
      } else {
        const message = args.join(' ');
        await sendTelegramNotification(message);
        console.log('✅ Mensaje enviado a Telegram.');
      }
    } catch (err) {
      console.error('❌ Error enviando a Telegram:', err.message);
      process.exit(1);
    }
  })();
}
