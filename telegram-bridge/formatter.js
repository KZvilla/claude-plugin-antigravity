/**
 * Módulo de formateo y división inteligente de mensajes para Telegram.
 * Gestiona el límite de 4096 caracteres y previene roturas de bloques de código.
 *
 * Se envía con `parse_mode: 'HTML'`, no con el Markdown legado de Telegram.
 * La salida de un LLM trae con frecuencia `_`, `*` o backticks desbalanceados,
 * y el parser de Markdown rechaza el mensaje entero: la degradación a texto
 * plano se llevaba por delante también los bloques de código, que es justo lo
 * que peor se lee en el móvil. Aquí el texto se escapa siempre y las etiquetas
 * las pone el formateador, así que el resultado es determinista.
 */

const MAX_CHUNK_LENGTH = 3800; // Margen de seguridad sobre el límite de 4096 de Telegram
const FENCE_CLOSE = '\n```';

// ==============================================================================
// Markdown → HTML de Telegram
// ==============================================================================

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Escapa los tres caracteres que Telegram interpreta en modo HTML.
 */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Convierte énfasis de Markdown sobre texto YA escapado.
 * Un marcador sin pareja se queda como texto literal: no hay forma de que
 * genere HTML inválido, que es todo el objetivo del cambio.
 */
function emphasisToHtml(escaped) {
  return escaped
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    // En el Markdown de Telegram un solo asterisco es negrita, no cursiva.
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '<b>$1</b>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    .replace(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, '<b>$1</b>')
    .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '<i>$1</i>');
}

/**
 * Procesa un tramo sin bloques de código: primero el código en línea (cuyo
 * contenido no debe reinterpretarse), luego el énfasis.
 */
