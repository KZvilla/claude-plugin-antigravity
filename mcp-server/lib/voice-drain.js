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

// Charla con freno (plan-charla-modo-agente): agy corre sin
// --dangerously-skip-permissions, asi que un comando, un MCP o una URL los
// niega agy mismo y la charla pregunta. Por eso se le pide intentar en vez de
// proponer: sin intento no hay negacion que confirmar. Las escrituras con
// write_to_file no pasan por permisos (sondas G/H), de ahi que se pidan por
// terminal. PRIMING_CHARLA queda para quien abra la sesion sin freno.
const PRIMING_CONFIRMACION = 'A partir de ahora estamos en una conversación de voz en tiempo real. ' +
  'Respondé siempre en 1 a 3 oraciones breves, en lenguaje hablado natural. ' +
  'No uses markdown, listas, enlaces ni bloques de código. ' +
  'Si te pido hacer algo, intentalo directamente con tus herramientas. Si el sistema lo niega, no expliques ni pidas permiso: ' +
  'la charla me pregunta a mí. ' +
  'No escribas ni edites archivos salvo que te lo pida, y cuando te lo pida hacelo con comandos de terminal, ' +
  'nunca con tus herramientas de escritura de archivos. ' +
  'Si necesitás buscar en la web, leer archivos o usar herramientas, hacelo en silencio: no anuncies lo que vas a hacer ' +
  'ni narres tus pasos, la charla ya avisa por vos. Respondé cuando tengas la respuesta. ' +
  'Confirmá que entendiste respondiendo con una sola palabra: OK.';

// Forma real del error sin skip (sondas A, C, D, F del plan):
//   permission check failed for command "Get-Location": user denied permission…
//   permission check failed for mcp "playwright/browser_navigate": …
//   permission check failed for read_url "nodejs.org": …
// El objetivo sale de los parametros cuando estan: el mensaje corta mal un
// comando con comillas.
const PERMISO_NEGADO = /^permission check failed for (command|mcp|read_url) "([^"]*)/;
const HERRAMIENTAS_ESCRITURA = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
// brain/ (planes) y scratch/ (el cwd de la shell de agy) son de agy, no del usuario.
const RUTA_PROPIA_DE_AGY = /[\\/]antigravity-cli[\\/](brain|scratch)([\\/]|$)/i;

function negacionDePaso(s) {
  if (s.step_type !== 'tool' || s.state !== 'ERROR') return null;
  const m = PERMISO_NEGADO.exec(s.tool_info?.error?.message || '');
  if (!m) return null;
  const tipo = m[1];
  const p = s.tool_info?.parameters || {};
  let objetivo = m[2];
  if (tipo === 'command' && typeof p.CommandLine === 'string' && p.CommandLine) {
    objetivo = p.CommandLine;
  } else if (tipo === 'mcp' && typeof p.ServerName === 'string' && p.ServerName) {
    objetivo = typeof p.ToolName === 'string' && p.ToolName ? `${p.ServerName}/${p.ToolName}` : p.ServerName;
  }
  return { tipo, objetivo };
}

/**
 * Pasa los eventos drenados por el chunker, en orden. Un paso de herramienta
 * vacia el chunker: si Gemini escribio el aviso sin punto final y lanzo la
 * herramienta, ese texto sale ya y no al terminar el turno.
 *
 * `estado` vive toda la sesion: un mismo paso de herramienta llega en varios
 * eventos (ACTIVE, DONE) que pueden caer en drains distintos. Se limpia al
 * cerrar el turno, por si el step_index vuelve a empezar en el siguiente.
 *
 * `negadas`: lo que agy nego por permisos en este lote. `escrituras`: archivos
 * que agy escribio fuera de su brain/ y scratch/, que no pasan por permisos.
 */
