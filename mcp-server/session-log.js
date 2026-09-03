/**
 * Pre-procesado del log JSONL de una sesion de Claude Code.
 *
 * Invariante que costo caro: en el JSONL NO existe un evento raiz de tipo
 * "tool_result". Las salidas de herramientas viajan anidadas dentro de eventos
 * type:"user", como bloques {type:"tool_result"} en message.content. Ramificar
 * sobre obj.type === 'tool_result' no matchea nunca, y aplanar el contenido con
 * (c.text || c.type) convierte cada salida en la palabra literal "tool_result",
 * descartando el grueso del log. Mismo patron que checkpoint.js.
 */
const fs = require('fs');

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

function preprocessSessionLog(filePath, maxChars = 500000) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  const turns = [];
  let sessionMeta = { cwd: null, branch: null, version: null, startTime: null, endTime: null };

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip queue operations (noise)
    if (obj.type === 'queue-operation') continue;

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

    // Process based on type
    if (obj.type === 'user' && obj.message) {
      const raw = obj.message.content;
      if (typeof raw === 'string') {
        if (raw.trim()) {
          turns.push({ role: 'user', content: raw.trim(), ts: obj.timestamp });
        }
      } else if (Array.isArray(raw)) {
        // Text blocks are the real user turn. tool_result blocks are the outputs
        // of the previous assistant turn's tool calls: Claude Code nests them
        // inside type:"user" events, there is no root-level tool_result type.
        const userText = raw
          .filter(c => c.type === 'text')
          .map(c => c.text || '')
          .join(' ')
          .trim();
        if (userText) {
          turns.push({ role: 'user', content: userText, ts: obj.timestamp });
        }
        for (const block of raw) {
          if (block.type !== 'tool_result') continue;
          const text = toolResultText(block.content);
          if (!text) continue;
          const truncated = text.slice(0, 300);
          turns.push({
            role: 'tool_result',
            content: `[Result${block.is_error ? ' ERROR' : ''}] ${truncated}${text.length > 300 ? '...' : ''}`,
            ts: obj.timestamp
          });
        }
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const content = typeof obj.message.content === 'string'
        ? obj.message.content
        : (Array.isArray(obj.message.content)
          ? obj.message.content
            .filter(c => c.type === 'text')
            .map(c => c.text || '')
            .join('\n')
          : '');
      if (content.trim()) {
        turns.push({ role: 'assistant', content: content.trim(), ts: obj.timestamp });
      }

      // Also extract tool_use blocks as condensed references
      if (Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name || 'unknown_tool';
            const inputPreview = block.input
              ? JSON.stringify(block.input).slice(0, 200)
              : '';
            turns.push({
              role: 'tool_call',
              content: `[Tool: ${toolName}] ${inputPreview}`,
              ts: obj.timestamp
            });
          }
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
  for (let i = remainingTurns.length - 1; i >= 0; i--) {
    const turn = remainingTurns[i];
    const entry = `[${turn.role.toUpperCase()}]${turn.ts ? ` (${turn.ts})` : ''}\n${turn.content}\n\n`;
    if (transcript.length + entry.length + tailTranscript.length > maxChars) {
      transcript += `\n[... ${i + 1} earlier turns truncated for size ...]\n\n`;
      break;
    }
    tailTranscript = entry + tailTranscript;
  }
  transcript += tailTranscript;

  return { transcript, sessionMeta, totalTurns, filePath };
}

module.exports = { preprocessSessionLog, toolResultText };
