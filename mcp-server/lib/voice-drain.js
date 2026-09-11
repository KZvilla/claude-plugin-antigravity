/**
 * Modo Charla: priming y procesamiento de eventos de `agy_voice_stream`.
 *
 * Separado de index.js para poder testearlo sin lanzar agy.
 */

// Regla del aviso previo (plan-charla-latencia, A): cuando agy tiene que
// buscar o usar herramientas, el primer texto llega recien al terminar y la
// charla queda en silencio. Una frase corta antes de la herramienta sale por
// streaming y suena en ~1.5 s. "Al menos cuatro palabras": el SentenceChunker
// exige minWords = 3, y un "Lo busco." quedaria pegado a la oracion siguiente,
// que llega despues de la busqueda.
const PRIMING_CHARLA = 'A partir de ahora estamos en una conversación de voz en tiempo real, no en una sesión de código. ' +
  'Respondé siempre en 1 a 3 oraciones breves, en lenguaje hablado natural. ' +
  'No uses markdown, listas, enlaces ni bloques de código. No escribas, edites ni planifiques archivos — ' +
  'es una charla, no una tarea de programación, salvo que te pida explícitamente hacer algo en el proyecto. ' +
  'Si para responder tenés que buscar en la web, leer archivos o usar cualquier herramienta, antes decí una sola ' +
  'frase corta de al menos cuatro palabras que anticipe lo que vas a hacer, terminada en punto ' +
  '(por ejemplo: Dale, ya lo busco en la web.), y recién después usá la herramienta. ' +
  'Si podés responder sin herramientas, respondé directo sin anunciar nada. ' +
  'Confirmá que entendiste respondiendo con una sola palabra: OK.';

/**
 * Pasa los eventos drenados por el chunker, en orden. Un paso de herramienta
 * vacia el chunker: si Gemini escribio el aviso sin punto final y lanzo la
 * herramienta, ese texto sale ya y no al terminar el turno.
 *
 * `estado` vive toda la sesion: un mismo paso de herramienta llega en varios
 * eventos (ACTIVE, DONE) que pueden caer en drains distintos. Se limpia al
 * cerrar el turno, por si el step_index vuelve a empezar en el siguiente.
 */
function procesarEventosDrain(events, chunker, estado = {}) {
  let sentences = [];
  const deltas = [];
  const herramientas = [];
  if (!(estado.pasosVistos instanceof Set)) estado.pasosVistos = new Set();
  const pasosVistos = estado.pasosVistos;
  let resultEvent = null;

  for (const e of events) {
    if (e.event === 'step_update' && e.step_update) {
      const s = e.step_update;
      if (s.step_type === 'agent_response' && s.text_delta) {
        deltas.push({ state: s.state, text_delta: s.text_delta });
        sentences = sentences.concat(chunker.push(s.text_delta));
      } else if (s.step_type === 'tool') {
        const clave = s.step_index != null ? `i${s.step_index}` : null;
        if (clave === null || !pasosVistos.has(clave)) {
          if (clave !== null) pasosVistos.add(clave);
          sentences = sentences.concat(chunker.flush());
          herramientas.push(s.tool_name || (s.tool_info && s.tool_info.name) || 'tool');
        }
      }
    } else if (e.event === 'result' && !resultEvent) {
      resultEvent = e;
    }
  }
  if (resultEvent) {
    sentences = sentences.concat(chunker.flush());
    pasosVistos.clear();
  }

  return { sentences, deltas, herramientas, resultEvent };
}

module.exports = { PRIMING_CHARLA, procesarEventosDrain };
