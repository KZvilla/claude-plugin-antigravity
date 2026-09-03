#!/usr/bin/env node

/**
 * parse_claude_session.js
 * 
 * Extracts and cleans Claude Code session logs (CLI or VS Code extension)
 * directly from local storage (~/.claude/sessions and ~/.claude/projects).
 * Zero external dependencies — pure Node.js standard library.
 *
 * DUPLICACION CONOCIDA: mcp-server/session-log.js hace el mismo parseo para la
 * herramienta agy_session_summary. No se puede unificar: este fichero se copia
 * a ~/.gemini/config/skills/claude-compact/ (ver install.ps1) y corre dentro de
 * Antigravity, sin acceso al repositorio.
 *
 * Este parser fue el primero en tratar bien los bloques tool_result -- van
 * anidados dentro de eventos type:"user", no como un tipo raiz -- y la version
 * de produccion arrastraba el fallo. De ahi salieron tambien los hechos
 * derivados (modifiedFiles, executedCommands, errors) que hoy usa el prompt del
 * resumen. Si tocas el parseo aqui, mira si aplica alla, y al reves.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function getHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function getClaudeDir() {
  return path.join(getHomeDir(), '.claude');
}

function encodeProjectDir(cwd) {
  if (!cwd) return '';
  const normalized = path.resolve(cwd);
  // Match Claude Code project directory encoding format
  return normalized.replace(/:/g, '-').replace(/[\\\/ ]+/g, '-');
}

function getActiveSessions() {
  const sessionsDir = path.join(getClaudeDir(), 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const sessions = [];
  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = path.join(sessionsDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        sessions.push({
          pid: data.pid,
          sessionId: data.sessionId,
          cwd: data.cwd,
          entrypoint: data.entrypoint || 'cli',
          status: data.status || 'active',
          startedAt: data.startedAt,
          updatedAt: data.updatedAt,
          filePath
        });
      } catch {}
    }
  } catch {}
  return sessions;
}

function getAllProjects() {
  const projectsDir = path.join(getClaudeDir(), 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  try {
    return fs.readdirSync(projectsDir)
      .map(entry => ({
        name: entry,
        path: path.join(projectsDir, entry)
      }))
      .filter(p => fs.statSync(p.path).isDirectory());
  } catch {
    return [];
  }
}

function listAllSessions() {
  const active = getActiveSessions();
  const projects = getAllProjects();
  const sessionList = [];

  for (const proj of projects) {
    try {
      const files = fs.readdirSync(proj.path).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        const filePath = path.join(proj.path, f);
        const stat = fs.statSync(filePath);
        const sessionId = path.basename(f, '.jsonl');
        const activeMatch = active.find(a => a.sessionId === sessionId);

        sessionList.push({
          sessionId,
          projectFolder: proj.name,
          filePath,
          sizeBytes: stat.size,
          sizeKb: (stat.size / 1024).toFixed(1),
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
          isActive: !!activeMatch,
          pid: activeMatch ? activeMatch.pid : null,
          entrypoint: activeMatch ? activeMatch.entrypoint : 'offline',
          cwd: activeMatch ? activeMatch.cwd : null
        });
      }
    } catch {}
  }

  // Sort by modification time descending
  sessionList.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  return { active, all: sessionList };
}

function resolveSessionFile(targetCwd, sessionTarget) {
  const active = getActiveSessions();
  const projectsDir = path.join(getClaudeDir(), 'projects');

  // Case 1: Specific PID or Session ID passed
  if (sessionTarget) {
    const isPid = /^\d+$/.test(String(sessionTarget).trim());
    if (isPid) {
      const pid = parseInt(String(sessionTarget).trim(), 10);
      const matchedActive = active.find(a => a.pid === pid);
      if (matchedActive && matchedActive.sessionId) {
        sessionTarget = matchedActive.sessionId;
      }
    }

    const cleanId = path.basename(sessionTarget).replace(/[^a-zA-Z0-9_-]/g, '');
    // Search in all project dirs
    const projects = getAllProjects();
    for (const proj of projects) {
      const candidate = path.join(proj.path, `${cleanId}.jsonl`);
      if (fs.existsSync(candidate)) {
        return { filePath: candidate, sessionId: cleanId, projectFolder: proj.name };
      }
    }
  }

  // Case 2: Match active session by cwd
  const normCwd = targetCwd ? path.resolve(targetCwd).toLowerCase() : process.cwd().toLowerCase();
  const activeInCwd = active.find(a => a.cwd && path.resolve(a.cwd).toLowerCase() === normCwd);
  if (activeInCwd && activeInCwd.sessionId) {
    const encoded = encodeProjectDir(activeInCwd.cwd);
    const candidate = path.join(projectsDir, encoded, `${activeInCwd.sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return { filePath: candidate, sessionId: activeInCwd.sessionId, projectFolder: encoded, isActive: true, pid: activeInCwd.pid };
    }
    // Search anywhere for the active sessionId
    for (const proj of getAllProjects()) {
      const candidate2 = path.join(proj.path, `${activeInCwd.sessionId}.jsonl`);
      if (fs.existsSync(candidate2)) {
        return { filePath: candidate2, sessionId: activeInCwd.sessionId, projectFolder: proj.name, isActive: true, pid: activeInCwd.pid };
      }
    }
  }

  // Case 3: Match most recent .jsonl in encoded project directory
  if (targetCwd) {
    const encoded = encodeProjectDir(targetCwd);
    const targetDir = path.join(projectsDir, encoded);
    if (fs.existsSync(targetDir)) {
      const files = fs.readdirSync(targetDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: path.join(targetDir, f),
          mtime: fs.statSync(path.join(targetDir, f)).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        const sessionId = path.basename(files[0].name, '.jsonl');
        return { filePath: files[0].path, sessionId, projectFolder: encoded };
      }
    }

    // Fuzzy match project folders containing basename
    const baseName = path.basename(targetCwd).toLowerCase();
    const fuzzyProj = getAllProjects().find(p => p.name.toLowerCase().includes(baseName));
    if (fuzzyProj) {
      const files = fs.readdirSync(fuzzyProj.path)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          name: f,
          path: path.join(fuzzyProj.path, f),
          mtime: fs.statSync(path.join(fuzzyProj.path, f)).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        const sessionId = path.basename(files[0].name, '.jsonl');
        return { filePath: files[0].path, sessionId, projectFolder: fuzzyProj.name };
      }
    }
  }

  // Case 4: Pick globally most recent session log
  const sessionData = listAllSessions();
  if (sessionData.all.length > 0) {
    const latest = sessionData.all[0];
    return { filePath: latest.filePath, sessionId: latest.sessionId, projectFolder: latest.projectFolder };
  }

  return null;
}

function parseSessionTranscript(filePath, maxChars = 1000000) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const rawContent = fs.readFileSync(filePath, 'utf8');
  const lines = rawContent.split(/\r?\n/).filter(l => l.trim());

  const metadata = {
    sessionId: path.basename(filePath, '.jsonl'),
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    startTime: null,
    endTime: null,
    totalLines: lines.length
  };

  const turns = [];
  const modifiedFiles = new Set();
  const executedCommands = [];
  const errors = [];

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip noise
    if (obj.type === 'queue-operation' || obj.type === 'file-history-delta') continue;

    // Capture metadata from events
    if (obj.cwd && !metadata.cwd) metadata.cwd = obj.cwd;
    if (obj.gitBranch && !metadata.gitBranch) metadata.gitBranch = obj.gitBranch;
    if (obj.version && !metadata.version) metadata.version = obj.version;
    if (obj.entrypoint && !metadata.entrypoint) metadata.entrypoint = obj.entrypoint;
    if (obj.timestamp) {
      if (!metadata.startTime) metadata.startTime = obj.timestamp;
      metadata.endTime = obj.timestamp;
    }

    if (obj.isMeta) continue;

    // User Message
    if (obj.type === 'user' && obj.message) {
      let content = '';
      if (typeof obj.message.content === 'string') {
        content = obj.message.content;
      } else if (Array.isArray(obj.message.content)) {
        content = obj.message.content.map(c => {
          if (typeof c === 'string') return c;
          if (c.text) return c.text;
          if (c.type === 'tool_result') {
            const res = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
            if (c.is_error || (res && res.includes('Error:'))) {
              errors.push(res.slice(0, 300));
            }
            return `[Tool Result: ${res.slice(0, 200)}]`;
          }
          return '';
        }).filter(Boolean).join('\n');
      }

      // Filter out caveat tags
      content = content.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '').trim();

      if (content) {
        turns.push({
          role: 'user',
          timestamp: obj.timestamp,
          content
        });
      }
    }

    // Assistant Message
    else if (obj.type === 'assistant' && obj.message) {
      let textParts = [];
      let toolParts = [];

      if (typeof obj.message.content === 'string') {
        textParts.push(obj.message.content);
      } else if (Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'thinking' && block.thinking) {
            // Keep significant thoughts briefly
            if (block.thinking.length > 50) {
              textParts.push(`*(Thought: ${block.thinking.slice(0, 250)}...)*`);
            }
          } else if (block.type === 'tool_use') {
            const toolName = block.name || 'unknown_tool';
            const input = block.input || {};

            // Track modified files
            if (input.file_path || input.path || input.TargetFile || input.file) {
              const fPath = input.file_path || input.path || input.TargetFile || input.file;
              modifiedFiles.add(fPath);
            }
            // Track bash commands
            if (input.command || input.CommandLine) {
              const cmd = input.command || input.CommandLine;
              executedCommands.push(cmd);
            }

            const inputSummary = JSON.stringify(input);
            toolParts.push(`[Call Tool: ${toolName} ${inputSummary.length > 150 ? inputSummary.slice(0, 150) + '...' : inputSummary}]`);
          }
        }
      }

      const combinedText = [...textParts, ...toolParts].join('\n').trim();
      if (combinedText) {
        turns.push({
          role: 'assistant',
          timestamp: obj.timestamp,
          content: combinedText
        });
      }
    }
  }

  // Format transcript
  let formattedTranscript = '';
  for (const t of turns) {
    const roleTag = t.role.toUpperCase();
    const timeTag = t.timestamp ? ` [${t.timestamp.slice(11, 19)}]` : '';
    formattedTranscript += `### ${roleTag}${timeTag}\n${t.content}\n\n`;
  }

  if (formattedTranscript.length > maxChars) {
    // Keep first 15 turns and last turns that fit
    const head = turns.slice(0, 15).map(t => `### ${t.role.toUpperCase()}\n${t.content}\n\n`).join('');
    let tail = '';
    for (let i = turns.length - 1; i >= 15; i--) {
      const turnStr = `### ${turns[i].role.toUpperCase()}\n${turns[i].content}\n\n`;
      if (head.length + tail.length + turnStr.length > maxChars) {
        tail = `\n*(... ${i - 14} earlier turns condensed for token efficiency ...)*\n\n` + tail;
        break;
      }
      tail = turnStr + tail;
    }
    formattedTranscript = head + tail;
  }

  return {
    metadata,
    stats: {
      totalTurns: turns.length,
      modifiedFiles: Array.from(modifiedFiles),
      executedCommands: executedCommands.slice(-10),
      recentErrors: errors.slice(-5)
    },
    transcript: formattedTranscript
  };
}

// CLI Execution Support
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
parse_claude_session.js - Extract and clean Claude Code session logs

Usage:
  node parse_claude_session.js [options]

Options:
  --list                    List all active and recent Claude Code sessions
  --cwd <path>              Target project directory (defaults to current dir)
  --session <id|pid>        Specific session UUID or PID to inspect
  --json                    Output full structured JSON
  --raw                     Output cleaned text transcript only
  --help, -h                Show this help
`);
    process.exit(0);
  }

  if (args.includes('--list')) {
    const data = listAllSessions();
    console.log('\n=== Active Claude Code Sessions ===');
    if (data.active.length === 0) {
      console.log('No active sessions found in ~/.claude/sessions/');
    } else {
      data.active.forEach(a => {
        console.log(`• PID: ${a.pid.toString().padEnd(6)} | Type: ${a.entrypoint.padEnd(14)} | Session: ${a.sessionId.slice(0, 8)}... | CWD: ${a.cwd}`);
      });
    }

    console.log('\n=== Recent Session Logs (~/.claude/projects) ===');
    data.all.slice(0, 10).forEach((s, idx) => {
      const activeTag = s.isActive ? `[ACTIVE PID:${s.pid}]` : '[OFFLINE]';
      console.log(`${(idx + 1).toString().padStart(2)}. ${activeTag.padEnd(18)} ${s.sessionId.slice(0, 8)}... | ${s.sizeKb.padStart(7)} KB | ${s.modifiedAt.slice(0, 19)} | ${s.projectFolder}`);
    });
    console.log('');
    process.exit(0);
  }

  let cwd = process.cwd();
  const cwdIdx = args.indexOf('--cwd');
  if (cwdIdx !== -1 && args[cwdIdx + 1]) {
    cwd = args[cwdIdx + 1];
  }

  let sessionTarget = null;
  const sessIdx = args.indexOf('--session');
  if (sessIdx !== -1 && args[sessIdx + 1]) {
    sessionTarget = args[sessIdx + 1];
  }

  const resolved = resolveSessionFile(cwd, sessionTarget);
  if (!resolved) {
    console.error(`[Error] Could not find Claude Code session for directory: ${cwd}`);
    console.error(`Run with --list to see all available sessions.`);
    process.exit(1);
  }

  try {
    const result = parseSessionTranscript(resolved.filePath);
    result.resolvedFile = resolved;

    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else if (args.includes('--raw')) {
      console.log(result.transcript);
    } else {
      console.log(`=== CLAUDE CODE SESSION EXTRACTED ===`);
      console.log(`Session ID   : ${result.metadata.sessionId}`);
      console.log(`Project      : ${result.metadata.cwd || resolved.projectFolder}`);
      console.log(`Git Branch   : ${result.metadata.gitBranch || 'unknown'}`);
      console.log(`Turns Parsed : ${result.stats.totalTurns}`);
      console.log(`Files Touched: ${result.stats.modifiedFiles.length}`);
      if (result.stats.modifiedFiles.length > 0) {
        console.log(`Modified List: ${result.stats.modifiedFiles.slice(0, 5).join(', ')}${result.stats.modifiedFiles.length > 5 ? '...' : ''}`);
      }
      console.log(`-------------------------------------\n`);
      console.log(result.transcript);
    }
  } catch (err) {
    console.error(`[Error] Failed to parse session log: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getActiveSessions,
  getAllProjects,
  listAllSessions,
  resolveSessionFile,
  parseSessionTranscript,
  encodeProjectDir
};
