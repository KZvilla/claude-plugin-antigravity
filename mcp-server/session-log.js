/**
 * Pre-procesado del log JSONL de una sesion de Claude Code.
 *
 * Invariante que costo caro: en el JSONL NO existe un evento raiz de tipo
 * "tool_result". Las salidas de herramientas viajan anidadas dentro de eventos
 * type:"user", como bloques {type:"tool_result"} en message.content. Ramificar
 * sobre obj.type === 'tool_result' no matchea nunca, y aplanar el contenido con
 * (c.text || c.type) convierte cada salida en la palabra literal "tool_result",
 * descartando el grueso del log. Mismo patron que checkpoint.js.
 *
 * Ademas del transcript se derivan hechos mecanicamente: que archivos se
 * tocaron, que comandos se corrieron y que salidas fallaron. Van al prompt
 * aparte porque cubren la sesion entera aunque la ventana del transcript se
 * trunque, y porque un modelo no deberia tener que reconstruir leyendo prosa
 * algo que esta literal en los inputs de las herramientas.
 */
const fs = require('fs');

const LIMITE_RESULTADO = 300;
const LIMITE_PENSAMIENTO = 250;
const MAX_ARCHIVOS = 120;
const MAX_COMANDOS = 120;
const MAX_ERRORES = 40;

// Las rutas llegan bajo nombres distintos segun la herramienta: Claude Code,
// Antigravity y los MCP de terceros no comparten convencion.
const CLAVES_RUTA = ['file_path', 'path', 'TargetFile', 'file', 'notebook_path'];
const CLAVES_COMANDO = ['command', 'CommandLine'];

// A tool_result block's content is either a plain string or an array of content
// blocks ({type:"text"|"image"}). Flatten it to plain text.
function toolResultText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === 'string' ? c : (c && c.type === 'text' ? (c.text || '') : '')))
      .join(' ')
      .trim();
  }
  if (content && typeof content === 'object') return JSON.stringify(content).trim();
  return '';
}

