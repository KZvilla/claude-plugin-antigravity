#!/usr/bin/env node

/**
 * Módulo cliente para envío de notificaciones salientes de Entorno ➔ Teléfono (Telegram).
 * Permite enviar texto, alertas de error, notas de voz de Voicebox y preguntas interactivas (Human-in-the-Loop).
 * Funciona de forma autónoma vía HTTPS nativo (fetch) con cero dependencias externas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPendingAsk, getPendingAsk, expirePendingAsk } from './state.js';
import { splitMessage, markdownToTelegramHtml, escapeHtml } from './formatter.js';
import { assertPathAllowed, PolicyViolationError, redactSecrets } from './policy.js';
import { loadBridgeEnv, describeEnvSearch } from './paths.js';

// Límite propio del caption de Telegram, muy por debajo de los 4096 del texto.
const CAPTION_LIMIT = 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Carga de Variables de Entorno.
// Incluye una ubicación duradera fuera del directorio versionado del plugin:
// `claude plugin update` instala cada versión en su propia carpeta y no
// arrastra el .env, así que uno colocado junto al código se pierde en cada
// actualización. Ver bridgeEnvCandidates() en paths.js.
const envSearch = loadBridgeEnv(__dirname).searched;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const rawAllowedIds = process.env.ALLOWED_USER_IDS || '';
const ALLOWED_USER_IDS = rawAllowedIds.split(',').map(s => s.trim()).filter(Boolean);

/**
 * Obtiene el Chat ID por defecto (el primer ID autorizado)
 */
export function getDefaultChatId(targetChatId = null) {
  if (targetChatId) return String(targetChatId);

  // Con varios IDs autorizados, mandar siempre al primero es una decisión
  // arbitraria y silenciosa. TELEGRAM_NOTIFY_CHAT_ID permite fijar el destino;
  // si no está y hay ambigüedad, se avisa en lugar de elegir en silencio.
  const configured = (process.env.TELEGRAM_NOTIFY_CHAT_ID || '').trim();
  if (configured) return configured;

  if (ALLOWED_USER_IDS.length > 1) {
    console.error(
      `[notify] Hay ${ALLOWED_USER_IDS.length} IDs en ALLOWED_USER_IDS y ninguno elegido: ` +
      `se usa el primero (${ALLOWED_USER_IDS[0]}). Fija TELEGRAM_NOTIFY_CHAT_ID para decidirlo.`
    );
  }
  if (ALLOWED_USER_IDS.length > 0) return ALLOWED_USER_IDS[0];

  // Enumerar donde se busco el .env convierte este fallo -el sintoma tipico de
  // un plugin recien actualizado- en algo que se puede arreglar sin adivinar.
  throw new Error(
    'No hay usuarios configurados en ALLOWED_USER_IDS ni se especificó un targetChatId.\n\n' +
    describeEnvSearch(envSearch)
  );
}

/**
 * Envía un texto troceándolo si supera el límite de Telegram, en HTML escapado
 * y con degradación a texto plano. Antes se enviaba de una pieza: un mensaje de
 * más de 4096 caracteres —posible en un agy_narrate o en un reporte de error—
 * fallaba en la API en vez de trocearse.
 */
