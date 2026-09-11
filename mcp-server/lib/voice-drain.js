/**
 * Modo Charla: priming y procesamiento de eventos de `agy_voice_stream`.
 *
 * Separado de index.js para poder testearlo sin lanzar agy.
 */

// Sin narracion (plan-charla-latencia, v2 G): pedirle a Gemini que anuncie
// sus pasos lo volvia un "disco rayado" (siete frases en una busqueda, prueba
// del usuario). La charla avisa sola con senales pregrabadas que nombran la
// herramienta en curso (drain informa `herramientas`), asi que Gemini trabaja
// en silencio y responde al final.
const PRIMING_CHARLA = 'A partir de ahora estamos en una conversación de voz en tiempo real, no en una sesión de código. ' +
  'Respondé siempre en 1 a 3 oraciones breves, en lenguaje hablado natural. ' +
  'No uses markdown, listas, enlaces ni bloques de código. No escribas, edites ni planifiques archivos — ' +
  'es una charla, no una tarea de programación, salvo que te pida explícitamente hacer algo en el proyecto. ' +
  'Si necesitás buscar en la web, leer archivos o usar herramientas, hacelo en silencio: no anuncies lo que vas a hacer ' +
  'ni narres tus pasos, la charla ya avisa por vos. Respondé cuando tengas la respuesta. ' +
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
  // Un detalle por paso nuevo: agy expone el servidor MCP en
  // tool_info.parameters.ServerName (captura cruda, plan-senales-mcp).
  const detalles = [];
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
          const nombre = s.tool_name || s.tool_info?.name || 'tool';
          herramientas.push(nombre);
          const params = s.tool_info?.parameters;
          detalles.push({
            nombre,
            servidor: typeof params?.ServerName === 'string' ? params.ServerName : null,
            accion: typeof params?.ToolName === 'string' ? params.ToolName : null
          });
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

  return { sentences, deltas, herramientas, detalles, resultEvent };
}

module.exports = { PRIMING_CHARLA, procesarEventosDrain };