// <local-command-caveat> y <system-reminder> los inyecta el harness, no el
// usuario. Sin filtrarlos el resumen le atribuye al usuario palabras que nunca
// escribio, que es peor que perder el turno.
function limpiarRuidoDelHarness(texto) {
  return String(texto)
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

function primeraLinea(texto, limite) {
  const linea = String(texto).split('\n')[0].trim();
  return linea.length > limite ? linea.slice(0, limite) + '...' : linea;
}

function preprocessSessionLog(filePath, maxChars = 1000000) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim());

  const turns = [];
  const sessionMeta = { cwd: null, branch: null, version: null, startTime: null, endTime: null };

  // Hechos derivados: se acumulan al recorrer, no se reconstruyen despues.
  const archivos = new Set();
  const comandos = [];
  const errores = [];

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip queue operations and file deltas (noise)
    if (obj.type === 'queue-operation' || obj.type === 'file-history-delta') continue;

    // Extract session metadata from first user message
    if (obj.cwd && !sessionMeta.cwd) sessionMeta.cwd = obj.cwd;
    if (obj.gitBranch && !sessionMeta.branch) sessionMeta.branch = obj.gitBranch;
    if (obj.version && !sessionMeta.version) sessionMeta.version = obj.version;
    if (obj.timestamp) {
      if (!sessionMeta.startTime) sessionMeta.startTime = obj.timestamp;
      sessionMeta.endTime = obj.timestamp;
    }

    // Skip meta/system messages
    if (obj.isMeta) continue;

    if (obj.type === 'user' && obj.message) {
      const raw = obj.message.content;
      if (typeof raw === 'string') {
        const limpio = limpiarRuidoDelHarness(raw);
        if (limpio) turns.push({ role: 'user', content: limpio, ts: obj.timestamp });
      } else if (Array.isArray(raw)) {
        // Text blocks are the real user turn. tool_result blocks are the outputs
        // of the previous assistant turn's tool calls: Claude Code nests them
        // inside type:"user" events, there is no root-level tool_result type.
        const userText = limpiarRuidoDelHarness(
          raw.filter(c => c.type === 'text').map(c => c.text || '').join(' ')
        );
        if (userText) {
          turns.push({ role: 'user', content: userText, ts: obj.timestamp });
        }
        for (const block of raw) {
          if (block.type !== 'tool_result') continue;
          const text = toolResultText(block.content);
          if (!text) continue;
          const fallo = Boolean(block.is_error) || /\bError:/.test(text.slice(0, 200));
          if (fallo && errores.length < MAX_ERRORES) {
            errores.push(primeraLinea(text, 200));
          }
          const truncated = text.slice(0, LIMITE_RESULTADO);
          turns.push({
            role: 'tool_result',
            content: `[Result${fallo ? ' ERROR' : ''}] ${truncated}${text.length > LIMITE_RESULTADO ? '...' : ''}`,
            ts: obj.timestamp
          });
        }
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const raw = obj.message.content;
      if (typeof raw === 'string') {
        if (raw.trim()) turns.push({ role: 'assistant', content: raw.trim(), ts: obj.timestamp });
      } else if (Array.isArray(raw)) {
        const partes = [];
        for (const block of raw) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            partes.push(block.text.trim());
          } else if (block.type === 'thinking' && block.thinking && block.thinking.trim().length > 50) {
            // El razonamiento seria el trabajo de derivacion: lo caro de perder
            // no es la conclusion sino como se llego a ella y que se descarto.
            //
            // Medido sobre un log real de 6,7 MB: los 162 bloques `thinking`
            // traen `thinking: ""` y solo conservan `signature`. Claude Code no
            // persiste el texto del razonamiento, asi que hoy esta rama no
            // recupera nada. Se deja porque el coste es nulo y el formato del
            // log puede cambiar, pero NO cuenta como que el resumen preserve la
            // derivacion: eso hay que sacarlo de lo que el asistente escribio.
            partes.push(`(Razonamiento: ${block.thinking.trim().slice(0, LIMITE_PENSAMIENTO)}...)`);
          }
        }
        if (partes.length) {
          turns.push({ role: 'assistant', content: partes.join('\n'), ts: obj.timestamp });
        }

        for (const block of raw) {
          if (block.type !== 'tool_use') continue;
          const toolName = block.name || 'unknown_tool';
          const input = block.input || {};

          for (const clave of CLAVES_RUTA) {
            if (input[clave]) { archivos.add(String(input[clave])); break; }
          }
          for (const clave of CLAVES_COMANDO) {
            if (input[clave]) { comandos.push(String(input[clave])); break; }
          }

          const inputPreview = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
          turns.push({
            role: 'tool_call',
            content: `[Tool: ${toolName}] ${inputPreview}`,
            ts: obj.timestamp
          });
        }
      }
    }
  }

  // Build the pre-processed transcript text
  let transcript = '';
  const totalTurns = turns.length;

  // If the full transcript is too large, keep first 10 + last turns that fit
  const headerTurns = turns.slice(0, 10);
  const remainingTurns = turns.slice(10);

  for (const turn of headerTurns) {
    transcript += `[${turn.role.toUpperCase()}]${turn.ts ? ` (${turn.ts})` : ''}\n${turn.content}\n\n`;
  }

  // Add remaining turns from newest first until we hit the limit
  let tailTranscript = '';
  let truncatedTurns = 0;
  for (let i = remainingTurns.length - 1; i >= 0; i--) {
    const turn = remainingTurns[i];
    const entry = `[${turn.role.toUpperCase()}]${turn.ts ? ` (${turn.ts})` : ''}\n${turn.content}\n\n`;
    if (transcript.length + entry.length + tailTranscript.length > maxChars) {
      truncatedTurns = i + 1;
      transcript += `\n[... ${truncatedTurns} earlier turns truncated for size ...]\n\n`;
      break;
    }
    tailTranscript = entry + tailTranscript;
  }
  transcript += tailTranscript;

  const comandosUnicos = Array.from(new Set(comandos.map(c => primeraLinea(c, 160))));
  const facts = {
    modifiedFiles: Array.from(archivos).slice(0, MAX_ARCHIVOS),
    executedCommands: comandosUnicos.slice(-MAX_COMANDOS),
    errors: errores,
    totalFiles: archivos.size,
    totalCommands: comandos.length,
    truncatedTurns
  };

  return { transcript, sessionMeta, totalTurns, facts, filePath };
}

// Los hechos van al prompt en su propia seccion: si la ventana del transcript se
// trunco, esto sigue cubriendo la sesion completa.
function renderFacts(facts) {
  if (!facts) return '';
  const lineas = [];

  if (facts.modifiedFiles.length) {
    const extra = facts.totalFiles > facts.modifiedFiles.length
      ? ` (showing ${facts.modifiedFiles.length} of ${facts.totalFiles})`
      : '';
    lineas.push(`### Files touched by tools${extra}`);
    for (const f of facts.modifiedFiles) lineas.push(`- ${f}`);
  }

  if (facts.executedCommands.length) {
    const extra = facts.totalCommands > facts.executedCommands.length
      ? ` (showing the last ${facts.executedCommands.length} of ${facts.totalCommands})`
      : '';
    lineas.push(`${lineas.length ? '\n' : ''}### Commands executed${extra}`);
    for (const c of facts.executedCommands) lineas.push(`- \`${c}\``);
  }

  if (facts.errors.length) {
    lineas.push(`${lineas.length ? '\n' : ''}### Tool results that failed`);
    for (const e of facts.errors) lineas.push(`- ${e}`);
  }

  if (!lineas.length) return '';
  return '## Derived Facts\n\nExtracted mechanically from the log. This list covers the whole session even if the transcript below was truncated, so treat it as authoritative for coverage.\n\n'
    + lineas.join('\n');
}

module.exports = { preprocessSessionLog, toolResultText, renderFacts };
