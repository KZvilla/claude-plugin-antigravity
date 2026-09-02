/**
 * Saneado de texto destinado a sintesis de voz.
 *
 * Vive en su propio modulo -y no dentro de index.js- porque requerir index.js
 * arranca el servidor MCP: engancha stdin y deja vivo el event loop. Estas
 * funciones son puras y hay que poder afirmarlas en un test sin levantar nada.
 */

// Tope de caracteres que se envian a Voicebox. Por encima, la sintesis tarda
// muchisimo, el .wav se dispara y una nota de voz de varios minutos no la
// escucha nadie. Es un limite de producto, no tecnico.
const SPOKEN_TEXT_LIMIT = 1200;
// A partir de aqui se sugiere `polish`: es el punto donde el texto deja de ser
// una frase y pasa a necesitar resumen de verdad.
const POLISH_SUGGESTED_OVER = 600;

/**
 * Enmascara tokens de bot de Telegram. Copia deliberada de `redactSecrets` de
 * telegram-bridge/policy.js: ese modulo es ESM y este servidor es CommonJS, asi
 * que no se puede importar. Misma decision -y mismo motivo- que la duplicacion
 * de resolveAgyBin. Si se toca una, tocar la otra.
 */
function redactSecrets(text) {
  if (text === null || text === undefined) return '';
  let out = String(text);
  out = out.replace(/(bot)(\d{6,}):[A-Za-z0-9_-]{20,}/g, '$1$2:[REDACTED]');
  out = out.replace(/(^|[^A-Za-z0-9_-])(\d{6,}):[A-Za-z0-9_-]{20,}/g, '$1$2:[REDACTED]');
  return out;
}

/**
 * Convierte texto arbitrario en algo decible en voz alta.
 *
 * Es DETERMINISTA a proposito. Las tres cosas que suelen agruparse bajo
 * «sanitizar» no son la misma tarea:
 *
 *   - Hablabilidad (markdown, fences, rutas, URLs, emoji): es sustitucion, no
 *     razonamiento. Mandarlo a un modelo solo anade latencia.
 *   - Redaccion de secretos: tiene que ser incondicional. Un modelo que redacta
 *     «casi siempre» es peor que una expresion regular que redacta siempre,
 *     porque invita a confiar en ella.
 *   - Resumir o pulir: esa si es tarea de lenguaje, y es lo unico que se delega
 *     a agy, bajo el parametro `polish` de agy_say.
 *
 * El orden importa: la redaccion va PRIMERO, antes de que ninguna sustitucion
 * pueda partir un token en dos y dejarlo irreconocible para el patron.
 *
 * @returns {{ text: string, truncated: boolean, originalLength: number }}
 */
function normalizeSpokenText(raw) {
  const originalLength = String(raw === null || raw === undefined ? '' : raw).length;

  let out = redactSecrets(raw);

  out = out
    // Bloques de codigo completos: leerlos en voz alta no aporta nada.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    // Enlaces markdown: se conserva el texto, se descarta la URL.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // URLs sueltas: deletrear «hache te te pe dos puntos barra barra» es ruido.
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    // Rutas de Windows y POSIX: se deja solo el nombre del fichero.
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.\- ]+[\\/])+([\w.\-]+)/g, '$1')
    // Enfasis, encabezados, citas y vinetas.
    .replace(/^\s*[-+*]\s+/gm, ' ')
    .replace(/[*#_~>]/g, ' ')
    // Emoji y simbolos pictograficos.
    .replace(/[\u{1F000}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}]/gu, ' ')
    // Comillas envolventes y espacio sobrante.
    .replace(/\s+/g, ' ')
    // Quitar el enfasis deja el espacio que ocupaba: «**Listo**:» se convertia
    // en «Listo :». Se ve en el caption que llega a Telegram, y algunos motores
    // de TTS alargan la pausa al leer un signo separado de su palabra.
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([¿¡])\s+/g, '$1')
    .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
    .trim();

  const truncated = out.length > SPOKEN_TEXT_LIMIT;
  if (truncated) {
    // Se corta en el ultimo final de frase para no dejar la voz a media palabra.
    const recorte = out.slice(0, SPOKEN_TEXT_LIMIT);
    const corte = Math.max(recorte.lastIndexOf('. '), recorte.lastIndexOf('? '), recorte.lastIndexOf('! '));
    out = (corte > SPOKEN_TEXT_LIMIT * 0.5 ? recorte.slice(0, corte + 1) : recorte).trim();
  }

  return { text: out, truncated, originalLength };
}

/**
 * Prompt del pase de pulido de `agy_say`.
 *
 * Se diferencia de getNarrationPrompt en algo esencial: alli el modelo REDACTA
 * un resumen a partir de hechos extraidos del log; aqui solo REESCRIBE lo que
 * se le da. La instruccion de no anadir informacion es el nucleo, no un
 * adorno: el llamante ya decidio que decir, y un modelo que «mejora»
 * inventando convierte una nota de voz en una fuente de datos falsos que suena
 * exactamente igual de fiable que una correcta.
 */
function getPolishPrompt(rawText, targetLang, profile, enablePersonality = false) {
  const langName = targetLang === 'en' ? 'English' : 'Spanish';
  const langCode = targetLang === 'en' ? 'en' : 'es';
  const profileName = (profile && profile.name) || 'Voice Assistant';

  let personaSection = '';
  if (enablePersonality && profile) {
    personaSection = `\n## Speaker Persona (Derived from Voicebox Profile):
- Name: "${profile.name}"
- Description: "${profile.description || 'Voice Assistant'}"
- Personality Prompt: "${profile.personality || 'Natural and expressive'}"

Adopt that tone and cadence, but never at the cost of changing what the message says.`;
  }

  return `You are preparing a message to be spoken aloud by Voicebox TTS (profile: ${profileName}).
Rewrite the message below as natural spoken ${langName} (${langCode}).
${personaSection}

## Message to rewrite:
"""
${String(rawText).slice(0, 12000)}
"""

## Critical Rules:
- REWRITE ONLY. Do not add facts, numbers, names, conclusions or opinions that are not in the message above. If the message is vague, keep it vague.
- If the message is long, condense it to its essentials - at most 3 sentences.
- Language MUST be ${langName}.
- Write for the ear: no markdown, no bullet points, no code, no URLs, no file paths, no emoji. Spell out symbols and abbreviations the way a person would say them.
- Never invent a status. If the message does not say whether something succeeded, do not claim it did.
- Output ONLY the final spoken text. No preamble, no quotes, no explanation.`;
}

module.exports = {
  SPOKEN_TEXT_LIMIT,
  POLISH_SUGGESTED_OVER,
  redactSecrets,
  normalizeSpokenText,
  getPolishPrompt
};
