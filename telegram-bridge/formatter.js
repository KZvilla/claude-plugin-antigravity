/**
 * Módulo de formateo y división inteligente de mensajes para Telegram.
 * Gestiona el límite de 4096 caracteres y previene roturas de bloques de código Markdown.
 */

const MAX_CHUNK_LENGTH = 3800; // Margen de seguridad sobre el límite de 4096 de Telegram

/**
 * Divide un texto largo en trozos que no superen `maxLength`,
 * respetando párrafos, saltos de línea y manteniendo la apertura/cierre de bloques de código ```.
 */
export function splitMessage(text, maxLength = MAX_CHUNK_LENGTH) {
  if (!text || text.length <= maxLength) {
    return [text || ''];
  }

  const chunks = [];
  const lines = text.split('\n');
  let currentChunk = '';
  let insideCodeBlock = false;
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detectar apertura o cierre de bloque de código
    if (trimmed.startsWith('```')) {
      if (!insideCodeBlock) {
        insideCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
      } else {
        insideCodeBlock = false;
        codeBlockLang = '';
      }
    }

    // Comprobar si añadir la línea actual superaría el límite
    const prospectiveLength = currentChunk.length + line.length + 1; // +1 por el \n

    if (prospectiveLength > maxLength) {
      if (currentChunk.length > 0) {
        // Si estamos dentro de un bloque de código, cerrarlo antes de cortar
        if (insideCodeBlock) {
          currentChunk += '\n```';
        }
        chunks.push(currentChunk);

        // En el nuevo trozo, reabrir el bloque de código con el mismo lenguaje
        if (insideCodeBlock) {
          currentChunk = '```' + codeBlockLang + '\n' + line;
        } else {
          currentChunk = line;
        }
      } else {
        // La línea individual sola es más larga que maxLength: dividirla a la fuerza
        let remainingLine = line;
        while (remainingLine.length > maxLength) {
          const slice = remainingLine.slice(0, maxLength);
          chunks.push(insideCodeBlock ? slice + '\n```' : slice);
          remainingLine = (insideCodeBlock ? '```' + codeBlockLang + '\n' : '') + remainingLine.slice(maxLength);
        }
        currentChunk = remainingLine;
      }
    } else {
      currentChunk = currentChunk.length === 0 ? line : currentChunk + '\n' + line;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Envía un mensaje con reintento automático sin formato si falla el parseo de Markdown
 */
export async function sendSafeChunk(ctx, chunkText, extra = {}) {
  try {
    return await ctx.reply(chunkText, { parse_mode: 'Markdown', ...extra });
  } catch (err) {
    // Si falla el parser de Markdown de Telegram (ej. caracteres especiales o tags incompletos),
    // enviar como texto plano para asegurar que el usuario siempre reciba la respuesta.
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
export function formatExecutionMeta(resData, durationSeconds, conversationId, mode) {
  let meta = `\n\n---\n⚡ *Antigravity CLI*\n`;
  if (conversationId) meta += `• Sesión: \`${conversationId}\`\n`;
  if (mode) meta += `• Modo: \`${mode}\`\n`;
  if (durationSeconds) meta += `• Duración: \`${durationSeconds.toFixed(1)}s\`\n`;

  if (resData && resData.usage) {
    const u = resData.usage;
    const inp = (u.input_tokens || 0).toLocaleString();
    const out = (u.output_tokens || 0).toLocaleString();
    const think = (u.thinking_tokens || 0).toLocaleString();
    meta += `• Tokens: ${inp} in / ${out} out (razonamiento: ${think})\n`;
  }

  return meta;
}
