/** Session discovery shared by Claude and the optional Codex transcript hook. */
const fs = require('node:fs');
const path = require('node:path');
const { readCodexMeta } = require('./codex-session.js');

const POINTER_VERSION = 1;
const POINTER_DIR = 'session-sources';

function safeSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null;
}

function canonical(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pluginDataDir(env = process.env) {
  const value = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  return value && path.isAbsolute(value) ? path.resolve(value) : null;
}

function pointerDirectory(env = process.env) {
  const root = pluginDataDir(env);
  return root ? path.join(root, POINTER_DIR) : null;
}

function validateHookInput(input) {
  const sessionId = safeSessionId(input?.session_id);
  if (!sessionId) throw new Error('Invalid Codex session_id');
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw new Error('Invalid Codex cwd');
  const transcriptPath = input.transcript_path;
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || path.extname(transcriptPath).toLowerCase() !== '.jsonl') {
    throw new Error('Invalid Codex transcript_path');
  }
  return { sessionId, cwd: path.resolve(input.cwd), transcriptPath: path.resolve(transcriptPath) };
}

function recordCodexSession(input, env = process.env) {
  if (!env.PLUGIN_ROOT) return { skipped: true, reason: 'not-codex' };
  const dir = pointerDirectory(env);
  if (!dir) throw new Error('PLUGIN_DATA is required for Codex session pointers');
  const { sessionId, cwd, transcriptPath } = validateHookInput(input);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${sessionId}.json`);
  const pointer = {
    version: POINTER_VERSION,
    host: 'codex',
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    active: input.hook_event_name !== 'SessionEnd',
    source: input.source || null,
    updated_at: new Date().toISOString()
  };
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(pointer, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  return pointer;
}

function readPointer(filePath) {
  const pointer = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const expected = path.basename(filePath, '.json');
  if (pointer.version !== POINTER_VERSION || pointer.host !== 'codex' || safeSessionId(pointer.session_id) !== expected) {
    throw new Error(`Invalid Codex session pointer: ${filePath}`);
  }
  if (!path.isAbsolute(pointer.cwd) || !path.isAbsolute(pointer.transcript_path)) {
    throw new Error(`Invalid paths in Codex session pointer: ${filePath}`);
  }
  const meta = readCodexMeta(pointer.transcript_path, pointer.session_id);
  if (canonical(meta.payload.cwd) !== canonical(pointer.cwd)) {
    throw new Error(`Codex transcript cwd mismatch for session ${pointer.session_id}`);
  }
  return pointer;
}

function listCodexPointers(env = process.env) {
  const dir = pointerDirectory(env);
  if (!dir || !fs.existsSync(dir)) return [];
  const pointers = [];
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
    try { pointers.push(readPointer(path.join(dir, name))); } catch {}
  }
  return pointers;
}

function getProjectLogDir(cwd, env = process.env) {
  const homeDir = env.HOME || env.USERPROFILE || '';
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  const normalizedCwd = (cwd || process.cwd()).replace(/\\/g, '/');
  const entries = fs.readdirSync(projectsDir);
  const encoded = normalizedCwd.replace(/^\//, '').replace(/:/g, '').replace(/\//g, '-');
  const winEncoded = (cwd || process.cwd()).replace(/:/g, '').replace(/\\/g, '-').replace(/\//g, '-');
  for (const entry of entries) {
    if (entry.toLowerCase() === encoded.toLowerCase() || entry.toLowerCase() === winEncoded.toLowerCase()) {
      const full = path.join(projectsDir, entry);
      if (fs.statSync(full).isDirectory()) return full;
    }
  }
  const cwdBase = path.basename(cwd || process.cwd()).toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase().includes(cwdBase)) {
      const full = path.join(projectsDir, entry);
      if (fs.statSync(full).isDirectory()) return full;
    }
  }
  return null;
}

function findClaudeSessionFile(logDir, sessionId) {
  if (!logDir || !fs.existsSync(logDir)) return null;
  if (sessionId) {
    const safeId = safeSessionId(sessionId);
    if (!safeId) return null;
    const target = path.resolve(logDir, `${safeId}.jsonl`);
    const root = path.resolve(logDir);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    return fs.existsSync(target) ? target : null;
  }
  const files = fs.readdirSync(logDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => ({ path: path.join(logDir, name), mtime: fs.statSync(path.join(logDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.path || null;
}

function resolveSessionSource({ cwd, sessionId, env = process.env }) {
  const wantedCwd = canonical(cwd || process.cwd());
  const codexHost = Boolean(env.PLUGIN_ROOT);
  const safeId = sessionId ? safeSessionId(sessionId) : null;
  if (sessionId && !safeId) return { error: 'Invalid session_id.' };
  const codex = listCodexPointers(env).filter(pointer => canonical(pointer.cwd) === wantedCwd);
  if (safeId) {
    const match = codex.find(pointer => pointer.session_id === safeId);
    if (match) return { host: 'codex', sessionId: match.session_id, filePath: match.transcript_path };
  } else {
    const active = codex.filter(pointer => pointer.active);
    if (active.length === 1) {
      const match = active[0];
      return { host: 'codex', sessionId: match.session_id, filePath: match.transcript_path };
    }
    if (active.length > 1) {
      return {
        error: `Multiple active Codex sessions share this cwd; pass session_id explicitly: ${active.map(p => p.session_id).join(', ')}`,
        ambiguous: true
      };
    }
  }

  if (codexHost) {
    return {
      error: safeId
        ? `Codex session "${safeId}" has no valid pointer. Review and trust the Lagrange hooks, then retry.`
        : 'No active Codex session pointer was found. Review and trust the Lagrange hooks, then start or resume the session.',
      codex: true
    };
  }

  const logDir = getProjectLogDir(cwd, env);
  const claudeFile = findClaudeSessionFile(logDir, safeId);
  if (claudeFile) {
    return { host: 'claude', sessionId: path.basename(claudeFile, '.jsonl'), filePath: claudeFile, logDir };
  }
  return {
    error: safeId
      ? `Session ID "${safeId}" was not found in Codex plugin data or Claude project logs.`
      : 'No unambiguous Codex session pointer or Claude project log was found.'
  };
}

module.exports = {
  POINTER_DIR,
  POINTER_VERSION,
  findClaudeSessionFile,
  getProjectLogDir,
  listCodexPointers,
  pluginDataDir,
  readPointer,
  recordCodexSession,
  resolveSessionSource,
  safeSessionId
};