async function sendChunkedMessage(chatId, text, extra = {}) {
  const chunks = splitMessage(text);
  const sent = [];

  for (const chunk of chunks) {
    try {
      sent.push(await telegramApiCall('sendMessage', {
        chat_id: chatId,
        text: markdownToTelegramHtml(chunk),
        parse_mode: 'HTML',
        ...extra
      }));
    } catch (err) {
      console.error(`[notify] Telegram rechazó el HTML (${redactSecrets(err.message)}). Reintentando en texto plano.`);
      sent.push(await telegramApiCall('sendMessage', { chat_id: chatId, text: chunk, ...extra }));
    }
  }

  return sent.length === 1 ? sent[0] : sent;
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

  // Punto único de aplicación de `deny_paths`. Se comprueba AQUÍ, en la puerta
  // de salida, y no en cada llamante: cualquier ruta que llegue a subirse pasa
  // por esta función, así que un camino nuevo no puede saltarse la política por
  // olvido. Va antes del `existsSync` a propósito — el resultado no debe
  // depender de si el fichero prohibido existe o no.
  assertPathAllowed(filePath);

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

  // Se valida antes de emitir nada. Si se dejara solo la comprobación de
  // `telegramUploadCall`, el texto ya habría salido cuando el adjunto se
  // rechaza, y el usuario vería media notificación sin explicación.
  //
  // Límite conocido de este control: cubre el ADJUNTO, no el cuerpo. Un agente
  // puede leer `.env` con sus propias herramientas y pegar el contenido en
  // `message`. `deny_paths` reduce la superficie de una llamada descuidada a
  // esta herramienta; no es un cortafuegos de exfiltración.
  if (filePath) assertPathAllowed(filePath);

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
    const html = markdownToTelegramHtml(formattedText);

    // El caption no se trocea y tiene su propio límite. Antes se recortaba con
    // slice(1024): el mensaje llegaba mudo a media frase, sin ninguna señal de
    // que faltaba texto, y el corte podía caer dentro de una etiqueta y dejar
    // HTML inválido. Si no cabe, el texto va como mensaje aparte — troceado y
    // completo — y el documento se manda detrás con un caption mínimo.
    if (html.length > CAPTION_LIMIT) {
      await sendChunkedMessage(chatId, formattedText);
      return await telegramUploadCall('sendDocument', 'document', filePath, {
        chat_id: chatId,
        caption: `📎 ${escapeHtml(path.basename(filePath))}`,
        parse_mode: 'HTML'
      });
    }

    return await telegramUploadCall('sendDocument', 'document', filePath, {
      chat_id: chatId,
      caption: html,
      parse_mode: 'HTML'
    });
  }

  return await sendChunkedMessage(chatId, formattedText);
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
    // Un rechazo por política no es un fallo de formato: reintentar con
    // sendAudio solo repetiría el mismo bloqueo y ensuciaría el log con un
    // «fallback» que nunca podía funcionar.
    if (voiceErr instanceof PolicyViolationError) throw voiceErr;
    console.warn(`[notify] sendVoice falló (${redactSecrets(voiceErr.message)}). Intentando sendAudio como fallback...`);
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
      console.warn(`[notify] No se pudo borrar ${resolvedPath}: ${redactSecrets(delErr.message)}`);
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
    text: markdownToTelegramHtml(text),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  });

  // `timeoutSeconds` viaja al estado: el recolector necesita saber cuándo vence
  // ESTE ask para no darlo por huérfano mientras este proceso sigue esperándolo.
  registerPendingAsk(askId, {
    question,
    options: choices,
    chatId,
    messageId: sentMsg.message_id,
    timeoutSeconds
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

      // El ask puede cerrarse desde fuera: lo expira el recolector de otro
      // proceso, o desaparece porque `state.json` se reinicializó. Sin esta
      // rama se seguiría esperando hasta el timeout local contra un registro
      // que ya nadie puede resolver — y el botón de Telegram, que ve el estado
      // real, respondería «esta consulta expiró» sin desbloquear nada.
      if (!ask || ask.status === 'expired') {
        clearInterval(interval);
        resolve({
          answered: false,
          selected: null,
          error: ask
            ? 'La consulta fue marcada como expirada por el recolector de estado antes de recibir respuesta.'
            : 'La consulta desapareció del estado compartido antes de recibir respuesta.'
        });
        return;
      }

      if (Date.now() - startTime >= maxWaitMs) {
        clearInterval(interval);

        // Marcar la consulta como expirada. Sin esto queda como `pending` para
        // siempre: el recolector no la toca y un botón pulsado más tarde la
        // resolvería sobre una espera que ya nadie escucha.
        expirePendingAsk(askId);

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
 * Directorio de datos de Voicebox, o `null` si esta plataforma no tiene uno.
 *
 * Antes las tres funciones de abajo repetían
 * `process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')`. Fuera de
 * Windows `APPDATA` no existe, así que ese fallback construía
 * `~/AppData/Roaming/sh.voicebox.app` — una ruta que no puede existir en Linux
 * ni en macOS. El efecto no era un error claro: `waitForVoiceboxGeneration`
 * daba vueltas noventa segundos sobre una carpeta inventada y luego reportaba
 * un timeout, culpando a Voicebox de ir lento.
 *
 * Ahora la ausencia de soporte se dice de inmediato. `VOICEBOX_DIR` permite
 * apuntar a una instalación no estándar sin que el bridge tenga que adivinar
 * rutas de plataformas donde nadie ha comprobado que Voicebox exista.
 *
 * @returns {{ base: string|null, searched: string[] }}
 */
export function resolveVoiceboxBaseDir() {
  const explicito = (process.env.VOICEBOX_DIR || '').trim();
  if (explicito) return { base: path.resolve(explicito), searched: [path.resolve(explicito)] };

  if (process.platform === 'win32') {
    const homeDir = process.env.USERPROFILE || process.env.HOME || '';
    const appDataRoaming = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const base = path.join(appDataRoaming, 'sh.voicebox.app');
    return { base, searched: [base] };
  }

  return { base: null, searched: [] };
}

/**
 * Mensaje único para cuando no hay directorio de Voicebox. Nombra la causa real
 * —la plataforma— en lugar de dejar que el fallo parezca de red o de lentitud.
 */
function errorVoiceboxNoDisponible() {
  const { searched } = resolveVoiceboxBaseDir();
  if (searched.length > 0) {
    return `No se encontró el directorio de Voicebox. Buscado en: ${searched.join(', ')}. ` +
      'Comprueba que Voicebox esté instalado, o fija VOICEBOX_DIR.';
  }
  return `Las notas de voz de Voicebox solo tienen ruta conocida en Windows (esta plataforma es ${process.platform}). ` +
    'Si tienes Voicebox aquí, fija VOICEBOX_DIR al directorio que contiene generations/ y captures/. ' +
    'El resto del bridge —notificaciones y preguntas— funciona igual.';
}

/**
 * 4. Localiza el archivo de audio más reciente generado por Voicebox
 */
export function findLatestVoiceboxAudio() {
  const { base: vbBase } = resolveVoiceboxBaseDir();
  if (!vbBase) return null;

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
  const { base } = resolveVoiceboxBaseDir();
  if (!base) return [];
  const genDir = path.join(base, 'generations');
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

  // Se comprueba ANTES de entrar al bucle. Sondear noventa segundos un
  // directorio que no puede existir y reportar despues un timeout es un fallo
  // que miente sobre su causa.
  const { base } = resolveVoiceboxBaseDir();
  if (!base) throw new Error(errorVoiceboxNoDisponible());
  const genDir = path.join(base, 'generations');

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
      console.error('❌ Error enviando a Telegram:', redactSecrets(err.message));
      process.exit(1);
    }
  })();
}