function inlineToHtml(segment) {
  const out = [];
  const codeRe = /`([^`\n]+)`/g;
  let last = 0;
  let m;

  while ((m = codeRe.exec(segment)) !== null) {
    out.push(emphasisToHtml(escapeHtml(segment.slice(last, m.index))));
    out.push(`<code>${escapeHtml(m[1])}</code>`);
    last = codeRe.lastIndex;
  }
  out.push(emphasisToHtml(escapeHtml(segment.slice(last))));

  return out.join('');
}

/**
 * Convierte el subconjunto de Markdown que se usa aquí al HTML que acepta
 * Telegram. Un bloque de código sin cerrar se cierra implícitamente al final
 * del texto, para que un corte a mitad no rompa el mensaje.
 */
export function markdownToTelegramHtml(text) {
  if (!text) return '';

  const parts = [];
  const fenceRe = /```([^\n]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;

  while ((m = fenceRe.exec(text)) !== null) {
    parts.push(inlineToHtml(text.slice(last, m.index)));

    const lang = m[1].trim();
    const code = escapeHtml(m[2].replace(/\n$/, ''));
    parts.push(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`
        : `<pre>${code}</pre>`
    );

    last = fenceRe.lastIndex;
  }
  parts.push(inlineToHtml(text.slice(last)));

  return parts.join('');
}

// ==============================================================================
// División en trozos
// ==============================================================================

/**
 * Divide un texto largo en trozos que no superen `maxLength`, respetando saltos
 * de línea y manteniendo equilibrados los bloques de código ```.
 *
 * Opera sobre el Markdown de origen, no sobre el HTML: los fences son los
 * puntos de corte naturales, y así cada trozo se convierte a HTML por separado
 * ya equilibrado.
 */
export function splitMessage(text, maxLength = MAX_CHUNK_LENGTH) {
  if (!text || text.length <= maxLength) {
    return [text || ''];
  }

  const chunks = [];
  const lines = text.split('\n');
  // Estado del fence ANTES de colocar la línea en curso. Evaluarlo después de
  // colocarla es lo que producía fences huérfanos cuando la línea que
  // desbordaba era justamente la de apertura.
  let inFence = false;
  let fenceLang = '';
  let current = '';

  // Un trozo que solo contiene la reapertura de un bloque no aporta nada y en
  // Telegram se ve como un recuadro de código vacío: se descarta.
  const push = (content) => {
    const payload = content.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
    if (payload.trim().length === 0) return;
    chunks.push(content);
  };

  const flush = () => {
    if (current.length === 0) return;
    let content = current;

    if (inFence) {
      // Si el bloque se abrió justo al final del trozo y aún no tiene
      // contenido, el fence de apertura se pasa al trozo siguiente en lugar de
      // dejar aquí un recuadro de código vacío.
      const opener = '```' + fenceLang;
      const idx = content.lastIndexOf(opener);
      if (idx !== -1 && content.slice(idx + opener.length).trim().length === 0) {
        content = content.slice(0, idx).replace(/\n$/, '');
      } else {
        content += FENCE_CLOSE;
      }
    }

    push(content);
    current = inFence ? '```' + fenceLang : '';
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isFence = trimmed.startsWith('```');
    // Espacio que hay que reservar para poder cerrar el bloque al cortar.
    const reserve = inFence ? FENCE_CLOSE.length : 0;
    const prospective = current.length === 0 ? line.length : current.length + 1 + line.length;

    if (prospective + reserve > maxLength && current.length > 0) {
      flush();
    }

    if (line.length + reserve > maxLength) {
      // Una sola línea más larga que el límite: partirla a la fuerza, dando a
      // cada fragmento su reapertura y su cierre si estamos dentro de un bloque.
      // El chunk en curso ya se vació arriba si hacía falta.
      const prefix = inFence ? '```' + fenceLang + '\n' : '';
      const room = Math.max(1, maxLength - prefix.length - reserve);
      let rest = line;

      while (rest.length > room) {
        push(prefix + rest.slice(0, room) + (inFence ? FENCE_CLOSE : ''));
        rest = rest.slice(room);
      }
      current = prefix + rest;
    } else {
      current = current.length === 0 ? line : current + '\n' + line;
    }

    if (isFence) {
      if (inFence) {
        inFence = false;
        fenceLang = '';
      } else {
        inFence = true;
        fenceLang = trimmed.slice(3).trim();
      }
    }
  }

  // El último trozo también se cierra si el texto original terminaba dentro de
  // un bloque abierto.
  if (current.trim().length > 0) {
    push(inFence ? current + FENCE_CLOSE : current);
  }

  return chunks;
}

// ==============================================================================
// Envío
// ==============================================================================

/**
 * Envía un trozo como HTML y, si Telegram lo rechazara, reintenta en texto
 * plano con el Markdown de origen. Con el escapado explícito el reintento no
 * debería hacer falta nunca; se mantiene como red de seguridad.
 */
export async function sendSafeChunk(ctx, chunkText, extra = {}) {
  try {
    return await ctx.reply(markdownToTelegramHtml(chunkText), { parse_mode: 'HTML', ...extra });
  } catch (err) {
    console.error(`[formatter] Telegram rechazó el HTML (${err.message}). Reintentando en texto plano.`);
    return await ctx.reply(chunkText, { ...extra, parse_mode: undefined });
  }
}

/**
 * Envía un mensaje completo dividiéndolo en trozos si excede el tamaño máximo
 */
export async function replyWithSmartChunks(ctx, fullText, extra = {}) {
  const chunks = splitMessage(fullText);
  const sentMessages = [];

  for (let i = 0; i < chunks.length; i++) {
    // Solo aplicamos extra (por ejemplo Inline Keyboards) en el último chunk
    const chunkExtra = (i === chunks.length - 1) ? extra : {};
    const msg = await sendSafeChunk(ctx, chunks[i], chunkExtra);
    sentMessages.push(msg);
  }

  return sentMessages;
}

/**
 * Formatea un bloque con detalles de la ejecución de Antigravity
 */
export function formatExecutionMeta(resData, durationSeconds, conversationId, mode, sessionSeconds = 0) {
  let meta = `\n\n---\n⚡ *Antigravity CLI*\n`;
  if (conversationId) meta += `• Sesión: \`${conversationId}\`\n`;
  if (mode) meta += `• Modo: \`${mode}\`\n`;
  if (durationSeconds) meta += `• Duración: \`${formatElapsed(durationSeconds)}\`\n`;
  // `agy` reporta `duration_seconds` acumulado de toda la conversación, no de
  // esta tarea: al reanudar una sesión de hace horas salían cifras como
  // «18733.2s» para una respuesta de medio minuto. El reloj de pared del
  // executor es el dato honesto; el acumulado solo se muestra si añade algo.
  if (sessionSeconds && sessionSeconds - durationSeconds > 5) {
    meta += `• Sesión acumulada: \`${formatElapsed(sessionSeconds)}\`\n`;
  }

  if (resData && resData.usage) {
    const u = resData.usage;
    const inp = (u.input_tokens || 0).toLocaleString();
    const out = (u.output_tokens || 0).toLocaleString();
    const think = (u.thinking_tokens || 0).toLocaleString();
    meta += `• Tokens: ${inp} in / ${out} out (razonamiento: ${think})\n`;
  }

  return meta;
}

/**
 * Formatea una duración en segundos como `45s`, `2m 34s` o `5h 12m`. Sin el
 * tramo de horas, una sesión larga se leía como `312m 13s`.
 */
export function formatElapsed(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`;
}