function procesarEventosDrain(events, chunker, estado = {}) {
  let sentences = [];
  const deltas = [];
  const herramientas = [];
  // Un detalle por paso nuevo: agy expone el servidor MCP en
  // tool_info.parameters.ServerName (captura cruda, plan-senales-mcp).
  const detalles = [];
  const negadas = [];
  const escrituras = [];
  for (const k of ['pasosVistos', 'negadasVistas', 'escriturasVistas']) {
    if (!(estado[k] instanceof Set)) estado[k] = new Set();
  }
  const { pasosVistos, negadasVistas, escriturasVistas } = estado;
  // Un paso negado que llega entero en este lote no se anuncia: no paso.
  const negadosEnLote = new Set();
  for (const e of events) {
    const s = e.event === 'step_update' && e.step_update;
    if (s && s.step_index != null && negacionDePaso(s)) negadosEnLote.add(s.step_index);
  }
  let resultEvent = null;

  for (const e of events) {
    if (e.event === 'step_update' && e.step_update) {
      const s = e.step_update;
      if (s.step_type === 'agent_response' && s.text_delta) {
        deltas.push({ state: s.state, text_delta: s.text_delta });
        sentences = sentences.concat(chunker.push(s.text_delta));
      } else if (s.step_type === 'tool') {
        const clave = s.step_index != null ? `i${s.step_index}` : null;
        const nombre = s.tool_name || s.tool_info?.name || 'tool';
        const params = s.tool_info?.parameters;
        const destino = typeof params?.TargetFile === 'string' ? params.TargetFile : null;

        // La negacion se registra aparte: el ERROR de un paso ya visto en
        // ACTIVE caia en la deduplicacion y se perdia (auditoria del plan).
        const negada = negacionDePaso(s);
        if (negada && (clave === null || !negadasVistas.has(clave))) {
          if (clave !== null) negadasVistas.add(clave);
          negadas.push(negada);
        }
        if (s.state === 'DONE' && HERRAMIENTAS_ESCRITURA.has(nombre) && destino && !RUTA_PROPIA_DE_AGY.test(destino)
            && (clave === null || !escriturasVistas.has(clave))) {
          if (clave !== null) escriturasVistas.add(clave);
          escrituras.push(destino);
        }

        if (clave === null || !pasosVistos.has(clave)) {
          if (clave !== null) pasosVistos.add(clave);
          sentences = sentences.concat(chunker.flush());
          if (s.step_index != null && negadosEnLote.has(s.step_index)) continue;
          herramientas.push(nombre);
          detalles.push({
            nombre,
            servidor: typeof params?.ServerName === 'string' ? params.ServerName : null,
            accion: typeof params?.ToolName === 'string' ? params.ToolName : null,
            destino
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
    negadasVistas.clear();
    escriturasVistas.clear();
  }

  return { sentences, deltas, herramientas, detalles, negadas, escrituras, resultEvent };
}

// La shell de agy arranca en su scratch/ aunque el spawn tenga el cwd del
// proyecto: "git status" daba "not a git repository" (V6 en vivo). Nombrarle
// el directorio lo corrige sin anteponer `cd`, que cambiaria el comando y lo
// sacaria de las reglas `command(...)` exactas del usuario.
const CIERRE_PRIMING = 'Confirmá que entendiste';

/**
 * Inserta el directorio del proyecto antes del cierre del priming. Con
 * `slice` y no `replace`: un `$&` en la ruta se interpolaria. Sin cwd o sin
 * cierre, el priming queda igual.
 */
function conDirectorio(priming, cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return priming;
  const i = priming.indexOf(CIERRE_PRIMING);
  if (i < 0) return priming;
  const frase = `El proyecto está en ${cwd}. Cuando uses run_command, por defecto usá ese directorio como Cwd, ` +
    'o un subdirectorio suyo si el comando lo necesita, y no antepongas cd al comando. ';
  return priming.slice(0, i) + frase + priming.slice(i);
}

module.exports = { PRIMING_CHARLA, PRIMING_CONFIRMACION, conDirectorio, procesarEventosDrain };
