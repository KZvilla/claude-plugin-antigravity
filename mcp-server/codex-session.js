/**
 * Adaptador del transcript Codex observado en codex-cli 0.154.0.
 *
 * `transcript_path` es una conveniencia del hook, no una API estable. Por eso
 * este modulo exige una cabecera session_meta coherente y solo consume items
 * completados que conoce. Si la identidad no coincide, falla cerrado.
 */
const fs = require('node:fs');
const path = require('node:path');

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function textFromBlocks(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(block => block && typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function resultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.trim();
  if (Array.isArray(result.content)) {
    return result.content
      .map(block => block && typeof block.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return JSON.stringify(result);
}

function commandText(item) {
  const parsed = Array.isArray(item.parsed_cmd)
    ? item.parsed_cmd.map(entry => entry && entry.cmd).filter(cmd => typeof cmd === 'string' && cmd.trim())
    : [];
  if (parsed.length) return parsed.join('\n');
  if (Array.isArray(item.command)) return item.command.map(String).join(' ');
  return typeof item.command === 'string' ? item.command : '';
}

function assertCodexMeta(meta, filePath, expectedSessionId) {
  if (!meta || meta.type !== 'session_meta' || !meta.payload) {
    throw new Error(`Unsupported Codex transcript: missing session_meta header (${filePath})`);
  }
  const sessionId = meta.payload.session_id || meta.payload.id;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
    throw new Error(`Unsupported Codex transcript: invalid session identity (${filePath})`);
  }
  if (expectedSessionId && sessionId !== expectedSessionId) {
    throw new Error(`Codex transcript identity mismatch: expected ${expectedSessionId}, found ${sessionId}`);
  }
  if (typeof meta.payload.cwd !== 'string' || !path.isAbsolute(meta.payload.cwd)) {
    throw new Error(`Unsupported Codex transcript: invalid cwd (${filePath})`);
  }
  return sessionId;
}

function readCodexMeta(filePath, expectedSessionId) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Codex transcript not found: ${filePath}`);
  }
  const first = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).find(line => line.trim());
  const meta = first ? parseLine(first) : null;
  const sessionId = assertCodexMeta(meta, filePath, expectedSessionId);
  return { sessionId, payload: meta.payload, timestamp: meta.timestamp || meta.payload.timestamp || null };
}

function isCodexTranscript(filePath) {
  try {
    readCodexMeta(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseCodexSession(filePath, expectedSessionId) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(line => line.trim());
  const metaLine = parseLine(lines[0]);
  const sessionId = assertCodexMeta(metaLine, filePath, expectedSessionId);
  const payload = metaLine.payload;
  const events = [];
  let endTime = metaLine.timestamp || payload.timestamp || null;

  for (const line of lines.slice(1)) {
    const row = parseLine(line);
    if (!row) continue;
    if (row.timestamp) endTime = row.timestamp;
    if (row.type !== 'event_msg' || row.payload?.type !== 'item_completed') continue;
    const item = row.payload.item;
    if (!item || typeof item.type !== 'string') continue;
    const ts = row.timestamp || null;

    if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
      const content = textFromBlocks(item.content);
      if (content) {
        events.push({
          kind: 'message',
          role: item.type === 'UserMessage' ? 'user' : 'assistant',
          content,
          ts
        });
      }
      continue;
    }

    if (item.type === 'CommandExecution') {
      const command = commandText(item);
      const output = [item.stdout, item.stderr, item.aggregated_output]
        .filter(value => typeof value === 'string' && value.trim())
        .join('\n')
        .trim();
      events.push({
        kind: 'tool',
        toolName: 'CommandExecution',
        input: { command, cwd: item.cwd || payload.cwd },
        output,
        isError: item.status !== 'completed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0),
        ts
      });
      continue;
    }

    if (item.type === 'FileChange') {
      const files = item.changes && typeof item.changes === 'object' ? Object.keys(item.changes) : [];
      events.push({
        kind: 'tool',
        toolName: 'FileChange',
        input: { files },
        output: [item.stdout, item.stderr].filter(Boolean).join('\n'),
        isError: item.status !== 'completed',
        ts
      });
      continue;
    }

    if (item.type === 'McpToolCall') {
      events.push({
        kind: 'tool',
        toolName: `${item.server || 'mcp'}:${item.tool || item.actionName || 'unknown'}`,
        input: item.arguments && typeof item.arguments === 'object' ? item.arguments : {},
        output: resultText(item.result),
        isError: item.status !== 'completed' || Boolean(item.result?.isError),
        ts
      });
    }
  }

  return {
    host: 'codex',
    sessionId,
    sessionMeta: {
      cwd: payload.cwd,
      branch: payload.git?.branch || null,
      version: payload.cli_version || null,
      startTime: metaLine.timestamp || payload.timestamp || null,
      endTime
    },
    events,
    filePath
  };
}

// Representacion intermedia compatible con los extractores Claude existentes.
// No se escribe al disco: permite conservar literalmente el camino Claude y
// limitar el cambio a la adaptacion del host.
function codexAsClaudeObjects(parsed) {
  const rows = [{
    type: 'system',
    host: 'codex',
    cwd: parsed.sessionMeta.cwd,
    gitBranch: parsed.sessionMeta.branch,
    version: `codex-cli ${parsed.sessionMeta.version || 'unknown'}`,
    timestamp: parsed.sessionMeta.startTime
  }];
  let sequence = 0;
  for (const event of parsed.events) {
    if (event.kind === 'message') {
      rows.push({ type: event.role, message: { content: event.content }, timestamp: event.ts });
      continue;
    }
    if (event.kind !== 'tool') continue;
    const id = `codex-tool-${++sequence}`;
    let uses;
    if (event.toolName === 'CommandExecution') {
      uses = [{ type: 'tool_use', id, name: 'Bash', input: event.input }];
    } else if (event.toolName === 'FileChange') {
      const files = Array.isArray(event.input.files) ? event.input.files : [];
      uses = files.map((file, index) => ({
        type: 'tool_use',
        id: `${id}-${index}`,
        name: 'Edit',
        input: { file_path: file }
      }));
    } else {
      uses = [{ type: 'tool_use', id, name: event.toolName, input: event.input }];
    }
    if (uses.length) rows.push({ type: 'assistant', message: { content: uses }, timestamp: event.ts });
    if (event.toolName !== 'FileChange') {
      rows.push({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            is_error: event.isError,
            content: event.output || ''
          }]
        },
        timestamp: event.ts
      });
    }
  }
  return rows;
}

module.exports = {
  codexAsClaudeObjects,
  commandText,
  isCodexTranscript,
  parseCodexSession,
  readCodexMeta,
  resultText,
  textFromBlocks
};
