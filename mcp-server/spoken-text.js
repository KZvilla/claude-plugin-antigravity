/**
 * Saneado de texto destinado a sintesis de voz.
 *
 * Vive en su propio modulo -y no dentro de index.js- porque requerir index.js
 * arranca el servidor MCP: engancha stdin y deja vivo el event loop. Estas
 * funciones son puras y hay que poder afirmarlas en un test sin levantar nada.
 */

const path = require('node:path');

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
/**
 * Persona desde `alma.md` (almas, fase 1): reemplaza los dos campos del perfil
 * de Voicebox. El alma dice QUIÉN habla, no QUÉ pasó, y el encuadre lo repite
 * para que ninguna narración saque hechos de ahí. Las reglas de cada prompt
 * (REWRITE ONLY, exactitud del checkpoint) van después y no cambian.
 */
function bloqueAlma(nombre, alma) {
  return `## Speaker Persona (from the soul file alma.md of ${nombre || 'the speaker'}):
"""
${String(alma).trim()}
"""
It defines who is speaking: tone, cadence, attitude. It is not information about the message: never take facts, names or events from it.`;
}

function getPolishPrompt(rawText, targetLang, profile, enablePersonality = false, alma = null) {
  const langName = targetLang === 'en' ? 'English' : 'Spanish';
  const langCode = targetLang === 'en' ? 'en' : 'es';
  const profileName = (profile && profile.name) || 'Voice Assistant';

  let personaSection = '';
  if (enablePersonality && profile && alma) {
    personaSection = `\n${bloqueAlma(profile.name, alma)}

Adopt that tone and cadence, but never at the cost of changing what the message says.`;
  } else if (enablePersonality && profile) {
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

/**
 * Prompt de la reescritura en persona (`personality: true` sin `polish`).
 *
 * Existe porque la persona la aplicaba el LLM de Voicebox (Qwen3 0.6B) y ahora
 * la aplica agy, que es más capaz y la aplica igual con cualquier motor de voz.
 * No reusa getPolishPrompt porque ese condensa a 3 frases: aquí el texto se
 * dice completo, solo cambia el tono.
 */
function getPersonaPrompt(rawText, targetLang, profile, alma = null) {
  const langName = targetLang === 'en' ? 'English' : 'Spanish';
  const langCode = targetLang === 'en' ? 'en' : 'es';
  const p = profile || {};
  const persona = alma
    ? bloqueAlma(p.name, alma)
    : `## Speaker Persona (Derived from Voicebox Profile):
- Name: "${p.name || 'Voice Assistant'}"
- Description: "${p.description || 'Voice Assistant'}"
- Personality Prompt: "${p.personality || 'Natural and expressive'}"`;

  return `You are preparing a message to be spoken aloud by a text-to-speech voice (profile: ${p.name || 'Voice Assistant'}).
Rewrite the message below in the voice of this speaker persona, as natural spoken ${langName} (${langCode}).

${persona}

## Message to rewrite:
"""
${String(rawText).slice(0, 12000)}
"""

## Critical Rules:
- REWRITE ONLY. Do not add facts, numbers, names, conclusions or opinions that are not in the message above. If the message is vague, keep it vague.
- Keep ALL of the content and roughly the same length: change the tone, cadence and wording, never what the message says.
- Language MUST be ${langName}.
- Write for the ear: no markdown, no bullet points, no code, no URLs, no file paths, no emoji. Spell out symbols and abbreviations the way a person would say them.
- Never invent a status. If the message does not say whether something succeeded, do not claim it did.
- Output ONLY the final spoken text. No preamble, no quotes, no explanation.`;
}

/**
 * Prompt del guion de `agy_narrate`: Gemini REDACTA una actualización a partir
 * de hechos del checkpoint. Vivía en index.js, que no exporta nada; se movió
 * acá (almas, fase 1) para poder probarlo, sin cambios de contenido.
 */
function getNarrationPrompt(checkpoint, targetLang, profile, enablePersonality = false, alma = null) {
  const langName = targetLang === 'en' ? 'English' : 'Spanish';
  const langCode = targetLang === 'en' ? 'en' : 'es';
  const profileName = (profile && profile.name) || 'Voice Assistant';

  // Se le da el RECUENTO, no solo el estado. Un "pasaron los tests" es cierto
  // pero vago; "las cinco suites en verde" es lo que una persona diria.
  const nTests = (checkpoint.testExecutions || []).length;
  let testSummary = 'No tests executed in this checkpoint.';
  if (checkpoint.overallTestStatus === 'PASSED') {
    testSummary = `${nTests} test run(s) were executed and ALL PASSED.`;
  } else if (checkpoint.overallTestStatus === 'FAILED') {
    testSummary = `${nTests} test run(s) were executed and at least one FAILED.`;
  } else if (checkpoint.overallTestStatus === 'PENDING') {
    testSummary = `${nTests} test run(s) were started but their result is unknown.`;
  }

  const filesList = checkpoint.filesModified.length > 0
    ? checkpoint.filesModified.map(f => path.basename(f)).slice(0, 5).join(', ')
    : 'no files explicitly modified';

  const instruccionesPersona = `Persona Instructions:
Adopt the authentic tone, humor, vocabulary, cadence, and characteristic mannerisms of the specified speaker persona naturally, but remain strictly accurate regarding the technical checkpoint facts (files modified and test results).`;

  let personaSection = '';
  if (enablePersonality && profile && alma) {
    personaSection = `\n${bloqueAlma(profile.name, alma)}

${instruccionesPersona}`;
  } else if (enablePersonality && profile) {
    personaSection = `\n## Speaker Persona (Derived from Voicebox Profile):
- Name: "${profile.name}"
- Description: "${profile.description || 'Voice Assistant'}"
- Personality Prompt: "${profile.personality || 'Natural and expressive'}"

${instruccionesPersona}`;
  }

  return `You are a voice assistant narrator creating a spoken status update for a software engineer.
Generate a concise, natural, and conversational spoken narration (exactly 2 to 3 sentences) in ${langName} (${langCode}) to be spoken by Voicebox TTS (profile: ${profileName}).
${personaSection}

## Checkpoint Context:
- User's Goal: "${checkpoint.userGoal.slice(0, 300)}"
- Key Files Changed: ${filesList}
- Tests Status: ${testSummary}
- Assistant Context: "${checkpoint.assistantNotes.slice(0, 300) || 'Task completed'}"

## Critical Audio Narration Rules:
- Language MUST be ${langName}.
- Keep it natural, conversational, and direct (between 25 and 45 words).
- State clearly what was done, mention key component/file if relevant, and state the test outcome.
- ABSOLUTELY NO MARKDOWN: no asterisks, no bullet points, no code blocks, no backticks, no brackets.
- Do NOT spell symbols like "/", "\\", "_", or file extensions repeatedly unless natural (e.g. say "en el archivo de rutas" or "en index punto jota ese").
- Do NOT include introductory filler like "Here is the summary" or quotation marks.
- Output ONLY the plain text that will be spoken aloud.`;
}

module.exports = {
  SPOKEN_TEXT_LIMIT,
  POLISH_SUGGESTED_OVER,
  redactSecrets,
  normalizeSpokenText,
  getPolishPrompt,
  getPersonaPrompt,
  getNarrationPrompt,
  bloqueAlma
};
