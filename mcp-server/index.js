#!/usr/bin/env node

/**
 * Antigravity MCP Server for Claude Code
 * Bridges Claude Code / Claude CLI to the Antigravity CLI (`agy.exe`).
 * Implements MCP stdio JSON-RPC 2.0 protocol with zero external dependencies.
 * Includes granular ALLOW / DENY permissions, robust timeout handling, and telemetry / usage metrics.
 */

const { spawn, execFile, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  POLISH_SUGGESTED_OVER,
  normalizeSpokenText,
  getPolishPrompt,
  getPersonaPrompt
} = require('./spoken-text.js');
const { extractLastCheckpoint } = require('./checkpoint.js');
const { preprocessSessionLog, renderFacts, renderFinalState } = require('./session-log.js');
const { getSummaryPrompt, recuperarDocumentoEnlazado, validarDocumento, separarDigest, MARCA_DIGEST } = require('./summary-doc.js');
const { executeAgyStdin, executeAgyStreaming } = require('./agy-stream.js');
const { auditarDocumento, renderAuditoria, renderKeyPoints, getStrictReviewPrompt } = require('./summary-audit.js');
const { lanzarFanout } = require('./fanout.js');
const { invokeTelegramBridge } = require('./telegram-cli.js');
const { crearEscritorDeEstado, crearLectorDeControl, rutaProgreso, limpiarProgreso } = require('./fanout-estado.js');
const registroAgentes = require('./agents/registry.js');
const estadoAgentes = require('./agents/estado.js');
const memoriaAgentes = require('./agents/memoria.js');
const aprendizajeAgentes = require('./agents/aprendizaje.js');
const castAgentes = require('./agents/cast.js');
// BE-015 — Reglas de `--model`/`--effort` compartidas con el bot de Telegram.
const { esfuerzoParaCli, validarModeloEsfuerzo } = require('./lib/cli-compat.js');
const vb = require('./voicebox-server.js');
const om = require('./omnivoice.js');

// Verdad de campo para la verificacion. Si el directorio no es un repositorio
// git, se devuelve vacio y los chequeos que dependen de esto simplemente no
// opinan: es preferible a inventar un veredicto.
function leerShasDelRepo(cwd) {
  try {
    return execFileSync('git', ['log', '--format=%H', '-300'], { cwd, encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

function leerTagsDelRepo(cwd) {
  try {
    return execFileSync('git', ['tag', '-l'], { cwd, encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}
const http = require('node:http');
const { SentenceChunker } = require('./lib/sentence-chunker');
const { PRIMING_CHARLA, procesarEventosDrain } = require('./lib/voice-drain');

// Resolve agy binary location
function resolveAgyBin() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'agy.exe' : 'agy';

  // 1. Try PATH (using execFileSync without shell interpolation)
  try {
    const file = isWin ? 'where.exe' : 'which';
    const found = execFileSync(file, [binName], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {}

  // 2. Try default Windows LocalAppData path
  if (isWin && process.env.LOCALAPPDATA) {
    const localPath = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }

  // 3. Fallback to binName in PATH
  return binName;
}

const AGY_BIN = resolveAgyBin();

// Configuration Management
function loadConfig(cwd = process.cwd()) {
  const config = {
    defaultModel: process.env.AGY_MODEL || null,
    defaultEffort: process.env.AGY_EFFORT || null,
    defaultTimeoutMinutes: parseInt(process.env.AGY_TIMEOUT_MINUTES, 10) || 15,
    voiceboxUrl: process.env.VOICEBOX_URL || null,
    voiceboxPort: parseInt(process.env.VOICEBOX_PORT, 10) || null,
    ...vb.CONFIG_POR_DEFECTO,
    fanoutStatusline: true,
    fanoutStatuslineDelegate: null,
    fanoutControl: true,
    fanoutStopCheckIntervalMs: parseInt(process.env.AGY_FANOUT_STOP_INTERVAL_MS, 10) || 2000,
    fanoutProgressLog: true,
    permissions: {
      allow: ['read', 'edit', 'commands', 'network'],
      deny: [],
      deny_paths: ['.env*', '**/*.key', '**/*.pem'],
      deny_commands: ['git push*', 'git reset --hard*', 'npm publish*', 'rm -rf /*'],
      sandbox: false
    },
    configFile: null
  };

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const globalPath = path.join(homeDir, '.claude', 'antigravity.json');
  const projectPath = path.join(cwd, '.claude', 'antigravity.json');

  if (fs.existsSync(globalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
      if (parsed.model) config.defaultModel = parsed.model;
      if (parsed.effort) config.defaultEffort = parsed.effort;
      if (parsed.timeout_minutes) config.defaultTimeoutMinutes = parsed.timeout_minutes;
      if (parsed.voicebox_url) config.voiceboxUrl = parsed.voicebox_url;
      if (parsed.voicebox_port) config.voiceboxPort = parsed.voicebox_port;
      if (parsed.fanout_statusline !== undefined) config.fanoutStatusline = !!parsed.fanout_statusline;
      if (parsed.fanout_statusline_delegate !== undefined) config.fanoutStatuslineDelegate = parsed.fanout_statusline_delegate;
      if (parsed.fanout_control !== undefined) config.fanoutControl = !!parsed.fanout_control;
      if (parsed.fanout_stop_check_interval_ms !== undefined) config.fanoutStopCheckIntervalMs = parsed.fanout_stop_check_interval_ms;
      if (parsed.fanout_progress_log !== undefined) config.fanoutProgressLog = !!parsed.fanout_progress_log;
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      vb.aplicarClavesVoicebox(config, parsed);
      config.configFile = globalPath;
    } catch {}
  }

  if (fs.existsSync(projectPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
      if (parsed.model) config.defaultModel = parsed.model;
      if (parsed.effort) config.defaultEffort = parsed.effort;
      if (parsed.timeout_minutes) config.defaultTimeoutMinutes = parsed.timeout_minutes;
      if (parsed.voicebox_url) config.voiceboxUrl = parsed.voicebox_url;
      if (parsed.voicebox_port) config.voiceboxPort = parsed.voicebox_port;
      if (parsed.fanout_statusline !== undefined) config.fanoutStatusline = !!parsed.fanout_statusline;
      if (parsed.fanout_statusline_delegate !== undefined) config.fanoutStatuslineDelegate = parsed.fanout_statusline_delegate;
      if (parsed.fanout_control !== undefined) config.fanoutControl = !!parsed.fanout_control;
      if (parsed.fanout_stop_check_interval_ms !== undefined) config.fanoutStopCheckIntervalMs = parsed.fanout_stop_check_interval_ms;
      if (parsed.fanout_progress_log !== undefined) config.fanoutProgressLog = !!parsed.fanout_progress_log;
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      vb.aplicarClavesVoicebox(config, parsed);
      config.configFile = projectPath;
    } catch {}
  }

  return config;
}

// Claves de Voicebox headless que agy_set_config persiste (plan G).
const CLAVES_VOICEBOX_CONFIG = [
  'voicebox_autostart',
  'voicebox_server_exe',
  'voicebox_idle_unload_minutes',
  'voicebox_idle_shutdown_minutes',
  'statusline_voicebox',
  'omnivoice_port',
  'omnivoice_dir',
  'omnivoice_class_temperature',
  'voz_por_perfil'
];

function saveConfig(updates, scope = 'global', cwd = process.cwd()) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const targetDir = scope === 'project' ? path.join(cwd, '.claude') : path.join(homeDir, '.claude');
  const targetFile = path.join(targetDir, 'antigravity.json');

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let existing = {};
  if (fs.existsSync(targetFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    } catch {}
  }

  if (updates.model !== undefined) existing.model = updates.model;
  if (updates.effort !== undefined) existing.effort = updates.effort;
  if (updates.timeout_minutes !== undefined) existing.timeout_minutes = updates.timeout_minutes;
  if (updates.voicebox_url !== undefined) existing.voicebox_url = updates.voicebox_url;
  if (updates.voicebox_port !== undefined) existing.voicebox_port = updates.voicebox_port;
  if (updates.fanout_statusline !== undefined) existing.fanout_statusline = updates.fanout_statusline;
  if (updates.fanout_statusline_delegate !== undefined) existing.fanout_statusline_delegate = updates.fanout_statusline_delegate;
  if (updates.fanout_control !== undefined) existing.fanout_control = updates.fanout_control;
  if (updates.fanout_progress_log !== undefined) existing.fanout_progress_log = updates.fanout_progress_log;
  for (const clave of CLAVES_VOICEBOX_CONFIG) {
    if (updates[clave] !== undefined) existing[clave] = updates[clave];
  }
  if (updates.permissions !== undefined) {
    existing.permissions = {
      ...(existing.permissions || {}),
      ...updates.permissions
    };
  }

  fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2), 'utf8');
  return { targetFile, config: existing };
}

// Telemetry & Usage Tracking
function getUsageFilePath() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(homeDir, '.claude', 'antigravity-usage.json');
}

function getUsageLockFilePath() {
  return `${getUsageFilePath()}.lock`;
}

// ==============================================================================
// Exclusión mutua entre procesos sobre el fichero de uso
// ==============================================================================
//
// Dentro de un mismo proceso no hay carrera: `recordUsage` es enteramente
// síncrona, así que el event loop no puede interleavear dos ciclos
// leer-modificar-escribir. El riesgo es ENTRE procesos: cada sesión de Claude
// Code levanta su propio servidor MCP y todas escriben el mismo
// ~/.claude/antigravity-usage.json. Con fan-out de subagentes concurrentes eso
// pasa de improbable a rutinario.
//
// Aparte de la carrera, `writeFileSync` directo sobre el destino no es atómico:
// un corte a mitad deja JSON truncado, y el `catch` de `loadUsage` lo trataba
// como fichero ausente y devolvía contadores a cero. Se perdía el histórico sin
// una sola señal. Por eso ahora se escribe a temporal y se renombra.
//
// Mismo patrón que telegram-bridge/state.js, que ya resolvió esto para
// state.json.

const USAGE_LOCK_STALE_MS = 5000;
const USAGE_LOCK_WAIT_MS = 2000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireUsageLock() {
  const deadline = Date.now() + USAGE_LOCK_WAIT_MS;

  for (;;) {
    try {
      return fs.openSync(getUsageLockFilePath(), 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') {
        process.stderr.write(`[antigravity-mcp] No se pudo tomar el lock de uso: ${err.message}. Se escribe sin exclusión.\n`);
        return null;
      }
      try {
        if (Date.now() - fs.statSync(getUsageLockFilePath()).mtimeMs > USAGE_LOCK_STALE_MS) {
          fs.unlinkSync(getUsageLockFilePath());
          continue;
        }
      } catch {
        continue; // el lock desapareció entre el stat y ahora: reintentar
      }
      if (Date.now() >= deadline) {
        process.stderr.write('[antigravity-mcp] Lock de uso ocupado más de lo razonable. Se escribe sin exclusión.\n');
        return null;
      }
      sleepSync(20);
    }
  }
}

function releaseUsageLock(fd) {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(getUsageLockFilePath()); } catch {}
}

/**
 * Escritura atómica: temporal + rename. El rename sí es atómico dentro del mismo
 * volumen, así que ningún lector ve jamás un JSON a medio escribir.
 * `usageFile` se descarta al persistir: `loadUsage` lo reinyecta en cada lectura
 * y no tiene por qué acabar guardado dentro del propio fichero.
 */
function writeUsageAtomic(data) {
  const usageFile = getUsageFilePath();
  const { usageFile: _rutaDescartada, ...persistible } = data;
  const tmp = `${usageFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(persistible, null, 2), 'utf8');
    fs.renameSync(tmp, usageFile);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function loadUsage() {
  const usageFile = getUsageFilePath();
  const today = new Date().toISOString().slice(0, 10);

  const defaultUsage = {
    session_started_at: new Date().toISOString(),
    session: {
      total_calls: 0,
      calls_by_tool: { run: 0, plan: 0, review: 0, audit: 0, research: 0, summary: 0, narrate: 0, say: 0 },
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      total_duration_seconds: 0
    },
    today: {
      date: today,
      total_calls: 0,
      total_tokens: 0,
      total_duration_seconds: 0
    },
    last_call: null,
    quota_status: 'HEALTHY'
  };

  if (fs.existsSync(usageFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
      if (data.today && data.today.date !== today) {
        data.today = { date: today, total_calls: 0, total_tokens: 0, total_duration_seconds: 0 };
      }
      return { ...defaultUsage, ...data, usageFile };
    } catch (err) {
      // Hasta ahora este catch era mudo: un JSON corrupto devolvía los
      // contadores a cero sin dejar rastro de que se había perdido el histórico.
      process.stderr.write(`[antigravity-mcp] ${usageFile} ilegible (${err.message}); se parte de contadores en cero.\n`);
    }
  }

  return { ...defaultUsage, usageFile };
}

function recordUsage(tool, model, effort, conversationId, durationSeconds, usage, isError = false, errorMsg = '') {
  let fd = null;
  try {
    const claudeDir = path.dirname(getUsageFilePath());
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // El lock se toma antes de leer: el ciclo entero leer-modificar-escribir va
    // dentro, no solo la escritura. Leer fuera y escribir dentro seguiría
    // perdiendo la actualización de otro proceso.
    fd = acquireUsageLock();

    const data = loadUsage();
    const dur = typeof durationSeconds === 'number' ? durationSeconds : 0;
    const inp = (usage && usage.input_tokens) || 0;
    const out = (usage && usage.output_tokens) || 0;
    const think = (usage && usage.thinking_tokens) || 0;
    const cache = (usage && usage.cache_read_tokens) || 0;
    const tot = (usage && usage.total_tokens) || (inp + out);

    data.session.total_calls += 1;
    data.session.calls_by_tool[tool] = (data.session.calls_by_tool[tool] || 0) + 1;
    data.session.input_tokens += inp;
    data.session.output_tokens += out;
    data.session.thinking_tokens += think;
    data.session.cache_read_tokens += cache;
    data.session.total_tokens += tot;
    data.session.total_duration_seconds += dur;

    data.today.total_calls += 1;
    data.today.total_tokens += tot;
    data.today.total_duration_seconds += dur;

    if (errorMsg && (errorMsg.includes('429') || errorMsg.toLowerCase().includes('quota'))) {
      data.quota_status = 'RATE_LIMITED / QUOTA EXCEEDED';
    } else {
      data.quota_status = 'HEALTHY';
    }

    data.last_call = {
      tool,
      model: model || '(cli default)',
      effort: effort || 'default',
      conversation_id: conversationId || null,
      duration_seconds: dur,
      timestamp: new Date().toISOString(),
      is_error: isError,
      usage: {
        input_tokens: inp,
        output_tokens: out,
        thinking_tokens: think,
        cache_read_tokens: cache,
        total_tokens: tot
      }
    };

    writeUsageAtomic(data);
  } catch (err) {
    process.stderr.write(`[antigravity-mcp] Failed to record usage: ${err.message}\n`);
  } finally {
    releaseUsageLock(fd);
  }
}

function resetUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const fresh = {
    session_started_at: new Date().toISOString(),
    session: {
      total_calls: 0,
      calls_by_tool: { run: 0, plan: 0, review: 0, audit: 0, research: 0, summary: 0, narrate: 0, say: 0 },
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      total_duration_seconds: 0
    },
    today: {
      date: today,
      total_calls: 0,
      total_tokens: 0,
      total_duration_seconds: 0
    },
    last_call: null,
    quota_status: 'HEALTHY'
  };

  let fd = null;
  try {
    const claudeDir = path.dirname(getUsageFilePath());
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    fd = acquireUsageLock();
    writeUsageAtomic(fresh);
  } catch (err) {
    process.stderr.write(`[antigravity-mcp] Failed to reset usage: ${err.message}\n`);
  } finally {
    releaseUsageLock(fd);
  }
  return fresh;
}

function renderProgressBar(percent, length = 16) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * length);
  const empty = length - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${p.toFixed(1)}%`;
}

// `agy models` ya no sirve solo Gemini: tambien Claude y GPT-OSS. La version
// anterior tomaba cualquier nombre sin "pro" por Gemini Flash, asi que
// `claude-sonnet-4-6` se reportaba como «Google Gemini Flash» con 1M de
// contexto -- una cifra inventada presentada como dato.
//
// Las ventanas de Gemini estan documentadas por Antigravity (Flash ~1M, Pro
// ~2M, ambos hasta 64k de salida). Para el resto no tenemos cifra fiable, y
// preferimos decir que no la sabemos antes que rellenarla.
function getModelSpecs(modelName) {
  const m = (modelName || '').toLowerCase();

  if (m.includes('claude')) {
    return {
      name: modelName,
      contextWindow: null,
      maxOutput: null,
      description: 'Anthropic Claude, served through Antigravity'
    };
  }
  if (m.includes('gpt') || m.includes('oss')) {
    return {
      name: modelName,
      contextWindow: null,
      maxOutput: null,
      description: 'GPT-OSS, served through Antigravity'
    };
  }
  if (m.includes('pro')) {
    return {
      name: modelName || 'gemini-3.1-pro',
      contextWindow: 2097152,
      maxOutput: 65536,
      description: 'Google Gemini Pro (Deep Reasoning & Multi-Turn Architecture)'
    };
  }
  return {
    name: modelName || 'gemini-3.8-flash',
    contextWindow: 1048576,
    maxOutput: 65536,
    description: 'Google Gemini Flash (High-Speed Hybrid Thinking)'
  };
}

function formatTokens(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function formatDuration(sec) {
  const s = Math.round(sec || 0);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return `${m}m ${rem}s`;
}

const DEFAULT_ALLOW = ['read', 'edit', 'commands', 'network'];

/**
 * Merge per-call `permissions` over the persisted config policy.
 * Per-call keys replace (not merge with) the config value, so a caller can
 * clear a base deny list by passing an explicit empty array.
 */
function resolvePermissions(callPerms = {}, config = {}) {
  const basePerms = config.permissions || {};
  return {
    allow: callPerms.allow || basePerms.allow || DEFAULT_ALLOW,
    deny: callPerms.deny || basePerms.deny || [],
    deny_paths: callPerms.deny_paths || basePerms.deny_paths || [],
    deny_commands: callPerms.deny_commands || basePerms.deny_commands || [],
    sandbox: callPerms.sandbox !== undefined ? callPerms.sandbox : (basePerms.sandbox || false)
  };
}

function permits(perms, capability) {
  return !perms.deny.includes(capability) && perms.allow.includes(capability);
}

/**
 * Build the natural-language guardrails injected ahead of the task prompt.
 * `readOnly` tools (plan/review/audit/summary) are already locked to `--mode plan`
 * at the CLI level, so they skip the edit rule but still need path, command and
 * network restrictions — those are not enforced by plan mode.
 */
function buildSecurityRules(perms, { readOnly = false } = {}) {
  const rules = [];

  if (readOnly) {
    rules.push('- READ-ONLY SESSION: Do not write or edit any files. Analysis and reporting only.');
  } else if (!permits(perms, 'edit')) {
    rules.push('- EDIT PERMISSION DENIED: You are operating in STRICT READ-ONLY mode. Do not write or edit any files.');
  }

  if (!permits(perms, 'commands')) {
    rules.push('- COMMAND EXECUTION DENIED: Do not run or propose any shell/terminal commands.');
  }
  if (!permits(perms, 'network')) {
    rules.push('- NETWORK ACCESS DENIED: Do not use web search, fetch URLs, or make any outbound network request. If the task requires live information from the internet, stop and report that it cannot be completed under the current network policy instead of answering from memory.');
  }
  if (perms.deny_paths.length > 0) {
    rules.push(`- FORBIDDEN PATHS: You MUST NEVER access, read, write, or mention contents of these path patterns: ${perms.deny_paths.join(', ')}`);
  }
  if (perms.deny_commands.length > 0) {
    rules.push(`- FORBIDDEN COMMANDS: You MUST NEVER execute commands matching: ${perms.deny_commands.join(', ')}`);
  }

  return rules;
}

function applyGuardrails(prompt, rules) {
  if (rules.length === 0) return prompt;
  return `[SECURITY & PERMISSION GUARDRAILS ENFORCED BY USER POLICY]
${rules.join('\n')}
If any requested action violates these rules, refuse that specific action and explain the restriction.

[TASK INSTRUCTIONS]
${prompt}`;
}

function formatPermissionSummary(perms) {
  return `allow=[${perms.allow.join(', ')}], deny=[${perms.deny.join(', ') || 'none'}], sandbox=${perms.sandbox}`;
}

const PERMISSIONS_SCHEMA = {
  type: 'object',
  description: 'Granular ALLOW and DENY permission policies for this subagent execution. Overrides the persisted policy in .claude/antigravity.json for this call only.',
  properties: {
    allow: {
      type: 'array',
      items: { type: 'string' },
      description: 'Explicitly allowed capabilities: "read", "edit", "commands", "network".'
    },
    deny: {
      type: 'array',
      items: { type: 'string' },
      description: 'Explicitly denied capabilities (e.g. "edit" for read-only, "commands" to forbid shell execution, "network" to forbid web access).'
    },
    deny_paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Path patterns forbidden from being read or modified (e.g. [".env*", "**/*.key"]).'
    },
    deny_commands: {
      type: 'array',
      items: { type: 'string' },
      description: 'Command patterns forbidden from being executed (e.g. ["git push*", "npm publish*"]).'
    },
    sandbox: {
      type: 'boolean',
      description: 'Enable Antigravity terminal sandbox restrictions (--sandbox).'
    }
  }
};

// Read-only tools are locked to `--mode plan`, so "edit" is denied regardless of
// what the policy says; the remaining keys still apply.
const READONLY_PERMISSIONS_SCHEMA = {
  ...PERMISSIONS_SCHEMA,
  description: 'Permission policy overrides for this call. This tool is always read-only (file edits are impossible regardless of policy), but "commands", "network", deny_paths, deny_commands and sandbox are enforced. Defaults to the persisted policy in .claude/antigravity.json.'
};

// MCP Tool Definitions
const TOOLS = [
  {
    name: 'agy_run',
    description: 'Execute Antigravity CLI (agy) as an autonomous subagent with optional granular ALLOW / DENY permission policies and configurable timeouts. Antigravity can edit files, run shell commands, perform deep reasoning, and access workspace tools. Returns structured response with conversation_id.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The task, instructions, or question to delegate to Antigravity.'
        },
        model: {
          type: 'string',
          description: 'Model override for Antigravity session (e.g. "gemini-3.8-flash", "gemini-3.1-pro"). Falls back to configured default.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level. If omitted, the configured default applies only to Gemini models without an effort suffix; otherwise agy decides. Claude, GPT-OSS and suffixed models reject an explicit effort. An explicit effort without a model cannot be checked in advance: agy picks the model from its own settings.'
        },
        conversation_id: {
          type: 'string',
          description: 'Previous conversation ID to resume/continue an ongoing multi-turn session with Antigravity.'
        },
        continue_session: {
          type: 'boolean',
          description: 'Continue the most recent Antigravity conversation (-c).'
        },
        mode: {
          type: 'string',
          enum: ['accept-edits', 'plan'],
          description: 'Agent execution mode: "accept-edits" (default, can edit code) or "plan" (pure planning/analysis).'
        },
        permissions: PERMISSIONS_SCHEMA,
        cwd: {
          type: 'string',
          description: 'Working directory for the session. Defaults to Claude\'s current working directory.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes before canceling execution. Defaults to 15 (configured in ~/.claude/antigravity.json).'
        },
        dangerously_skip_permissions: {
          type: 'boolean',
          description: 'Auto-approve tool permissions without interactive prompting (essential for headless subagent execution). Defaults to true.'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'agy_fanout',
    description: 'Run several Antigravity subagents CONCURRENTLY, one per isolated git worktree, for a plan already broken into atomic tasks. Validates that the tasks are disjoint in files BEFORE spending any quota, resolves a safe base branch (never main/master), creates one worktree and branch per task, and executes them in batches with a concurrency cap and quota backoff. Subagents implement only: they are instructed not to write or run tests, not to merge, and not to spawn subagents. Auditing the diffs, running the tests and merging stay with the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Short name for the batch. Names the base branch (if one must be created), the worktrees and their branches.'
        },
        tareas: {
          type: 'array',
          description: 'The atomic tasks. They must be disjoint in files: worktrees isolate execution, not integration, so overlapping tasks just move the conflict to merge time. The batch is rejected if any two overlap.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for the task.' },
              prompt: { type: 'string', description: 'What this subagent must implement.' },
              archivos: {
                type: 'array',
                items: { type: 'string' },
                description: 'Repo-relative paths this task is allowed to touch. A trailing "/" marks a whole subtree. Absolute paths and ".." are rejected.'
              },
              modelo: { type: 'string', description: 'Per-task model override.' },
              effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Per-task effort override.' },
              soloLectura: { type: 'boolean', description: 'Run this task in plan mode (the only read-only with real enforcement).' }
            },
            required: ['id', 'prompt', 'archivos']
          }
        },
        concurrencia: {
          type: 'number',
          description: 'Maximum subagents running at once. Defaults to 3. The cap exists for quota, not CPU.'
        },
        modelo: { type: 'string', description: 'Default model for the batch. Defaults to the configured one.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default effort for the batch. If omitted, the configured default applies only to Gemini models without an effort suffix.' },
        cwd: { type: 'string', description: 'Repository root. Defaults to Claude\'s current working directory.' },
        timeout_minutes: { type: 'number', description: 'Per-subagent timeout. Defaults to 15.' }
      },
      required: ['slug', 'tareas']
    }
  },
  {
    name: 'agy_plan',
    description: 'Ask Antigravity to analyze the codebase and generate an architectural or implementation plan without executing modifications (enforces read-only policy).',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The feature, refactor, or problem to create a detailed implementation plan for.'
        },
        model: {
          type: 'string',
          description: 'Model override for planning session (e.g. "gemini-3.1-pro", "gemini-3.8-flash").'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level. If omitted, the configured default applies only to Gemini models without an effort suffix; otherwise agy decides. Claude, GPT-OSS and suffixed models reject an explicit effort. An explicit effort without a model cannot be checked in advance: agy picks the model from its own settings.'
        },
        conversation_id: {
          type: 'string',
          description: 'Previous conversation ID to resume/continue an ongoing planning thread (e.g. to refine a plan without leaving read-only mode).'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 15.'
        },
        permissions: READONLY_PERMISSIONS_SCHEMA,
        cwd: {
          type: 'string',
          description: 'Working directory for analysis.'
        }
      },
      required: ['task']
    }
  },
  {
    name: 'agy_review',
    description: 'Ask Antigravity to perform an adversarial or complementary code review of recent changes, diffs, or specific files against guidelines and best practices (enforces read-only policy).',
    inputSchema: {
      type: 'object',
      properties: {
        review_target: {
          type: 'string',
          description: 'Target to review (e.g., "git diff", "unstaged changes", or file paths to inspect).'
        },
        guidelines: {
          type: 'string',
          description: 'Specific standards, architectural rules, or guidelines to check against (e.g. AGENTS.md, security, accessibility, contracts).'
        },
        model: {
          type: 'string',
          description: 'Model override for review session.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level. If omitted, the configured default applies only to Gemini models without an effort suffix; otherwise agy decides. Claude, GPT-OSS and suffixed models reject an explicit effort. An explicit effort without a model cannot be checked in advance: agy picks the model from its own settings.'
        },
        conversation_id: {
          type: 'string',
          description: 'Previous conversation ID to resume/continue an ongoing review thread.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 20 (can be increased for large repositories/diffs).'
        },
        permissions: READONLY_PERMISSIONS_SCHEMA,
        cwd: {
          type: 'string',
          description: 'Working directory.'
        }
      },
      required: ['review_target']
    }
  },
  {
    name: 'agy_audit',
    description: 'Run a skeptical, evidence-based adversarial audit via Antigravity. Two modes: (1) "implementation" — verify an implementation against a plan/spec/ticket, (2) "plan" — verify a proposed plan against the real codebase. Uses structured severity rubric (BLOCKER/MAJOR/MINOR/NOTE) and deterministic verdicts (FAIL/PASS WITH RESERVATIONS/PASS). Much more rigorous and heavyweight than agy_review. Default timeout: 25 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'What to audit: git diff, file paths, branch name, PR description, or a plan/RFC text to check against the codebase.'
        },
        audit_mode: {
          type: 'string',
          enum: ['implementation', 'plan'],
          description: 'Audit mode: "implementation" = verify code against a plan/spec (Mode 1), "plan" = verify a proposed plan against the real project (Mode 2). Defaults to "implementation".'
        },
        plan: {
          type: 'string',
          description: 'The plan, spec, ticket, or acceptance criteria text to audit against. Required for "implementation" mode. In "plan" mode, the target itself is the plan being audited.'
        },
        model: {
          type: 'string',
          description: 'Model override (e.g. "gemini-3.1-pro" recommended for deep audits).'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level. If omitted, the configured default applies only to Gemini models without an effort suffix; otherwise agy decides. Claude, GPT-OSS and suffixed models reject an explicit effort. An explicit effort without a model cannot be checked in advance: agy picks the model from its own settings.'
        },
        conversation_id: {
          type: 'string',
          description: 'Previous conversation ID to resume/continue an ongoing audit thread.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 25 (adversarial audits are deep and heavyweight).'
        },
        permissions: READONLY_PERMISSIONS_SCHEMA,
        cwd: {
          type: 'string',
          description: 'Working directory.'
        }
      },
      required: ['target']
    }
  },
  {
    name: 'agy_research',
    description: 'Delegate deep web research to Antigravity, which uses Gemini\'s native search tools. Returns a structured report with an executive summary, numbered key findings, cited source URLs, and relevance to the current project. Read-only: never edits files. Requires the "network" capability — fails with an explicit error if network access is denied by the permission policy, rather than answering from the model\'s memory.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The research topic or question to investigate.'
        },
        project_context: {
          type: 'string',
          description: 'Optional description of how this relates to the current project, to focus the "Relevance" section. If omitted, Antigravity infers it from the codebase.'
        },
        recency: {
          type: 'string',
          description: 'Optional recency constraint for sources (e.g. "past 6 months", "2026 only"). Sources older than this should be flagged as potentially stale.'
        },
        model: {
          type: 'string',
          description: 'Model override for the research session.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level. If omitted, the configured default applies only to Gemini models without an effort suffix; otherwise agy decides. Claude, GPT-OSS and suffixed models reject an explicit effort. An explicit effort without a model cannot be checked in advance: agy picks the model from its own settings.'
        },
        conversation_id: {
          type: 'string',
          description: 'Previous conversation ID to resume a research thread and ask follow-up questions without re-running the whole search.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 20 (web research involves many sequential searches).'
        },
        permissions: READONLY_PERMISSIONS_SCHEMA,
        cwd: {
          type: 'string',
          description: 'Working directory, used to ground the "Relevance to Current Project" section.'
        }
      },
      required: ['topic']
    }
  },
  {
    name: 'agy_usage',
    description: 'Display model metrics, context window capacity, token consumption (input, output, thinking, cache read), and quota health for Antigravity subagent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        reset: {
          type: 'boolean',
          description: 'Reset session usage counters to 0.'
        },
        scope: {
          type: 'string',
          enum: ['session', 'today'],
          description: 'Display metrics for the current session (default) or cumulative for today.'
        }
      }
    }
  },
  {
    name: 'agy_status',
    description: 'Check the status, version, active model/effort/timeout defaults, ALLOW/DENY permission policies, and binary path of Antigravity CLI.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'agy_set_config',
    description: 'Set default model, reasoning effort, default timeout, or ALLOW/DENY permission policies for Antigravity subagent sessions (persisted in .claude/antigravity.json).',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Default model name (e.g. "gemini-3.8-flash", "gemini-3.1-pro").'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Default reasoning effort level.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Default timeout in minutes for Antigravity CLI sessions (default: 15).'
        },
        permissions: {
          type: 'object',
          description: 'Default ALLOW/DENY permissions policy.',
          properties: {
            allow: {
              type: 'array',
              items: { type: 'string' },
              description: 'Allowed capabilities: "read", "edit", "commands", "network".'
            },
            deny: {
              type: 'array',
              items: { type: 'string' },
              description: 'Denied capabilities (e.g. "edit", "commands", "network").'
            },
            deny_paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Path patterns to forbid (e.g. [".env*", "**/*.key"]).'
            },
            deny_commands: {
              type: 'array',
              items: { type: 'string' },
              description: 'Command patterns to forbid (e.g. ["git push*", "npm publish*"]).'
            },
            sandbox: {
              type: 'boolean',
              description: 'Enable terminal sandbox (--sandbox).'
            }
          }
        },
        scope: {
          type: 'string',
          enum: ['global', 'project'],
          description: 'Configuration scope: "global" (~/.claude/antigravity.json) or "project" (./.claude/antigravity.json). Defaults to "global".'
        },
        fanout_statusline: {
          type: 'boolean',
          description: 'Whether agy_fanout writes a live progress file for the statusline script to read. Default true; set false to disable writing it without disabling fanout itself.'
        },
        fanout_statusline_delegate: {
          type: 'string',
          description: 'The previous statusLine.command to preserve when installing fanout-statusline.js, so it keeps rendering whatever the user had (e.g. claude-hud) alongside the fanout segment. Set by the setup skill, not meant for manual use.'
        },
        fanout_control: {
          type: 'boolean',
          description: 'Whether agy_fanout watches per-task stop sentinels (.claude/worktrees/.fanout-stop-<slug>-<taskId>.json) and kills a running subagent early when one appears. Default true; set false to disable the stop mechanism without disabling fanout itself.'
        },
        fanout_progress_log: {
          type: 'boolean',
          description: 'Whether agy_fanout writes a live per-subagent NDJSON progress log (.claude/worktrees/.agy-progress-<slug>-<taskId>.jsonl), one line per stream-json event as it arrives. Default true; set false to skip writing it (agy_fanout still runs in streaming mode either way). This log is what /lagrange:watch renders.'
        },
        voicebox_url: {
          type: 'string',
          description: 'Default Voicebox HTTP endpoint (e.g. "http://127.0.0.1:17493").'
        },
        voicebox_port: {
          type: 'number',
          description: 'Default Voicebox port on 127.0.0.1.'
        },
        voicebox_autostart: {
          type: 'boolean',
          description: 'Start Voicebox headless (no desktop app) when a voice tool needs it and it is not running. Windows only. Default true.'
        },
        voicebox_server_exe: {
          type: 'string',
          description: 'Explicit path to the Voicebox server binary. Default: the CUDA backend under %APPDATA%\\sh.voicebox.app\\backends\\cuda, then the CPU one in Program Files.'
        },
        voicebox_idle_unload_minutes: {
          type: 'number',
          description: 'Minutes without use before an unpinned model is freed from GPU memory (only for a Voicebox the plugin started). Default 10.'
        },
        voicebox_idle_shutdown_minutes: {
          type: 'number',
          description: 'Minutes without use, with nothing loaded or pinned, before the headless Voicebox is shut down. 0 = never. Default 30.'
        },
        statusline_voicebox: {
          type: 'boolean',
          description: 'Show the Voicebox/VRAM segment in the statusline while Voicebox is running. Default true.'
        },
        omnivoice_port: {
          type: 'number',
          description: 'Port of the local OmniVoice server (second voice engine, installed with npm run omnivoice:install). Default 17494.'
        },
        omnivoice_dir: {
          type: 'string',
          description: 'Where OmniVoice is installed (venv and weights). Default %LOCALAPPDATA%\\lagrange-omnivoice.'
        },
        omnivoice_class_temperature: {
          type: 'number',
          description: 'Sampling temperature for OmniVoice: 0 is deterministic and flat. Default 0.7, chosen by ear.'
        },
        voz_por_perfil: {
          type: 'object',
          additionalProperties: { type: 'string', enum: ['omnivoice', 'voicebox'] },
          description: 'Per-voice engine override, e.g. {"Priscilla": "voicebox"}. Wins over modo.'
        }
      }
    }
  },
  {
    name: 'agy_session_summary',
    description: 'Read a Claude Code session log (JSONL) and generate a structured summary document via Gemini. Solves context compaction loss by creating persistent, high-quality session documentation with decisions, changes, problems, and continuation context. The summary is saved as a markdown file for future reference.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'UUID of the Claude Code session to summarize. If omitted, uses the most recent session for the current project.'
        },
        cwd: {
          type: 'string',
          description: 'Project working directory. Used to locate the correct session log directory under ~/.claude/projects/.'
        },
        output_path: {
          type: 'string',
          description: 'Custom file path for the summary. Must resolve inside the project root or ~/.claude. Defaults to ~/.claude/session-summaries/<date>-<session-id-short>.md'
        },
        narrate: {
          type: 'boolean',
          description: 'Speak a short digest of the summary aloud (Voicebox, and Telegram if configured). The digest is produced in the SAME call that writes the document, so it costs no extra model round-trip and is written by something that just read the whole session. Do not try to get this by passing the finished document to agy_say: measured on a 36 KB handoff, plain narration speaks 1029 characters (2.8%, cut mid-sentence) and the polish path only ever sees the first 12000 characters, so the pending work and the findings — which live at the end — never reach the ear. The saved document never contains the digest.'
        },
        personality: {
          type: 'boolean',
          description: 'Only with narrate: true. The spoken digest is written in the persona of the Voicebox voice profile (its description and personality fields), in the same Gemini call that writes the document. The document itself is unaffected. Defaults to false.'
        },
        key_points: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short points YOU know matter, declared from inside the session before summarizing. Each one is injected at the top of the prompt as mandatory to preserve, AND checked mechanically in the result: a missing one is a blocking finding. Use it for what a reader of the log cannot recover — method rules and invariants the session established the hard way ("verify each gate with its own exit code, never chain them through a pipe"), findings whose evidence is scattered, and approaches already tried and discarded. Measured: this class of content was lost in 6 of 6 runs across both models, and it is not a context-length problem. One sentence each, naming the concrete identifier, file or flag involved — that is what makes it verifiable. Not a substitute for the transcript: everything else is derived from the log.'
        },
        strict: {
          type: 'boolean',
          description: 'Verification level. A mechanical check always runs and never hallucinates: it compares the document against facts extracted from the log and against git (commit SHAs cited, the version the session actually ended at, file coverage). strict:true makes a mechanical blocking finding fail the call instead of only reporting it, and adds a second adversarial pass over the transcript for what a machine cannot check — unsupported causation, test verdicts with no command behind them, invented specifics. That second pass is ADVISORY: measured, it returned RECHAZADO accusing a correct document of inventing terms that appeared dozens of times in the transcript it was given, so its verdict never blocks. Roughly doubles time and tokens.'
        },
        focus: {
          type: 'string',
          enum: ['full', 'decisions', 'changes', 'debugging', 'handoff'],
          description: 'Summary focus area. "full" (default) covers everything. "decisions" emphasizes architectural/design choices. "changes" focuses on files modified. "debugging" highlights problems and resolutions. "handoff" produces a different document: a context transfer written for a fresh session starting cold, prioritizing findings that exist only in the conversation over anything recoverable from git, and ending in a copy-paste prompt. Use it before compacting or when the session is about to end.'
        },
        model: {
          type: 'string',
          description: 'Model override for summarization. Leave unset and the tool picks by the size of the PREPROCESSED prompt, not of the raw log: the configured default up to 700KB, and "gemini-3.1-pro" above that. The raw log size stopped predicting anything once the transcript became capped at 1MB — a 20MB log and a 7MB one now produce similar prompts. Setting this always wins, and the chosen model is reported in the output.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort for summarization. If omitted, the configured default applies only to Gemini models without an effort suffix (the Pro fallback for long sessions uses "high").'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 15.'
        },
        permissions: READONLY_PERMISSIONS_SCHEMA
      }
    }
  },
  {
    name: 'agy_voice_stream',
    description: 'Manage a persistent, streaming `agy.exe` process for low-latency conversational use ("Modo Charla"). Unlike agy_run, which blocks until the entire response is generated and then exits, this keeps one long-lived agy process alive across many turns and exposes incremental text_delta events for polling, avoiding per-turn cold starts and enabling sentence-level TTS pipelining. Actions: "start" (spawn the persistent process, optionally pre-warming Voicebox TTS in parallel), "send" (write one user turn to the running process), "drain" (retrieve and clear buffered stream events since the last drain — poll this in a loop while a turn is in flight), "status" (inspect a session without consuming its events), "stop" (terminate the process).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'send', 'drain', 'status', 'stop'],
          description: 'Operation to perform on the voice stream session.'
        },
        stream_id: {
          type: 'string',
          description: 'Session ID returned by "start". Required for "send", "drain", "status", and "stop".'
        },
        text: {
          type: 'string',
          description: 'User turn text to send to agy. Required for "send".'
        },
        model: {
          type: 'string',
          description: 'Model override for "start" (e.g. "gemini-3.8-flash", "gemini-3.7-flash").'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort for "start". Defaults to "low" (optimized for conversational latency, unlike agy_run\'s "high" default).'
        },
        mode: {
          type: 'string',
          enum: ['accept-edits', 'plan'],
          description: 'Agent execution mode for "start". Defaults to "plan" — voice chat is conversational by default, not a coding session.'
        },
        conversation_id: {
          type: 'string',
          description: 'Resume a previous agy conversation on "start" instead of beginning a new one.'
        },
        cwd: {
          type: 'string',
          description: 'Working directory for "start". Defaults to Claude\'s current working directory.'
        },
        dangerously_skip_permissions: {
          type: 'boolean',
          description: 'Auto-approve tool permissions on "start" without interactive prompting. Defaults to true (required for headless voice sessions).'
        },
        prime_conversational: {
          type: 'boolean',
          description: 'On "start", send one throwaway priming turn instructing agy to respond conversationally (short spoken sentences, no markdown, no file writes/plans) instead of treating spoken input like a coding task. Defaults to true — without it, agy can respond to a simple spoken question by writing a plan.md file instead of just answering. The priming exchange is drained away and never surfaced to the caller.'
        },
        prewarm_voicebox: {
          type: 'boolean',
          description: 'On "start", also fire a non-blocking POST /models/load to Voicebox so the TTS model is already in VRAM before the first spoken reply. Defaults to true.'
        },
        voicebox_model_size: {
          type: 'string',
          description: 'TTS model size to pre-warm in Voicebox (e.g. "1.7B", "0.6B"). Defaults to "1.7B".'
        },
        voicebox_url: {
          type: 'string',
          description: 'Custom Voicebox HTTP endpoint URL for pre-warming.'
        },
        voicebox_port: {
          type: 'number',
          description: 'Custom Voicebox port for pre-warming.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'agy_narrate',
    description: 'Narrate a voice summary of the latest completed checkpoint or task via Voicebox Text-To-Speech. Zero-Claude-token architecture: it takes no text and writes the script itself, extracting checkpoint details directly from Claude Code session logs and condensing them into a 2-3 sentence spoken update via Gemini (agy). To speak a specific message you already have, use agy_say instead.',
    inputSchema: {
      type: 'object',
      properties: {
        voice: {
          type: 'string',
          description: 'Voice profile name or keyword (e.g. "Emily", "Diego Alvarez", "Isabel", "Aria", "Aiden"). Defaults to "Emily" for English and "Diego Alvarez" for Spanish.'
        },
        language: {
          type: 'string',
          enum: ['en', 'es'],
          description: 'Spoken language ("es" or "en"). Automatically inferred from voice name if omitted.'
        },
        voicebox_url: {
          type: 'string',
          description: 'Custom Voicebox HTTP endpoint URL (defaults to configured URL or http://127.0.0.1:17493).'
        },
        voicebox_port: {
          type: 'number',
          description: 'Custom Voicebox port number if running on a non-default port.'
        },
        session_id: {
          type: 'string',
          description: 'Optional Claude Code session ID to summarize. Defaults to the current/most recent session.'
        },
        cwd: {
          type: 'string',
          description: 'Project working directory.'
        },
        model: {
          type: 'string',
          description: 'Model override for Gemini narration generation (defaults to fast gemini-3.8-flash).'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level for narration script generation. Defaults to "low" for near-instant speech generation.'
        },
        personality: {
          type: 'boolean',
          description: 'When true, agy (Gemini) writes the script in the persona of the Voicebox profile (its description and personality fields). Defaults to false (neutral professional tone).'
        },
        send_telegram: {
          type: 'boolean',
          description: 'When true (default: true if Telegram is configured), automatically delivers the synthesized speech as a native playable voice note to your mobile Telegram app.'
        },
        local_playback: {
          type: 'boolean',
          description: 'When true, plays the audio aloud through your PC speakers (synthesized via POST /generate, then played with the native OS player — never Voicebox /speak, which double-plays). Defaults to false: silent generation, delivered to Telegram without scaring anyone. The /lagrange:narrate slash command sets this to true, since asking for narration out loud implies hearing it.'
        },
        keep_model: {
          type: 'boolean',
          description: 'When true, pins this voice\'s TTS model in GPU memory until released with agy_voice_model (action "release"). Use it when the user says the interaction will go on with this voice, on PC or Telegram. Defaults to false: the model is freed after the idle timeout.'
        },
        modo: {
          type: 'string',
          enum: ['inmediato', 'diferido'],
          description: 'Which voice engine fits: "inmediato" (default) for something the user is waiting to hear now — uses OmniVoice (fast) when it is installed; "diferido" when the user asked to be told later ("when you finish, narrate it") — uses Qwen via Voicebox (slower, better prosody). A per-voice override in voz_por_perfil wins over this.'
        },
        motor: {
          type: 'string',
          enum: ['omnivoice', 'voicebox'],
          description: 'Force a voice engine, overriding modo and voz_por_perfil. OmniVoice needs a voice with a cloned sample; preset voices always use Voicebox.'
        }
      }
    }
  },
  {
    name: 'agy_say',
    description: 'Speak a specific text out loud via Voicebox Text-To-Speech, and optionally deliver it to Telegram as a voice note. Use this when YOU already have the exact message to say. To narrate a summary of what was just done in this session instead, use agy_narrate, which derives the script from the session log on its own and takes no text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to speak. Written for the ear, not the eye: keep it to a couple of sentences. Markdown, code blocks, URLs, file paths and emoji are stripped automatically (they are unlistenable), and anything that looks like a secret is redacted before it is spoken or sent. Text beyond ~1200 characters is truncated at a sentence boundary — pass polish:true instead to have it condensed.'
        },
        polish: {
          type: 'boolean',
          description: 'When true, agy (Gemini) rewrites the text into a short spoken-style update before synthesis. Costs an extra round-trip of a few seconds, so leave it off for text that is already short and conversational. Worth it for raw logs, long output, or notes that were written to be read rather than heard.'
        },
        keep_model: {
          type: 'boolean',
          description: 'When true, pins this voice\'s TTS model in GPU memory until released with agy_voice_model (action "release"). Use it when the user says the interaction will go on with this voice, on PC or Telegram. Defaults to false: the model is freed after the idle timeout.'
        },
        modo: {
          type: 'string',
          enum: ['inmediato', 'diferido'],
          description: 'Which voice engine fits: "inmediato" (default) for something the user is waiting to hear now — uses OmniVoice (fast) when it is installed; "diferido" when the user asked to be told later ("when you finish, narrate it") — uses Qwen via Voicebox (slower, better prosody). A per-voice override in voz_por_perfil wins over this.'
        },
        motor: {
          type: 'string',
          enum: ['omnivoice', 'voicebox'],
          description: 'Force a voice engine, overriding modo and voz_por_perfil. OmniVoice needs a voice with a cloned sample; preset voices always use Voicebox.'
        },
        voice: {
          type: 'string',
          description: 'Voice profile name or keyword (e.g. "Emily", "Diego Alvarez", "Isabel", "Aria", "Aiden"). Defaults to "Emily" for English and "Diego Alvarez" for Spanish.'
        },
        language: {
          type: 'string',
          enum: ['en', 'es'],
          description: 'Spoken language ("es" or "en"). Automatically inferred from voice name if omitted.'
        },
        personality: {
          type: 'boolean',
          description: 'When true, agy (Gemini) rewrites the text in the persona of the Voicebox profile (its description and personality fields), keeping all of its content. Adds a few seconds for that call. Defaults to false (neutral professional tone).'
        },
        local_playback: {
          type: 'boolean',
          description: 'When true, plays the audio aloud through the PC speakers. Defaults to false: silent generation, delivered to Telegram without scaring anyone.'
        },
        send_telegram: {
          type: 'boolean',
          description: 'When true (default), delivers the synthesized speech as a native playable voice note to the mobile Telegram app.'
        },
        voicebox_url: {
          type: 'string',
          description: 'Custom Voicebox HTTP endpoint URL (defaults to configured URL or http://127.0.0.1:17493).'
        },
        voicebox_port: {
          type: 'number',
          description: 'Custom Voicebox port number if running on a non-default port.'
        },
        cwd: {
          type: 'string',
          description: 'Project working directory. Only used when polish is true.'
        },
        model: {
          type: 'string',
          description: 'Model override for the polish pass (defaults to the configured fast model). Ignored unless polish is true.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort for the polish pass. Defaults to "low". Ignored unless polish is true.'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'telegram_bridge_status',
    description: 'Diagnose the Telegram bridge: whether the daemon is running, WHICH COPY of the bridge code it runs, where its credentials and shared state resolve to, and whether any of that disagrees with the copy these MCP tools run from. Read-only. Use it when Telegram behaves inconsistently — a notification that reports success but never arrives, a telegram_ask that never unblocks, or behaviour that does not match a change that was just made.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'agy_narrate_voices',
    description: 'List and inspect available voice profiles in local Voicebox with their language, voice type (cloned vs preset), personality status, and default/fallback role assignments in Antigravity.',
    inputSchema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['all', 'es', 'en'],
          description: 'Filter profiles by language ("es", "en", or "all"). Defaults to "all".'
        },
        voicebox_url: {
          type: 'string',
          description: 'Custom Voicebox HTTP endpoint URL (defaults to configured URL or http://127.0.0.1:17493).'
        },
        voicebox_port: {
          type: 'number',
          description: 'Custom Voicebox port number if running on a non-default port.'
        }
      }
    }
  },
  {
    name: 'agy_voice_model',
    description: 'Manage which Voicebox TTS model occupies GPU memory, and start Voicebox without its desktop app. Only one TTS model stays resident: switching to a voice that uses another model frees the previous one (unless it is pinned or was used in the last 30 s). Actions: "status" (read-only: server, loaded models, pinned model, free VRAM — never starts anything), "start" (start Voicebox headless if it is not running), "activate" (make a voice\'s model the active one; refuses if another model is pinned or VRAM is short), "pin" (keep a voice\'s model loaded until released — use it when the user says the conversation will go on with that voice, on PC or Telegram), "release" (unpin; the model is freed after the idle timeout), "unload" (unpin and free every TTS model now).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'activate', 'pin', 'release', 'unload'],
          description: 'Operation to perform.'
        },
        voice: {
          type: 'string',
          description: 'For "activate"/"pin": voice profile name; its model is resolved from the profile\'s default engine.'
        },
        language: {
          type: 'string',
          enum: ['en', 'es'],
          description: 'For "activate"/"pin": language hint when resolving `voice`.'
        },
        engine: {
          type: 'string',
          description: 'For "start"/"activate"/"pin"/"unload": explicit engine (qwen, qwen_custom_voice, kokoro, …, or "omnivoice" for the OmniVoice server) instead of a voice.'
        },
        model_size: {
          type: 'string',
          description: 'For "activate"/"pin": Qwen model size ("1.7B" or "0.6B").'
        },
        force: {
          type: 'boolean',
          description: 'For "unload": also unload models from a Voicebox the plugin did not start (the desktop app).'
        },
        voicebox_url: {
          type: 'string',
          description: 'Custom Voicebox HTTP endpoint URL.'
        },
        voicebox_port: {
          type: 'number',
          description: 'Custom Voicebox port.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'telegram_notify',
    description: 'Send an instant push notification or alert from your development environment to your mobile Telegram app (e.g. task completed, test failures, build status). Supports markdown formatting and file attachments.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The notification message text to display on your mobile phone.'
        },
        title: {
          type: 'string',
          description: 'Optional bold title header for the notification.'
        },
        level: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: 'Alert severity level (determines the emoji indicator: ℹ️ info, ✅ success, ⚠️ warning, 🚨 error). Defaults to "info".'
        },
        file_path: {
          type: 'string',
          description: 'Optional absolute path to a file, screenshot, or report to attach and send along with the notification.'
        }
      },
      required: ['message']
    }
  },
  {
    name: 'telegram_ask',
    description: 'Ask the user a question on their mobile Telegram app with interactive choice buttons (Human-in-the-Loop). Pauses agent execution until the user selects an option on their phone, then returns the selected choice.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The decision question to ask the user on mobile (e.g. "Do you want to apply this database migration?").'
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Interactive button choices presented on the phone. Defaults to ["Aprobar", "Rechazar"].'
        },
        timeout_seconds: {
          type: 'number',
          description: 'Maximum seconds to wait for user response on mobile before timing out (defaults to 300 seconds).'
        }
      },
      required: ['question']
    }
  },
  {
    name: 'telegram_send_voice',
    description: 'Send an audio file or the latest Voicebox TTS generation as a native playable voice note (waveform player) to your mobile Telegram app.',
    inputSchema: {
      type: 'object',
      properties: {
        audio_path: {
          type: 'string',
          description: 'Path to audio file (.wav, .ogg, .mp3). If omitted, automatically locates the latest speech generation from Voicebox.'
        },
        caption: {
          type: 'string',
          description: 'Optional caption text to display with the voice note.'
        }
      }
    }
  },
  {
    name: 'cast_agent',
    description: 'Cast a persistent, SKILL-bound agent: an agent with a fixed identity that remembers its own criteria across sessions. Unlike agy_run (generic and stateless) and agy_fanout (ephemeral parallel workers), a cast agent keeps the same conversation thread and the same accumulated judgment every time you call it. Meant for opinion work - code review, security audit, planning, reality checks - not for writing code. Read-only agents are enforced by a tool allowlist in their agent.md plus --mode plan, and the cast is aborted if Antigravity cannot resolve the agent name (passing an unknown --agent silently falls back to a full-write default agent). Use action:"register" once per agent to derive it from an installed SKILL, then action:"cast" to talk to it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['cast', 'register', 'unregister', 'list', 'skills', 'forget'],
          description: 'What to do. "cast" (default) invokes the agent with a prompt. "register" derives an agent from an installed SKILL and materializes its agent.md. "unregister" removes it. "list" shows registered agents and whether Antigravity actually resolves each one. "skills" lists the SKILLs available to derive agents from. "forget" drops the stored conversation thread of an agent without touching its long-term memory, so the next cast starts a fresh thread with the same identity.'
        },
        agent: {
          type: 'string',
          description: 'Agent name (letters, digits, dash, underscore). Required for cast, register, unregister and forget.'
        },
        prompt: {
          type: 'string',
          description: 'What you are asking the agent. Required for action:"cast".'
        },
        skill: {
          type: 'string',
          description: 'SKILL to derive the identity from, e.g. "agency-code-reviewer". Required for action:"register". Use action:"skills" to see what is installed.'
        },
        addendum: {
          type: 'string',
          description: 'For action:"register". Project-specific text appended to the agent.md after the SKILL body, taking precedence over it. Use it to constrain a SKILL written for another context (e.g. one that orders running commands, or citing a standard this repo lacks). Re-registering without it keeps the previous addendum; pass "" to remove it.'
        },
        read_only: {
          type: 'boolean',
          description: 'For action:"register". When true (default), the agent gets a tool allowlist without write_to_file, replace_file_content or run_command, and every cast also runs with --mode plan. Note this does not remove call_mcp_tool, which Antigravity injects unconditionally - a read-only agent still reaches every MCP server you have configured.'
        },
        project_id: {
          type: 'string',
          description: 'Optional project scope for the agent memory, so a reviewer rehydrates the criteria it built on this project rather than on every project at once.'
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the cast. Defaults to the current directory.'
        },
        fresh: {
          type: 'boolean',
          description: 'When true, ignores the stored conversation thread and starts a new one, keeping the same identity and long-term memory. Use it when the previous thread drifted or is no longer relevant. Defaults to false.'
        },
        memory: {
          type: 'boolean',
          description: 'When true (default), rehydrates the agent from mcp-memory before the cast and commits what it learned afterwards. If the memory service is unreachable the cast still runs, just without accumulated context. Set to false to skip memory entirely.'
        },
        budget_tokens: {
          type: 'integer',
          description: 'Token budget for the rehydrated context. Defaults to 2048. Higher values give the agent more history at the cost of prompt size.'
        },
        model: {
          type: 'string',
          description: 'Model override for this cast.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort. If omitted, the configured default applies only to Gemini models without an effort suffix; otherwise agy decides.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 15.'
        }
      }
    }
  }
];

// Adversarial Review System Prompt — embedded from skills/adversarial-review/SKILL.md
const ADVERSARIAL_REVIEW_PROMPT = `You are an Adversarial Review Auditor. Your stance is skeptical: the work has not earned approval until its claims are supported by concrete evidence from the relevant source of truth.

## Modes

There are two modes. Use the one specified by the caller.

- **Mode 1 — Implementation vs. Plan**: you are given a plan/ticket/spec and an agent's output (diff, PR, commit, or already-written code). The question is: does the implementation satisfy what the plan required, no more and no less?
- **Mode 2 — Plan vs. Real Project**: you are given a proposed plan or design that has not yet been implemented. The question is: does the plan fit the flows, business rules, data model, tests, and conventions that already exist in the project, or is it reinventing something, contradicting a domain invariant, bypassing an established flow, or solving a larger problem than the project actually has?

## Principles

- Auditor stance, not collaborator stance. Verify pass/fail and document why. Do not dilute findings with praise sandwiches.
- Approval must be earned. Start from: "This has not yet demonstrated that it should be approved."
- Never accept "this looks reasonable" without checking the source of truth.
- Every finding cites concrete evidence: file:line, diff hunk, plan requirement, test name, schema object, migration, existing module, or repository symbol.
- A criticism without evidence is not a finding. Remove it, or classify it as a limited NOTE when the uncertainty itself matters.
- Be concise. Go directly to the findings. If something passes, say so briefly and move on.
- Distinguish violations from preferences. "Does not implement R3" is a finding. "I would have designed it differently" is not, unless it conflicts with an actual project convention or creates a concrete risk.
- Do not invent problems. A short, evidence-based PASS is valid.
- Do not infer runtime success from code shape alone. Separate static inspection from executed validation.
- Do not confuse missing evidence with a confirmed defect. Use "Not verifiable" when the available material cannot prove the claim.

## Severity Rubric

### BLOCKER
A defect that should prevent approval or merge because it: fails a mandatory requirement; introduces a security vulnerability, authorization bypass, data loss, corruption, or irreversible state; breaks a domain invariant or critical existing flow; makes the change undeployable or causes a critical runtime failure; requires a fundamental redesign.

### MAJOR
A material problem that normally prevents approval because it: implements important behavior incorrectly or incompletely; omits significant validation, error handling, migration behavior, or required test coverage; introduces an unjustified deviation from the plan or established architecture; duplicates or bypasses important existing business logic; creates substantial operational, maintenance, compatibility, or reliability risk.

### MINOR
A real but limited issue that: affects a secondary edge case or non-critical path; creates a small maintainability, consistency, or test-quality problem; can be corrected locally without changing the design; does not invalidate the primary requirements.

### NOTE
Use for: plan ambiguities; assumptions that materially affect the review; missing context or evidence; risks worth confirming but not proven defects; requirements that pass narrowly or rely on an undocumented constraint.

## Verdict Rules

- **FAIL**: one or more BLOCKER findings; or one or more in-scope MAJOR findings that materially affect correctness, safety, required behavior, compatibility, or project fit; or a critical requirement is "Not met".
- **PASS WITH RESERVATIONS**: no BLOCKER findings; no unresolved in-scope MAJOR finding that invalidates the work; one or more MINOR findings, material NOTES, plan ambiguities, or important "Not verifiable" requirements remain; or validation is materially incomplete.
- **PASS**: no BLOCKER, MAJOR, or MINOR findings; no material unresolved NOTE; all in-scope requirements are "Met"; critical behavior is supported by sufficient evidence.

## Process — Mode 1: Implementation vs. Plan

1. Rebuild the plan as an atomic checklist (R1, R2, ...).
2. Establish review scope and note unavailable material.
3. Map every requirement to the actual implementation.
4. Classify every requirement: Met / Partial / Not met / Not verifiable.
5. Look for unannounced deviations.
6. Check project fit (auth, validation, transactions, logging, error-handling flows).
7. Inspect tests by requirement.
8. Execute feasible validation (tests, type checks, linters, builds).
9. Check required edge cases (permissions, invalid input, missing state, duplicates, retries, partial failures, concurrency, rollback, compatibility, migration safety).
10. Assign severity and verdict using the rubric.

## Process — Mode 2: Plan vs. Real Project

1. Do not judge the plan before investigating the repository. Search actively for similar or equivalent flows.
2. Reconstruct the existing system behavior: entry points, data flow, state transitions, ownership boundaries, side effects, failure handling.
3. Contrast each material plan element with repository evidence. Cite concrete files, lines, symbols, tests.
4. Look for concrete contradictions: reimplementation, domain invariant violations, flow bypasses, schema conflicts, unsafe migrations, naming/layering conflicts.
5. Check whether the plan addresses the real integration points.
6. Evaluate testability and validation.
7. Explicitly evaluate over-engineering: treat disproportionate complexity as a finding. Cite the simpler existing mechanism.
8. Assign severity and verdict.

## Over-engineering signals (Mode 2)

- Abstractions built for one use case without evidence of a second consumer.
- Unrequested generality solving a broader class of problems than the project has.
- New dependencies/frameworks when the project already has an established mechanism.
- Solution size disproportionate to the requirement.
- Configurability nobody requested. Plugin systems or rule engines for a small fixed set of cases.
- Premature extraction. Parallel data models or duplicate sources of truth.

## Output Format

\`\`\`md
## Verdict: PASS | FAIL | PASS WITH RESERVATIONS

[One or two sentences giving the direct overall conclusion and the most important reason.]

## Findings

### BLOCKER
- [Rn / file:line / existing rule] — description, evidence, why it is a blocker

### MAJOR
- ...

### MINOR
- ...

### NOTE
- ...

## Plan coverage

| Requirement | Status | Evidence |
|---|---|---|
| R1 | Met / Partial / Not met / Not verifiable | file:line, test, command result, or missing evidence |

## Validation
- Inspected: [...]
- Executed — passed: \\\`command\\\`
- Executed — failed: \\\`command\\\` — relevant failure
- Not executable: reason

## Over-engineering
- [plan element / file:line / existing mechanism] — why the complexity is unsupported
\`\`\`

Section rules: Mode 1 includes Plan coverage. Mode 2 includes Over-engineering. Include Validation when relevant. Omit empty severity subsections. If no findings, write "No evidence-based findings." Do not add praise, filler, or unrelated recommendations.

## Style

Direct, skeptical, and factual. Be hostile toward unsupported claims and defects, not toward the person. Every finding must cite concrete evidence. Do not use praise sandwiches.
`;

// Session Log Discovery & Pre-processing
function getProjectLogDir(cwd) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  // Claude Code encodes project paths as directory names: /foo/bar → -foo-bar (unix), c:\foo\bar → c--foo-bar (win)
  const normalizedCwd = (cwd || process.cwd()).replace(/\\/g, '/');
  const entries = fs.readdirSync(projectsDir);

  // Strategy 1: Try direct encoding match
  const encoded = normalizedCwd.replace(/^\//, '').replace(/:/g, '').replace(/\//g, '-');
  const winEncoded = (cwd || process.cwd()).replace(/:/g, '').replace(/\\/g, '-').replace(/\//g, '-');

  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (lower === encoded.toLowerCase() || lower === winEncoded.toLowerCase()) {
      const full = path.join(projectsDir, entry);
      if (fs.statSync(full).isDirectory()) return full;
    }
  }

  // Strategy 2: Fuzzy — check if the cwd basename appears in any project dir
  const cwdBase = path.basename(cwd || process.cwd()).toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase().includes(cwdBase)) {
      const full = path.join(projectsDir, entry);
      if (fs.statSync(full).isDirectory()) return full;
    }
  }

  return null;
}

function findSessionFile(logDir, sessionId) {
  if (!logDir || !fs.existsSync(logDir)) return null;

  if (sessionId) {
    // P1 Security: Sanitize sessionId to strictly prevent path traversal (alphanumeric, dashes, underscores only)
    const safeId = path.basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return null;
    const target = path.join(logDir, `${safeId}.jsonl`);
    const resolvedTarget = path.resolve(target);
    const resolvedLogDir = path.resolve(logDir);
    if (!resolvedTarget.startsWith(resolvedLogDir)) return null;
    return fs.existsSync(resolvedTarget) ? resolvedTarget : null;
  }

  // Find most recent .jsonl file by modification time
  const files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(logDir, f),
      mtime: fs.statSync(path.join(logDir, f)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].path : null;
}

function saveSummary(content, sessionId, sessionMeta, outputPath, cwd = process.cwd()) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const today = new Date().toISOString().slice(0, 10);
  const safeId = (sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8);

  let targetPath;
  if (outputPath) {
    const resolved = path.resolve(cwd, outputPath);
    const allowedRoots = [
      path.resolve(cwd),
      path.resolve(homeDir, '.claude')
    ];
    const isSafe = allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
    if (!isSafe) {
      throw new Error(`Security Violation: output_path must reside within project root or ~/.claude (attempted: ${outputPath})`);
    }
    targetPath = resolved;
  } else {
    const summaryDir = path.join(homeDir, '.claude', 'session-summaries');
    if (!fs.existsSync(summaryDir)) {
      fs.mkdirSync(summaryDir, { recursive: true });
    }
    targetPath = path.join(summaryDir, `${today}-${safeId}.md`);
  }

  // Build frontmatter
  const frontmatter = [
    '---',
    `session_id: "${sessionId || 'unknown'}"`,
    `project: "${(sessionMeta.cwd || 'unknown').replace(/\\/g, '/')}"`,
    `branch: "${sessionMeta.branch || 'unknown'}"`,
    `date: "${today}"`,
    `start_time: "${sessionMeta.startTime || 'unknown'}"`,
    `end_time: "${sessionMeta.endTime || 'unknown'}"`,
    `summarized_by: "antigravity-mcp"`,
    `claude_version: "${sessionMeta.version || 'unknown'}"`,
    '---',
    ''
  ].join('\n');

  const fullContent = frontmatter + content;

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(targetPath, fullContent, 'utf8');
  return targetPath;
}

// Voicebox HTTP Client & Checkpoint Helpers
function httpRequest(urlStr, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: options.method || (postData ? 'POST' : 'GET'),
      headers: {
        'X-Voicebox-Client-Id': 'claude-code',
        ...(options.headers || {})
      },
      timeout: options.timeout || 3500
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Connection timed out after ${options.timeout || 3500}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (postData) {
      const payload = typeof postData === 'string' ? postData : JSON.stringify(postData);
      req.write(payload);
    }
    req.end();
  });
}

function resolveVoiceboxUrl(args = {}, config = {}) {
  if (args.voicebox_url) return args.voicebox_url.replace(/\/+$/, '');
  if (config.voiceboxUrl) return config.voiceboxUrl.replace(/\/+$/, '');
  if (process.env.VOICEBOX_URL) return process.env.VOICEBOX_URL.replace(/\/+$/, '');

  const port = args.voicebox_port || config.voiceboxPort || process.env.VOICEBOX_PORT || 17493;
  return `http://127.0.0.1:${port}`;
}

/**
 * `agy_voice_model` action "status". Solo lee: nunca levanta Voicebox.
 */
async function describirEstadoVoicebox(voiceboxUrl, config) {
  const h = await vb.salud(voiceboxUrl);
  const k = vb.leerKeeper();
  const pin = vb.leerPin();
  const vram = vb.vramNvidia();
  let out = '### 🎙️ Voicebox\n\n';
  if (!h.ok) {
    out += `- **Servidor**: apagado (${h.error})\n`;
    out += `- **Autoarranque**: ${config.voiceboxAutostart === false ? 'desactivado' : 'se levanta solo, sin GUI, al primer uso de voz'}\n`;
  } else {
    out += `- **Servidor**: \`${voiceboxUrl}\` · ${h.info.backend_variant || '?'}${h.info.gpu_type ? ` (${h.info.gpu_type})` : ''}\n`;
    let lanzadoPor = 'la GUI (sin keeper)';
    if (k && k.vivo) lanzadoPor = k.ownsServer ? `el plugin (keeper ${k.pid})` : `la GUI (keeper ${k.pid} en solo lectura)`;
    out += `- **Lanzado por**: ${lanzadoPor}\n`;
    let modelos = [];
    try { modelos = await vb.estadoModelos(voiceboxUrl); } catch {}
    const usos = vb.leerUsos();
    const ahora = Date.now();
    const cargados = modelos.filter(m => m.loaded).map(m => {
      let d = `\`${m.model_name}\``;
      if (m.size_mb) d += ` (${Math.round(m.size_mb)} MB)`;
      if (pin && pin.model === m.model_name) d += ' 📌';
      if (usos[m.model_name]) d += `, usado hace ${Math.round((ahora - usos[m.model_name]) / 60000)} min`;
      return d;
    });
    out += `- **Modelos cargados**: ${cargados.length ? cargados.join('; ') : 'ninguno'}\n`;
  }
  out += `- **Fijado**: ${pin ? `\`${pin.model}\`${pin.voice ? ` (voz ${pin.voice})` : ''} desde ${pin.since}` : 'nada'}\n`;
  out += `- **VRAM**: ${vram ? `${(vram.libreMb / 1024).toFixed(1)} GB libres de ${(vram.totalMb / 1024).toFixed(1)} GB` : 'sin nvidia-smi'}\n`;
  out += `- **Inactividad**: descarga a los ${config.voiceboxIdleUnloadMinutes} min y apaga a los ${config.voiceboxIdleShutdownMinutes || '∞'} min (solo si lo levantó el plugin)\n`;
  if (om.omniInstalado({ config })) {
    const urlO = om.urlOmni(config);
    const ho = await vb.salud(urlO, 2000);
    if (!ho.ok) {
      out += `- **OmniVoice**: apagado (se levanta solo al narrar en modo inmediato) · \`${urlO}\`\n`;
    } else {
      const eo = await vb.estadoOmniServidor(urlO);
      const cargado = eo.models.some(m => m.loaded);
      out += `- **OmniVoice**: \`${urlO}\` · ${ho.info.variant || '?'} · ${cargado ? 'modelo cargado' : 'sin modelo cargado'}${eo.generando ? ' · generando' : ''}\n`;
    }
  } else {
    out += '- **OmniVoice**: no instalado (`npm run omnivoice:install`)\n';
  }
  out += `- **Estado y logs**: \`${vb.dirEstado()}\`\n`;
  return out;
}

/** Salida común de `agy_voice_model` activate/pin, para los dos proveedores. */
function formatearActivacion(r, action, deVoz) {
  let out = action === 'pin'
    ? `📌 \`${r.objetivo}\` fijado${deVoz}: queda cargado hasta \`release\` o \`unload\`.`
    : `✅ Modelo activo: \`${r.objetivo}\`${deVoz}.`;
  if (r.descargados.length) out += `\n- Descargados antes: ${r.descargados.map(n => `\`${n}\``).join(', ')}`;
  if (r.postergados.length) out += `\n- Siguen cargados (en uso hace <30 s, se descargan por inactividad): ${r.postergados.map(n => `\`${n}\``).join(', ')}`;
  if (r.guarda === 'ok') out += '\n- Guarda de VRAM: hay espacio.';
  else if (r.guarda === 'omitida') out += '\n- Guarda de VRAM: omitida (sin nvidia-smi o sin tamaño del modelo).';
  return out;
}

async function getVoiceboxProfiles(baseUrl) {
  const res = await httpRequest(`${baseUrl}/profiles`, { timeout: 4000 });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return JSON.parse(res.body);
  }
  throw new Error(`Failed to fetch Voicebox profiles: HTTP ${res.statusCode}`);
}

// Fase 1 (Modo Charla): pre-warm the TTS model into VRAM before opening the mic,
// so the first spoken reply doesn't pay the 3-8s cold-load-from-disk cost.
async function voiceboxModelsLoad(baseUrl, modelSize) {
  const qs = modelSize ? `?model_size=${encodeURIComponent(modelSize)}` : '';
  try {
    const res = await httpRequest(`${baseUrl}/models/load${qs}`, { method: 'POST', timeout: 15000 });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let data = {};
      try { data = JSON.parse(res.body); } catch { data = { raw: res.body }; }
      return { ok: true, data };
    }
    return { ok: false, error: `Voicebox /models/load returned HTTP ${res.statusCode}: ${res.body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: `Cannot reach Voicebox /models/load at ${baseUrl} (${err.message})` };
  }
}

// ==============================================================================
// Narracion: tuberia de emision compartida por agy_narrate y agy_say
// ==============================================================================

/**
 * Emite un texto ya saneado: Voicebox, reproduccion local opcional, entrega a
 * Telegram y limpieza del .wav.
 *
 * Existe para que `agy_narrate` y `agy_say` compartan literalmente la misma
 * tuberia. Son la misma emision con distinto origen del guion -una lo deriva
 * del log de sesion, la otra lo recibe-, y mantener dos copias garantizaba que
 * una arreglara un fallo que la otra conservase.
 */
async function emitNarration(opciones) {
  // El modelo queda marcado en uso durante toda la emisión: al empezar, cada
  // 10 s mientras se espera el .wav (acá o en el bridge) y al terminar. Así
  // otro proceso nunca lo descarga a mitad de una síntesis (plan C.2).
  const motor = opciones.motor || { engine: 'qwen', modelSize: '1.7B' };
  const modelo = vb.ttsModelName(motor.engine, motor.modelSize);
  vb.tocarUso(modelo);
  const parar = vb.iniciarToquesPeriodicos(modelo);
  try {
    return await emitirNarracionInterna({ ...opciones, motor });
  } finally {
    parar();
    vb.tocarUso(modelo);
  }
}

async function emitirNarracionInterna({
  spokenText,
  voiceboxUrl,
  profile,
  language,
  localPlayback = false,
  sendTelegram = true,
  motor,
  proveedor = 'voicebox',
  muestra = null,
  omniUrl = null,
  classTemperature = null
}) {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const genDir = path.join(appData, 'sh.voicebox.app', 'generations');
  const beforeFiles = fs.existsSync(genDir) ? fs.readdirSync(genDir) : [];

  let speakRes;
  let generatedWavPath = null;
  if (proveedor === 'omnivoice') {
    // OmniVoice genera síncrono y devuelve la ruta: no hay nada que esperar en
    // generations/ de Voicebox. El bridge recibe el archivo directo.
    try {
      const r = await om.sintetizarOmni(omniUrl, {
        texto: spokenText,
        refAudio: muestra.audioPath,
        refText: muestra.refText,
        classTemperature
      });
      speakRes = { id: r.id, segundos: r.segundos, proveedor: 'omnivoice' };
      generatedWavPath = r.audioPath;
    } catch (err) {
      return { ok: false, error: `OmniVoice: ${err.message}` };
    }
  } else {
    try {
      speakRes = await sendVoiceboxGenerate(voiceboxUrl, spokenText, profile.id, language, {
        engine: motor.engine,
        modelSize: motor.modelSize
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  let localPlayed = false;
  let telegramDelivered = false;
  let telegramError = null;

  if (localPlayback) {
    try {
      if (!generatedWavPath) generatedWavPath = await waitForGenerationFile(
        genDir,
        (speakRes && speakRes.id) ? speakRes.id : null,
        beforeFiles,
        90000
      );
      if (generatedWavPath) {
        localPlayed = await playLocalAudio(generatedWavPath);
      }
    } catch (pErr) {
      process.stderr.write(`[antigravity-mcp] Local playback error: ${pErr.message}\n`);
    }
  }

  if (sendTelegram) {
    const langLabel = language === 'es' ? 'Español' : 'Inglés';
    try {
      const tPayload = {
        generationId: (speakRes && speakRes.id) ? speakRes.id : null,
        beforeFiles,
        waitForGeneration: !generatedWavPath,
        timeoutSeconds: 95,
        // El caption viaja al chat y a daemon.log. `spokenText` ya paso por
        // redactSecrets en normalizeSpokenText, que es justo lo que hace seguro
        // aceptar texto libre del llamante.
        caption: `🎙️ "${spokenText}"\n(Voz: ${profile.name} • ${langLabel})`
      };
      if (generatedWavPath) {
        tPayload.audioPath = generatedWavPath;
      }
      const tRes = await invokeTelegramBridge('--voice-json', tPayload);
      if (tRes && tRes.ok) {
        telegramDelivered = true;
      } else {
        telegramError = (tRes && tRes.error) ? tRes.error : 'Fallo desconocido enviando a Telegram.';
      }
    } catch (tErr) {
      telegramError = tErr.message;
    }
    if (telegramError) {
      process.stderr.write(`[antigravity-mcp] Telegram delivery failed: ${telegramError}\n`);
    }
  }

  // Voicebox no borra sus generaciones: sin esto, generations/ crece sin limite.
  if (generatedWavPath) {
    try {
      fs.unlinkSync(generatedWavPath);
    } catch (delErr) {
      process.stderr.write(`[antigravity-mcp] No se pudo borrar ${generatedWavPath}: ${delErr.message}\n`);
    }
  }

  return { ok: true, speakRes, localPlayed, telegramDelivered, telegramError };
}

/**
 * Bloque de salida comun a las dos herramientas de narracion.
 */
function formatNarrationOutput({ spokenText, profile, language, personality, localPlayback, emision, voiceboxUrl, voiceResolution, destino = {}, personaAplicada = null }) {
  const langLabel = language === 'es' ? 'Español' : 'Inglés';
  const fallbackNotice = voiceResolution.isFallback
    ? ` *(Fallback: ${voiceResolution.reason})*`
    : ' *(Voz preferida)*';

  let out = `**Texto narrado:**\n> "${spokenText}"\n\n`;
  out += `**Detalles de la emisión:**\n`;
  out += `- **Perfil de voz**: \`${profile.name}\` (${profile.voice_type || 'cloned'})${fallbackNotice}\n`;
  if (destino.motor) {
    const a = destino.activacion || {};
    let linea = `- **Modelo TTS**: \`${vb.ttsModelName(destino.motor.engine, destino.motor.modelSize)}\``;
    if (a.fijado) linea += ' 📌 fijado';
    if (a.descargados && a.descargados.length) linea += ` (antes se descargó: ${a.descargados.join(', ')})`;
    if (a.postergados && a.postergados.length) linea += ` (sigue cargado, en uso hace <30 s: ${a.postergados.join(', ')})`;
    out += `${linea}\n`;
  }
  if (destino.health && destino.health.started) out += `- **Voicebox**: levantado sin GUI (${destino.health.variante})\n`;
  if (destino.health && destino.health.aviso) out += `- ⚠️ ${destino.health.aviso}\n`;
  if (destino.proveedor) {
    const seg = emision && emision.speakRes && emision.speakRes.segundos;
    let linea = `- **Motor**: ${destino.proveedor === 'omnivoice' ? 'OmniVoice' : 'Voicebox'} (modo ${destino.modo}${Number.isFinite(seg) ? `, ${seg.toFixed(1)} s` : ''})`;
    if (destino.fallback) linea += ` — no se usó OmniVoice: ${destino.motivoProveedor}`;
    if (destino.desdeCache) linea += ' · voz desde la caché (Voicebox no respondió)';
    out += `${linea}\n`;
  }
  if (destino.avisoMuestra) out += `- ⚠️ ${destino.avisoMuestra}\n`;
  out += `- **Idioma**: \`${langLabel} (${language})\`\n`;
  // Lo que se aplicó de verdad, no lo que se pidió: si la reescritura falla se
  // narra el texto original, y decir «en personaje» sería falso.
  const enPersona = personaAplicada === null ? personality : personaAplicada;
  let modoPersona = '👔 Neutral / Profesional';
  if (enPersona) modoPersona = `🎭 En personaje, escrito por agy (\`${profile.personality || profile.description || 'expresivo'}\`)`;
  else if (personality) modoPersona = '⚠️ Se pidió personalidad pero la reescritura falló: se narró el texto original';
  out += `- **Modo de Personalidad**: ${modoPersona}\n`;
  out += `- **Reproducción Local en PC**: ${localPlayback ? (emision.localPlayed ? '🔊 Reproducido limpiamente en altavoces (sin eco)' : '⚠️ Solicitado pero falló el reproductor local') : '🤫 Silencioso en PC'}\n`;
  out += `- **Endpoint**: \`${voiceboxUrl}\`\n`;
  if (emision.speakRes && emision.speakRes.id) {
    out += `- **Voicebox Generation ID**: \`${emision.speakRes.id}\`\n`;
  }
  if (emision.telegramDelivered) {
    out += `- **Telegram Móvil**: ✅ Nota de voz entregada a tu teléfono\n`;
  } else if (emision.telegramError) {
    out += `- **Telegram Móvil**: ⚠️ Falló el envío — ${emision.telegramError}\n`;
  }
  return out;
}

/**
 * Resuelve Voicebox y el perfil de voz, o devuelve el error ya formateado para
 * el cliente. Los dos primeros pasos son identicos en ambas herramientas.
 */
/**
 * Reescribe un texto en la persona del perfil de voz, con agy.
 *
 * Reemplaza a la reescritura del LLM de Voicebox (Qwen3 0.6B), que ya no se
 * pide: agy es más capaz y la persona queda igual con cualquier motor. Si la
 * llamada falla (agy ausente, sin respuesta), se devuelve el texto original:
 * perder el mensaje por no poder darle tono sería el peor canje.
 */
async function reescribirEnPersona({ texto, destino, args, config }) {
  const modelo = args.model || config.defaultModel;
  const esfuerzo = esfuerzoParaCli({ modelo, pedido: args.effort, porDefecto: 'low' });
  const cliArgs = ['--output-format', 'json', '--dangerously-skip-permissions', '--mode', 'plan'];
  if (esfuerzo) cliArgs.push('--effort', esfuerzo);
  if (modelo) cliArgs.push('--model', modelo);
  cliArgs.push('-p', getPersonaPrompt(texto, destino.language, destino.profile));

  const res = await executeAgy(cliArgs, { cwd: args.cwd || process.cwd(), timeoutMinutes: 3 });
  const data = res.data || {};
  const duracion = data.duration_seconds || 0;
  if (data.usage) {
    recordUsage('say', modelo, esfuerzo, data.conversation_id || '', duracion, data.usage, !res.success, res.error || '');
  }
  const salida = res.success ? (data.response || res.rawOutput || '').trim() : '';
  if (!salida) {
    process.stderr.write(`[antigravity-mcp] Reescritura en persona falló, se narra el original: ${res.error || 'sin respuesta'}\n`);
    return { texto, aplicado: false, duracion, error: res.error || 'sin respuesta' };
  }
  return { texto: salida, aplicado: true, duracion, error: null };
}

/** Los dos servidores de voz para el coordinador de VRAM. */
function servidoresVoz(voiceboxUrl, config) {
  return { voicebox: voiceboxUrl, omnivoice: om.omniInstalado({ config }) ? om.urlOmni(config) : null };
}

/** Lo que la emisión necesita de `destino` (proveedor, muestra, motor). */
function camposEmision(destino) {
  return {
    motor: destino.motor,
    proveedor: destino.proveedor,
    muestra: destino.muestra,
    omniUrl: destino.omniUrl,
    classTemperature: destino.classTemperature
  };
}

/**
 * Resuelve Voicebox, la voz, el proveedor (OmniVoice o Voicebox) y deja la
 * VRAM lista, o devuelve el error ya formateado para el cliente.
 *
 * Proveedor: motor explícito → voz fijada en `voz_por_perfil` → modo
 * (inmediato → OmniVoice, diferido → Voicebox). Si OmniVoice no se puede usar
 * (no instalado, voz sin muestra, muestra borrada, no arranca) se cae a
 * Voicebox diciendo por qué. Si Voicebox no levanta pero la voz sale por
 * OmniVoice, perfiles y muestra vienen de la caché de voces.
 */
async function prepareNarrationTarget(args, config, opciones = {}) {
  const voiceboxUrl = resolveVoiceboxUrl(args, config);
  const modo = args.modo === 'diferido' || args.modo === 'inmediato' ? args.modo : (opciones.modoPorDefecto || 'inmediato');
  const errorTexto = (texto, isError = false) => ({
    error: { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: texto }] }
  });

  // Si no corre, se levanta sin GUI. El error ya nombra la causa.
  const health = await vb.ensureVoicebox(voiceboxUrl, { config });
  let profiles = null;
  let errorPerfiles = health.ok ? null : health.error;
  if (health.ok) {
    try {
      profiles = await getVoiceboxProfiles(voiceboxUrl);
      om.guardarCacheVoces({ perfiles: profiles });
    } catch (err) {
      errorPerfiles = `Error al consultar los perfiles de voz de Voicebox: ${err.message}`;
    }
  }
  let desdeCache = false;
  if (!profiles) {
    const cache = om.leerCacheVoces();
    if (!(cache && Array.isArray(cache.perfiles) && cache.perfiles.length)) {
      return errorTexto(`⚠️ **Voicebox no está disponible en \`${voiceboxUrl}\`**\n\n${errorPerfiles}`);
    }
    profiles = cache.perfiles;
    desdeCache = true;
  }

  let voiceResolution;
  try {
    voiceResolution = resolveVoiceProfile(profiles, args.voice, args.language);
  } catch (err) {
    return errorTexto(`⚠️ Error resolviendo el perfil de voz: ${err.message}`);
  }
  const perfil = voiceResolution.profile;

  const preferencia = om.preferenciaProveedor({ motorPedido: args.motor, modo, perfil, config });
  let proveedor = 'voicebox';
  let motivoProveedor = preferencia.motivo;
  let muestra = null;
  let omniUrl = null;
  if (preferencia.proveedor === 'omnivoice') {
    if (!om.omniInstalado({ config })) {
      motivoProveedor = 'OmniVoice no está instalado (npm run omnivoice:install)';
    } else {
      muestra = await om.muestraDePerfil(health.ok ? voiceboxUrl : null, perfil);
      if (!muestra) {
        motivoProveedor = `${perfil.name} no tiene muestra (perfil preset): OmniVoice necesita una para clonar`;
      } else if (!fs.existsSync(muestra.audioPath)) {
        // Sin esto, OmniVoice respondería con un error de Python al abrir el archivo.
        motivoProveedor = `la muestra de ${perfil.name} ya no está en disco (${muestra.audioPath})`;
        muestra = null;
      } else {
        const s = await om.ensureOmniVoice(om.urlOmni(config), { config });
        if (s.ok) {
          proveedor = 'omnivoice';
          omniUrl = om.urlOmni(config);
        } else {
          motivoProveedor = `OmniVoice no arrancó: ${s.error}`;
          muestra = null;
        }
      }
    }
  }
  const fallback = preferencia.proveedor === 'omnivoice' && proveedor !== 'omnivoice';
  if (proveedor === 'voicebox' && !health.ok) {
    return errorTexto(`⚠️ **Voicebox no está disponible en \`${voiceboxUrl}\`**\n\n${health.error}` +
      (fallback ? `\n\nY OmniVoice no se pudo usar: ${motivoProveedor}.` : ''));
  }

  // Motor y VRAM: el modelo de esta voz pasa a ser el activo. El coordinador ve
  // los dos servidores, respeta el pin y descarga los TTS ajenos sin uso.
  let motor;
  if (proveedor === 'omnivoice') {
    motor = { engine: vb.MODELO_OMNI, modelSize: null };
  } else {
    const modelos = {};
    try {
      for (const m of await vb.estadoModelos(voiceboxUrl)) modelos[m.model_name] = m;
    } catch {}
    motor = vb.resolverMotor(perfil, modelos);
  }
  let activacion;
  try {
    activacion = await vb.aplicarModeloActivo(servidoresVoz(health.ok ? voiceboxUrl : null, config), {
      proveedor,
      ...motor,
      voz: perfil.name,
      fijar: Boolean(args.keep_model)
    });
  } catch (err) {
    // Sin inventario no se puede ordenar la VRAM, pero sí se puede hablar.
    activacion = { ok: true, omitida: err.message };
  }
  if (!activacion.ok) return errorTexto(`⚠️ ${activacion.error}`, true);

  return {
    voiceboxUrl,
    voiceResolution,
    profile: perfil,
    language: voiceResolution.language,
    motor,
    activacion,
    health,
    proveedor,
    motivoProveedor,
    fallback,
    modo,
    muestra,
    omniUrl,
    desdeCache,
    classTemperature: config.omnivoiceClassTemperature,
    avisoMuestra: proveedor === 'omnivoice' ? om.avisoMuestraLarga(muestra, perfil) : null
  };
}

function resolveVoiceProfile(profiles, requestedVoice, requestedLang) {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error('No voice profiles found in Voicebox.');
  }

  const voiceStr = (requestedVoice || '').trim().toLowerCase();
  let lang = (requestedLang || '').trim().toLowerCase();
  if (lang.startsWith('en')) lang = 'en';
  else if (lang.startsWith('es')) lang = 'es';
  else if (lang) lang = '';

  // 1. Exact or partial match by profile name first (inherits profile language dynamically)
  if (voiceStr) {
    const exact = profiles.find(p => p.name.toLowerCase() === voiceStr);
    if (exact) {
      const pLang = (exact.language || '').toLowerCase().slice(0, 2);
      const effectiveLang = lang || (['en', 'es'].includes(pLang) ? pLang : 'es');
      return { profile: exact, isFallback: false, reason: 'exact_name_match', language: effectiveLang };
    }
    const partial = profiles.find(p => p.name.toLowerCase().includes(voiceStr));
    if (partial) {
      const pLang = (partial.language || '').toLowerCase().slice(0, 2);
      const effectiveLang = lang || (['en', 'es'].includes(pLang) ? pLang : 'es');
      return { profile: partial, isFallback: false, reason: 'partial_name_match', language: effectiveLang };
    }
  }

  // 2. Detect language from voice keyword if not matched and no explicit language
  if (voiceStr && !lang) {
    if (['emily', 'aria', 'aiden'].some(k => voiceStr.includes(k))) {
      lang = 'en';
    } else if (['diego', 'alvarez', 'isabel', 'anna', 'ono'].some(k => voiceStr.includes(k))) {
      lang = 'es';
    }
  }

  if (!lang) lang = 'es';

  // 3. Fallbacks
  if (lang === 'en') {
    const emily = profiles.find(p => p.name.toLowerCase() === 'emily');
    if (emily && (!voiceStr || voiceStr.includes('emily'))) {
      return { profile: emily, isFallback: false, reason: 'default_english_voice', language: 'en' };
    }
    const aria = profiles.find(p => p.name.toLowerCase() === 'aria');
    if (aria) return { profile: aria, isFallback: true, reason: 'fallback_english_aria', language: 'en' };

    const aiden = profiles.find(p => p.name.toLowerCase() === 'aiden');
    if (aiden) return { profile: aiden, isFallback: true, reason: 'fallback_english_aiden', language: 'en' };

    const anyEn = profiles.find(p => (p.language || '').toLowerCase().startsWith('en'));
    if (anyEn) return { profile: anyEn, isFallback: true, reason: 'fallback_any_english', language: 'en' };
  } else {
    const diego = profiles.find(p => p.name.toLowerCase().includes('diego'));
    if (diego && (!voiceStr || voiceStr.includes('diego'))) {
      return { profile: diego, isFallback: false, reason: 'default_spanish_voice', language: 'es' };
    }
    const isabel = profiles.find(p => p.name.toLowerCase() === 'isabel');
    if (isabel) return { profile: isabel, isFallback: true, reason: 'fallback_spanish_isabel', language: 'es' };

    const anna = profiles.find(p => p.name.toLowerCase().includes('anna') || p.name.toLowerCase().includes('ono'));
    if (anna) return { profile: anna, isFallback: true, reason: 'fallback_spanish_anna', language: 'es' };

    const anyEs = profiles.find(p => (p.language || '').toLowerCase().startsWith('es'));
    if (anyEs) return { profile: anyEs, isFallback: true, reason: 'fallback_any_spanish', language: 'es' };
  }

  return { profile: profiles[0], isFallback: true, reason: 'fallback_first_available', language: lang };
}

// NOTE: there is deliberately no /speak helper here. Voicebox's POST /speak makes
// Voicebox itself play the audio, which triggers its double-playback bug; every path
// in this server uses POST /generate (synthesize silently to a .wav) and then plays
// the file with the native OS player. See playLocalAudio() and the agy_narrate case.
async function sendVoiceboxGenerate(baseUrl, text, profileId, language, options = {}) {
  const postData = {
    profile_id: profileId,
    text,
    language: language || 'es',
    // null es válido en el schema de Voicebox: los motores no-Qwen no versionan por tamaño.
    model_size: options.modelSize !== undefined ? options.modelSize : '1.7B',
    engine: options.engine || 'qwen',
    // La persona la aplica agy antes (reescribirEnPersona o el prompt del
    // guion): el LLM de Voicebox (Qwen3 0.6B) reescribía otra vez, y peor.
    personality: false,
    normalize: true
  };
  const res = await httpRequest(`${baseUrl}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  }, postData);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    try {
      return JSON.parse(res.body);
    } catch {
      return { status: 'generating', raw: res.body };
    }
  }
  throw new Error(`Voicebox /generate returned HTTP ${res.statusCode}: ${res.body}`);
}

function playLocalAudio(filePath) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) return resolve(false);
    if (process.platform === 'win32') {
      const escaped = filePath.replace(/'/g, "''");
      const psCmd = `& { $p = '${escaped}'; (New-Object System.Media.SoundPlayer $p).PlaySync() }`;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
        windowsHide: true,
        stdio: 'ignore'
      });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    } else {
      resolve(false);
    }
  });
}

async function waitForGenerationFile(genDir, generationId, beforeFiles = [], timeoutMs = 90000) {
  const beforeSet = new Set(beforeFiles);
  const startTime = Date.now();
  const targetFileById = generationId ? path.join(genDir, `${generationId}.wav`) : null;

  while (Date.now() - startTime < timeoutMs) {
    if (targetFileById && fs.existsSync(targetFileById)) {
      try {
        const stat = fs.statSync(targetFileById);
        if (stat.size > 2000) {
          await new Promise(r => setTimeout(r, 400));
          return targetFileById;
        }
      } catch {}
    }

    if (fs.existsSync(genDir)) {
      try {
        const currentFiles = fs.readdirSync(genDir);
        for (const file of currentFiles) {
          if ((file.endsWith('.wav') || file.endsWith('.ogg') || file.endsWith('.mp3')) && !beforeSet.has(file)) {
            const fullPath = path.join(genDir, file);
            const stat = fs.statSync(fullPath);
            if (stat.size > 2000) {
              await new Promise(r => setTimeout(r, 400));
              return fullPath;
            }
          }
        }
      } catch {}
    }

    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}


function getNarrationPrompt(checkpoint, targetLang, profile, enablePersonality = false) {
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

  let personaSection = '';
  if (enablePersonality && profile) {
    personaSection = `\n## Speaker Persona (Derived from Voicebox Profile):
- Name: "${profile.name}"
- Description: "${profile.description || 'Voice Assistant'}"
- Personality Prompt: "${profile.personality || 'Natural and expressive'}"

Persona Instructions:
Adopt the authentic tone, humor, vocabulary, cadence, and characteristic mannerisms of the specified speaker persona naturally, but remain strictly accurate regarding the technical checkpoint facts (files modified and test results).`;
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

// Helper: Run agy process
// Un prompt viaja como argumento de linea de comandos, y eso tiene techo del
// sistema operativo: Windows limita TODA la linea a 32767 caracteres, y Linux
// limita cada argumento suelto a 128 KB (MAX_ARG_STRLEN). agy_session_summary
// llega a meter medio mega de transcripcion ahi, asi que fallaba con un
// `spawn ENAMETOOLONG` opaco en cuanto la sesion pasaba de trivial.
//
// Por encima del limite el prompt se escribe en un fichero temporal y a agy se
// le pasa un puntero. El umbral es conservador: deja sitio para el resto de
// argumentos dentro del techo de Windows, que es el mas estrecho.
const { offloadLargePrompt, PROMPT_ARG_LIMIT } = require('./prompt-offload.js');

/**
 * Termina el proceso hijo y, en Windows, todo su arbol de descendientes.
 *
 * En Windows no hay senales POSIX: libuv traduce SIGTERM y SIGKILL a
 * TerminateProcess sobre el manejador de agy.exe y solo sobre el. Si agy habia
 * lanzado npm test, un servidor local o un script, esos nietos quedan sueltos
 * ocupando puertos y CPU. taskkill /T es lo unico que recorre el arbol; se
 * intenta primero sin /F y se fuerza pasado el margen.
 *
 * Misma implementacion que telegram-bridge/executor.js: los dos lanzan agy del
 * mismo modo y arrastraban el mismo huerfano.
 */
function terminateTree(child, graceMs = 5000) {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T'], () => {});
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      }
    }, graceMs);
    t.unref?.();
    return t;
  }

  try { child.kill('SIGTERM'); } catch {}
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, graceMs);
  t.unref?.();
  return t;
}

// Por encima de este tamano, Flash deja de sostener la transcripcion entera y
// empieza a rellenar huecos.
//
// Lo que se mide es el PROMPT ya preprocesado, no el JSONL crudo. El umbral
// nacio mirando el tamano del fichero, y esa correlacion se rompio al arreglar
// el preprocesado: hoy el transcript esta acotado a 1 MB pase lo que pase, asi
// que un log de 20 MB y uno de 7 MB entregan prompts parecidos. Seguir mirando
// el fichero mandaba a Pro por el peso de lo que se descarta.
//
// Medido sobre la sesion 35b61e70: 6,7 MB de log dan 431 KB de prompt (~100k
// tokens de entrada). Con el fichero como criterio iba a Pro; con el prompt se
// queda en el modelo por defecto, que en 3 corridas produjo documentos mas
// completos en menos de la mitad de tiempo y sin una sola fabricacion.
//
// La regla NO se elimina: 3 corridas descartan un fallo frecuente, no uno raro,
// y el caso que la motivo -- Flash inventando un SHA -- se observo una vez. Lo
// que cambia es que ahora mide la variable que de verdad predice el riesgo.
const RESUMEN_UMBRAL_PRO = 700 * 1024;
const MODELO_RESUMEN_LARGO = 'gemini-3.1-pro';

/**
 * @param {number} promptSize tamano en bytes del prompt YA preprocesado, no del
 *   JSONL crudo. Ver el comentario de RESUMEN_UMBRAL_PRO.
 */
function elegirModeloResumen(args, config, promptSize) {
  // Peticion explicita: no se toca, ni el modelo ni el esfuerzo.
  if (args.model) {
    return {
      model: args.model,
      effort: esfuerzoParaCli({ modelo: args.model, pedido: args.effort, porDefecto: config.defaultEffort }),
      nota: null
    };
  }

  const porDefecto = config.defaultModel;
  const kb = (promptSize / 1024).toFixed(0);
  const umbralKb = (RESUMEN_UMBRAL_PRO / 1024).toFixed(0);

  if (promptSize <= RESUMEN_UMBRAL_PRO) {
    return {
      model: porDefecto,
      effort: esfuerzoParaCli({ modelo: porDefecto, pedido: args.effort, porDefecto: config.defaultEffort }),
      nota: `Prompt de ${kb} KB, por debajo del umbral de ${umbralKb} KB: se usa el modelo por defecto.`
        + ' El umbral mira el prompt preprocesado, no el tamano del log.'
    };
  }

  // La familia Pro solo existe en low y high (`agy models`), asi que un
  // `medium` heredado de la configuracion haria fallar la llamada. Se sube a
  // high y se dice: coercionar en silencio seria peor que el fallo.
  const pedido = args.effort || config.defaultEffort || 'high';
  const effort = pedido === 'medium' ? 'high' : pedido;

  let nota = `Prompt de ${kb} KB, por encima del umbral de ${umbralKb} KB: se usa \`${MODELO_RESUMEN_LARGO}\``
    + ` en vez de \`${porDefecto || 'el modelo por defecto de agy'}\`.`;
  if (effort !== pedido) {
    nota += ` El esfuerzo sube de \`${pedido}\` a \`high\`: la familia Pro no admite \`medium\`.`;
  }
  nota += ' Pasa `model` explicitamente para forzar otro.';

  return { model: MODELO_RESUMEN_LARGO, effort, nota };
}

function executeAgy(args, options = {}) {
  const timeoutMinutes = options.timeoutMinutes || 15;
  const timeoutMs = (timeoutMinutes + 1) * 60 * 1000;
  const cwd = options.cwd || process.cwd();

  const problema = validarModeloEsfuerzo(args);
  if (problema) {
    return Promise.resolve({ success: false, error: problema, stdout: '', stderr: '' });
  }

  const { args: descargados, cleanup: limpiarPrompt } = offloadLargePrompt(args);

  const finalArgs = [...descargados];
  if (!finalArgs.includes('--print-timeout')) {
    finalArgs.unshift('--print-timeout', `${timeoutMinutes}m`);
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const safeArgsForLogging = [];
    for (let i = 0; i < finalArgs.length; i++) {
      if (finalArgs[i] === '-p' && i + 1 < finalArgs.length) {
        safeArgsForLogging.push('-p', '"[PROMPT REDACTED]"');
        i++;
      } else {
        safeArgsForLogging.push(finalArgs[i].includes(' ') ? `"${finalArgs[i]}"` : finalArgs[i]);
      }
    }

    process.stderr.write(`[antigravity-mcp] Spawning: ${AGY_BIN} ${safeArgsForLogging.join(' ')} (cwd: ${cwd}, timeout: ${timeoutMinutes}m)\n`);

    const child = spawn(AGY_BIN, finalArgs, {
      cwd,
      shell: false,
      env: { ...process.env }
    });

    const timer = setTimeout(() => {
      killed = true;
      clearInterval(stopTimer);
      terminateTree(child);
      limpiarPrompt();
      resolve({
        success: false,
        error: `Antigravity MCP process watchdog timed out after ${timeoutMinutes} minutes`,
        stdout,
        stderr
      });
    }, timeoutMs);

    // Sondeo opcional de detención temprana (FEAT-012). Generaliza el mismo
    // mecanismo del watchdog de arriba —terminateTree + resolve— pero
    // disparado por un predicado externo en vez de por tiempo transcurrido.
    // `stopCheck` no se pasa desde ningún otro caso hoy salvo agy_fanout, así
    // que sin él el comportamiento es exactamente el de antes de FEAT-012.
    let stopTimer = null;
    if (typeof options.stopCheck === 'function') {
      stopTimer = setInterval(() => {
        const motivo = options.stopCheck();
        if (!motivo) return;
        killed = true;
        clearTimeout(timer);
        clearInterval(stopTimer);
        terminateTree(child);
        limpiarPrompt();
        resolve({
          success: false,
          error: 'Detenido por el usuario',
          stopped: true,
          motivo: typeof motivo === 'string' ? motivo : (motivo.motivo || null),
          stdout,
          stderr
        });
      }, options.stopCheckIntervalMs || 2000);
      stopTimer.unref?.();
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      process.stderr.write(`[agy stderr] ${chunk}`);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(stopTimer);
      limpiarPrompt();
      resolve({
        success: false,
        error: `Failed to spawn ${AGY_BIN}: ${err.message}`,
        stdout,
        stderr
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(stopTimer);
      limpiarPrompt();
      if (killed) return;

      // El proceso terminó solo antes del próximo tick de stopCheck: un pedido
      // de detención que hubiera llegado justo en ese margen ya no sirve para
      // nada (nada que matar), pero igual hay que consumirlo para no dejar el
      // centinela huérfano en disco hasta la próxima corrida de este slug.
      if (typeof options.stopCheck === 'function') options.stopCheck();

      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {}

      if (code === 0 && (!parsed || parsed.status !== 'ERROR')) {
        resolve({
          success: true,
          data: parsed || { response: stdout },
          rawOutput: stdout
        });
      } else {
        let errorMsg = `Antigravity CLI exited with code ${code}.`;
        if (parsed && parsed.error) {
          errorMsg = `Antigravity error: "${parsed.error}"${parsed.duration_seconds ? ` after ${parsed.duration_seconds.toFixed(1)}s` : ''}.`;
          if (parsed.error.includes('timeout')) {
            errorMsg += `\n\nSuggestion: The task timed out (${timeoutMinutes}m limit). You can retry by increasing 'timeout_minutes' (e.g. 25) or by passing conversation_id: "${parsed.conversation_id}" to continue from where it stopped.`;
          }
        } else if (stderr.trim()) {
          errorMsg += ` Stderr: ${stderr.trim()}`;
        } else if (stdout.trim()) {
          errorMsg += ` Output: ${stdout.trim()}`;
        }

        resolve({
          success: false,
          data: parsed,
          error: errorMsg,
          stdout,
          stderr
        });
      }
    });
  });
}

// Fase 2 (Modo Charla): persistent `agy.exe` stream sessions.
// Distinct from executeAgy() on purpose — that helper blocks until child.on('close'),
// which defeats the point of a low-latency conversational loop (see docs/architecture/voice-chat-architecture.md, section 3.1).
// A session here keeps one agy.exe process alive across many turns via
// `--input-format stream-json --output-format stream-json`, avoiding per-turn cold starts.
//
// Verified stdin schema (2026-08-30, live probing — not documented in `agy --help`):
//   {"event":"user","message":{"content":"<user turn text>"}}
// agy replies with NDJSON on stdout: one `init` (first line only), then per turn a
// `step_update` (step_type: "agent_response", state: "ACTIVE" while streaming, "DONE" when
// that step finishes) carrying `text_delta`, then a `result` event closing the turn.
const voiceStreamSessions = new Map();

function createVoiceStreamSession(options = {}) {
  const streamId = `vs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const cwd = options.cwd || process.cwd();

  const cliArgs = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  const voiceEffort = esfuerzoParaCli({ modelo: options.model, pedido: options.effort, porDefecto: 'low' });
  if (voiceEffort) cliArgs.push('--effort', voiceEffort);
  if (options.model) cliArgs.push('--model', options.model);
  if (options.mode) cliArgs.push('--mode', options.mode);
  if (options.conversation_id) cliArgs.push('--conversation', options.conversation_id);
  if (options.dangerously_skip_permissions !== false) cliArgs.push('--dangerously-skip-permissions');

  process.stderr.write(`[antigravity-mcp] Starting voice stream session ${streamId}: ${AGY_BIN} ${cliArgs.join(' ')} (cwd: ${cwd})\n`);

  const child = spawn(AGY_BIN, cliArgs, {
    cwd,
    shell: false,
    env: { ...process.env }
  });

  const session = {
    id: streamId,
    child,
    cwd,
    model: options.model || null,
    effort: options.effort || 'low',
    conversationId: options.conversation_id || null,
    status: 'starting',
    events: [],
    cursor: 0,
    // Fase 3: groups text_delta fragments into complete sentences for the TTS queue.
    chunker: new SentenceChunker(),
    stderrTail: [],
    exitCode: null,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };

  const rlOut = readline.createInterface({ input: child.stdout, terminal: false });
  rlOut.on('line', (line) => {
    if (!line.trim()) return;
    session.lastActivity = Date.now();

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      session.events.push({ event: 'parse_error', raw: line, ts: Date.now() });
      return;
    }

    if (parsed.event === 'init') {
      session.conversationId = parsed.conversation_id || session.conversationId;
      session.status = 'ready';
    }

    parsed._ts = Date.now();
    session.events.push(parsed);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    session.stderrTail.push(text);
    if (session.stderrTail.length > 20) session.stderrTail.shift();
    process.stderr.write(`[agy voice-stream ${streamId} stderr] ${text}`);
  });

  child.on('error', (err) => {
    session.status = 'error';
    session.events.push({ event: 'process_error', error: err.message, ts: Date.now() });
  });

  child.on('close', (code) => {
    session.status = 'stopped';
    session.exitCode = code;
    session.events.push({ event: 'process_closed', code, ts: Date.now() });
  });

  voiceStreamSessions.set(streamId, session);
  return session;
}

function sendVoiceStreamTurn(session, text) {
  if (session.status === 'stopped' || session.status === 'error') {
    throw new Error(`Voice stream session ${session.id} is not running (status: ${session.status}).`);
  }
  const line = JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
  session.child.stdin.write(line);
  session.lastActivity = Date.now();
}

function drainVoiceStreamEvents(session) {
  const drained = session.events.slice(session.cursor);
  session.cursor = session.events.length;
  return drained;
}

function stopVoiceStreamSession(session) {
  try { session.child.stdin.end(); } catch {}
  terminateTree(session.child);
  session.status = 'stopped';
}

// `invokeTelegramBridge` (salida hacia Telegram y human-in-the-loop) vive en
// telegram-cli.js, donde se puede probar.

// Tool Handlers
async function handleToolCall(name, args) {
  const config = loadConfig(args.cwd);

  switch (name) {
    case 'agy_usage': {
      if (args.reset) {
        resetUsage();
        return {
          content: [
            {
              type: 'text',
              text: 'Antigravity session usage metrics have been reset to 0.'
            }
          ]
        };
      }

      const usageData = loadUsage();
      const activeModel = config.defaultModel || 'gemini-3.8-flash';
      const specs = getModelSpecs(activeModel);
      const s = usageData.session;
      const last = usageData.last_call;

      let out = `### 📊 Antigravity Subagent — Model & Usage Metrics\n\n`;

      out += `**🤖 Active Model Configuration:**\n`;
      out += `- Model: \`${specs.name}\` (${specs.description})\n`;
      out += `- Default Reasoning Effort: ${config.defaultEffort ? `\`${config.defaultEffort}\` (only applied to Gemini models without an effort suffix)` : '_none: agy decides_'}\n`;
      // Sin cifra fiable se dice, no se rellena.
      out += `- Context Window: ${specs.contextWindow ? `\`${formatTokens(specs.contextWindow)} tokens\`` : '_not published for this model_'}\n`;
      out += `- Max Output Tokens: ${specs.maxOutput ? `\`${formatTokens(specs.maxOutput)} tokens\`` : '_not published for this model_'}\n`;
      out += `- Session Default Timeout: \`${config.defaultTimeoutMinutes}m\` (20m for reviews)\n`;
      out += `- Quota / API Health: **${usageData.quota_status}**\n\n`;

      out += `**📈 Cumulative Session Usage:**\n`;
      out += `- Total Delegated Calls: **${s.total_calls}** (run: ${s.calls_by_tool.run || 0}, plan: ${s.calls_by_tool.plan || 0}, review: ${s.calls_by_tool.review || 0}, audit: ${s.calls_by_tool.audit || 0}, research: ${s.calls_by_tool.research || 0}, summary: ${s.calls_by_tool.summary || 0}, narrate: ${s.calls_by_tool.narrate || 0}, say: ${s.calls_by_tool.say || 0})\n`;
      out += `- Input Tokens: \`${formatTokens(s.input_tokens)}\`\n`;
      out += `- Output Tokens: \`${formatTokens(s.output_tokens)}\`\n`;
      out += `- Thinking / Reasoning Tokens: \`${formatTokens(s.thinking_tokens)}\`\n`;
      out += `- Context Caching Reused: \`${formatTokens(s.cache_read_tokens)}\` tokens\n`;
      out += `- Total Tokens Processed: **\`${formatTokens(s.total_tokens)}\`**\n`;
      out += `- Total Reasoning Time: **${formatDuration(s.total_duration_seconds)}**\n\n`;

      if (last && last.usage) {
        out += `**🎯 Last Invocation (${last.tool}):**\n`;
        out += `- Model: \`${last.model}\` | Effort: \`${last.effort}\`\n`;
        // Sin ventana conocida no hay porcentaje: una barra al 0% se lee como
        // «no has consumido nada», que es peor que no mostrarla.
        const saturacion = specs.contextWindow
          ? ` ${renderProgressBar((last.usage.total_tokens / specs.contextWindow) * 100)} of context window`
          : '';
        out += `- Total Tokens: **\`${formatTokens(last.usage.total_tokens)}\`**${saturacion}\n`;
        out += `- Deep Thinking: \`${formatTokens(last.usage.thinking_tokens)}\` tokens\n`;
        out += `- Cached Tokens: \`${formatTokens(last.usage.cache_read_tokens)}\` tokens\n`;
        out += `- Duration: ${formatDuration(last.duration_seconds)}\n`;
        if (last.conversation_id) {
          out += `- Conversation ID: \`${last.conversation_id}\`\n`;
        }
      } else {
        out += `*No subagent invocations recorded in this session yet.*\n`;
      }

      out += `\n*Tip: Run \`/lagrange:usage reset\` or pass \`reset: true\` to clear session counters.*`;

      return {
        content: [
          {
            type: 'text',
            text: out
          }
        ]
      };
    }

    case 'agy_status': {
      let version = 'unknown';
      try {
        version = execFileSync(AGY_BIN, ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      } catch {
        try {
          version = execFileSync(AGY_BIN, ['help'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).split('\n')[0].trim();
        } catch {}
      }

      const p = config.permissions;
      return {
        content: [
          {
            type: 'text',
            text: `Antigravity CLI Status:\n- Binary: ${AGY_BIN}\n- Version/Info: ${version || 'Available'}\n- OS: ${process.platform} (${process.arch})\n- Default Model: ${config.defaultModel || '(cli default: gemini-3.8-flash)'}\n- Default Effort: ${config.defaultEffort ? `${config.defaultEffort} (only for Gemini models without an effort suffix)` : '(none: agy decides)'}\n- Default Timeout: ${config.defaultTimeoutMinutes}m\n- Permissions Policy:\n  * Allow: [${p.allow.join(', ')}]\n  * Deny: [${p.deny.join(', ') || 'none'}]\n  * Denied Paths: [${p.deny_paths.join(', ')}]\n  * Denied Commands: [${p.deny_commands.join(', ')}]\n  * Sandbox Mode: ${p.sandbox ? 'enabled' : 'disabled'}\n- Active Config File: ${config.configFile || 'none (using defaults)'}\n- Ready to execute subagent tasks.`
          }
        ]
      };
    }

    case 'agy_set_config': {
      const scope = args.scope || 'global';
      const updates = {};
      if (args.model !== undefined) updates.model = args.model;
      if (args.effort !== undefined) updates.effort = args.effort;
      if (args.timeout_minutes !== undefined) updates.timeout_minutes = args.timeout_minutes;
      if (args.permissions !== undefined) updates.permissions = args.permissions;
      if (args.fanout_statusline !== undefined) updates.fanout_statusline = args.fanout_statusline;
      if (args.fanout_statusline_delegate !== undefined) updates.fanout_statusline_delegate = args.fanout_statusline_delegate;
      // voicebox_url/voicebox_port: saveConfig ya los aceptaba, pero nadie se
      // los pasaba — la tool los ignoraba en silencio.
      for (const clave of ['voicebox_url', 'voicebox_port', ...CLAVES_VOICEBOX_CONFIG]) {
        if (args[clave] !== undefined) updates[clave] = args[clave];
      }

      const result = saveConfig(updates, scope, args.cwd);
      return {
        content: [
          {
            type: 'text',
            text: `Antigravity configuration updated successfully (${scope} scope in ${result.targetFile}):\n- Default Model: ${result.config.model || '(cli default)'}\n- Default Effort: ${result.config.effort || '(none: agy decides)'}\n- Default Timeout: ${result.config.timeout_minutes || 15}m\n- Fanout statusline: ${result.config.fanout_statusline === false ? 'disabled' : 'enabled'}\n- Voicebox: autostart ${result.config.voicebox_autostart === false ? 'off' : 'on'}, idle unload ${result.config.voicebox_idle_unload_minutes ?? 10}m, idle shutdown ${result.config.voicebox_idle_shutdown_minutes ?? 30}m, statusline ${result.config.statusline_voicebox === false ? 'off' : 'on'}${result.config.voicebox_url ? `, url ${result.config.voicebox_url}` : ''}${result.config.voicebox_port ? `, port ${result.config.voicebox_port}` : ''}${result.config.voicebox_server_exe ? `, exe ${result.config.voicebox_server_exe}` : ''}${result.config.voz_por_perfil ? `, voz_por_perfil ${JSON.stringify(result.config.voz_por_perfil)}` : ''}${result.config.omnivoice_class_temperature !== undefined ? `, omnivoice class_temperature ${result.config.omnivoice_class_temperature}` : ''}\n- Permissions: ${JSON.stringify(result.config.permissions || {}, null, 2)}`
          }
        ]
      };
    }

    case 'agy_fanout': {
      const repoPath = args.cwd || process.cwd();

      // Lector de centinelas de detención (FEAT-012), opcional igual que el
      // escritor de estado de abajo: si está desactivado, `stopCheck` nunca se
      // pasa y executeAgy se comporta exactamente igual que sin la feature.
      const lectorControl = config.fanoutControl !== false
        ? crearLectorDeControl(repoPath, args.slug)
        : null;

      // El ejecutor que se le inyecta al orquestador arma los mismos argumentos
      // que agy_run. `--sandbox` no se ofrece a propósito: rompe el aislamiento
      // por worktree en vez de reforzarlo, y exige UAC (H1 a H3 del documento de
      // diseño). El confinamiento acá es el worktree.
      //
      // `--output-format` no se pasa acá (FEAT-009): lo fija executeAgyStreaming
      // en stream-json, para poder volcar cada evento al log NDJSON del
      // subagente a medida que llega, en vez de bufferear hasta el cierre.
      const ejecutar = async (peticion) => {
        const cliArgs = ['--dangerously-skip-permissions'];
        cliArgs.push('--mode', peticion.mode || 'accept-edits');
        const modelo = peticion.model || config.defaultModel;
        const esfuerzo = esfuerzoParaCli({ modelo, pedido: peticion.effort, porDefecto: config.defaultEffort });
        if (esfuerzo) cliArgs.push('--effort', esfuerzo);
        if (modelo) cliArgs.push('--model', modelo);
        cliArgs.push('-p', peticion.prompt);

        // Log NDJSON por subagente (FEAT-009), opcional igual que el resto de
        // esta feature: si está desactivado, `onLine` es un no-op y
        // executeAgyStreaming corre exactamente igual (la diferencia es
        // solo si se persiste a disco, no cómo se invoca a agy).
        let fdLog = null;
        if (config.fanoutProgressLog !== false) {
          try { fdLog = fs.openSync(rutaProgreso(repoPath, args.slug, peticion.taskId), 'a'); } catch {}
        }
        const onLine = fdLog !== null
          ? (linea) => { try { fs.writeSync(fdLog, linea + '\n'); } catch {} }
          : undefined;

        let res;
        try {
          res = await executeAgyStreaming(AGY_BIN, cliArgs, {
            cwd: peticion.cwd,
            timeoutMinutes: peticion.timeout_minutes || config.defaultTimeoutMinutes || 15,
            stopCheck: lectorControl ? () => lectorControl.consumirDetencion(peticion.taskId) : undefined,
            stopCheckIntervalMs: config.fanoutStopCheckIntervalMs,
            terminate: terminateTree,
            onLine
          });
        } finally {
          if (fdLog !== null) { try { fs.closeSync(fdLog); } catch {} }
        }

        const datos = res.data || {};
        recordUsage('run', modelo, peticion.effort, datos.conversation_id || '',
          datos.duration_seconds || 0, datos.usage, !res.success, res.error || '');

        return { ...res, conversation_id: datos.conversation_id };
      };

      // El escritor de estado es opcional (FEAT-005 V1): si está desactivado no
      // se crea, y lanzarFanout cae de vuelta a su no-op interno.
      const registrarEstado = config.fanoutStatusline !== false
        ? crearEscritorDeEstado(repoPath, args.slug, args.tareas)
        : undefined;

      // Barrido de centinelas viejos (FEAT-012): una sola vez por tarea, ANTES
      // del primer lote — nunca en cada intento, para no arriesgarse a borrar
      // un pedido de detención legítimo escrito mientras la tarea espera turno
      // en un lote siguiente o durante el backoff de un reintento por cuota.
      // Encontrado por auditoría adversarial (agy_audit, 2026-09-09): la
      // primera versión limpiaba dentro de `ejecutar`, en cada intento.
      const limpiarControlPrevio = lectorControl
        ? (taskId) => lectorControl.limpiar(taskId)
        : undefined;

      // Mismo motivo, mismo punto de enganche, para el log NDJSON de FEAT-009:
      // barrer el de una corrida anterior con el mismo slug/taskId antes de
      // que arranque el primer lote, para no mezclar eventos de corridas
      // distintas en el mismo archivo.
      const limpiarProgresoPrevio = config.fanoutProgressLog !== false
        ? (taskId) => limpiarProgreso(repoPath, args.slug, taskId)
        : undefined;

      let salida;
      try {
        salida = await lanzarFanout({
          repoPath,
          slug: args.slug,
          tareas: args.tareas,
          concurrencia: args.concurrencia,
          modelo: args.modelo,
          effort: args.effort,
          timeoutMinutes: args.timeout_minutes
        }, { ejecutar, registrarEstado, limpiarControlPrevio, limpiarProgresoPrevio });
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `No se pudo lanzar el fan-out: ${err.message}` }]
        };
      }

      if (!salida.lanzado) {
        return {
          isError: true,
          content: [{ type: 'text', text: salida.detalle }]
        };
      }

      let texto = `### Fan-out lanzado — ${salida.resumen.total} subagente(s)\n\n`;
      texto += `- Rama base: \`${salida.ramaBase}\`${salida.ramaBaseCreada ? ' (creada ahora)' : ''}\n`;
      texto += `- Concurrencia: ${salida.concurrencia} · ${salida.lotes} lote(s)\n`;
      texto += `- Resultado: ${salida.resumen.exitosas} ok, ${salida.resumen.fallidas} fallidas`;
      const detalleFallas = [];
      if (salida.resumen.fallidasPorCuota) detalleFallas.push(`${salida.resumen.fallidasPorCuota} por cuota`);
      if (salida.resumen.fallidasDetenidas) detalleFallas.push(`${salida.resumen.fallidasDetenidas} detenidas`);
      texto += detalleFallas.length ? ` (${detalleFallas.join(', ')})\n\n` : '\n\n';

      texto += `| Tarea | Rama | Estado | Intentos | Conversation ID |\n|---|---|---|---|---|\n`;
      for (const r of salida.resultados) {
        const estado = r.exito ? 'ok' : (r.detenido ? 'detenida' : (r.porCuota ? 'falló (cuota)' : 'falló'));
        texto += `| \`${r.id}\` | \`${r.rama}\` | ${estado} | ${r.intentos} | ${r.conversation_id || '—'} |\n`;
      }

      const fallidas = salida.resultados.filter(r => !r.exito);
      if (fallidas.length) {
        texto += `\n**Errores:**\n`;
        for (const r of fallidas) texto += `- \`${r.id}\`: ${r.error}\n`;
      }

      texto += `\n**Siguiente paso (tuyo, no de los subagentes):** ${salida.siguientePaso}\n`;
      texto += `\nLos worktrees siguen en \`.claude/worktrees/\`. Cuando termines de integrar, `;
      texto += `limpiá los que queden sin trabajo pendiente.\n`;
      if (config.fanoutProgressLog !== false) {
        texto += `\nLog NDJSON por subagente en \`.claude/worktrees/.agy-progress-${args.slug}-<taskId>.jsonl\` `;
        texto += `(un evento por línea, tal como lo emite \`agy\`).\n`;
      }

      return { content: [{ type: 'text', text: texto }] };
    }

    case 'cast_agent': {
      const accion = args.action || 'cast';
      const homeDir = os.homedir();

      const texto = t => ({ content: [{ type: 'text', text: t }] });
      const error = t => ({ isError: true, content: [{ type: 'text', text: t }] });

      if (accion === 'skills') {
        const skills = registroAgentes.listarSkills(homeDir);
        if (!skills.length) {
          return error(`No hay SKILLs instalados en \`${registroAgentes.dirSkills(homeDir)}\`.`);
        }
        return texto(
          `### SKILLs disponibles (${skills.length})\n\n`
          + skills.map(n => `- \`${n}\``).join('\n')
          + '\n\nRegistrá uno con `action: "register"`, `agent: "<nombre-corto>"`, `skill: "<skill>"`.'
        );
      }

      if (accion === 'list') {
        const agentes = await registroAgentes.listar(AGY_BIN, homeDir);
        if (!agentes.length) {
          return texto('No hay agentes persistidos registrados todavía. Usá `action: "register"`.');
        }
        let salida = `### Agentes persistidos (${agentes.length})\n\n`;
        salida += '| Agente | SKILL | Acceso | Resuelve | Hilo | Casts |\n|---|---|---|---|---|---|\n';
        for (const a of agentes) {
          const est = estadoAgentes.estadoDe(a.nombre, homeDir) || {};
          const hilo = est.conversation_id ? `\`${est.conversation_id.slice(0, 12)}…\`` : '—';
          salida += `| \`${a.nombre}\` | \`${a.skill}\` | ${a.read_only ? 'read-only' : 'read/write'} `
            + `| ${a.resuelve ? '✅' : '⚠️ no'} | ${hilo} | ${est.casts || 0} |\n`;
        }
        const rotos = agentes.filter(a => !a.resuelve);
        if (rotos.length) {
          salida += `\n⚠️ Antigravity no resuelve ${rotos.map(a => `\`${a.nombre}\``).join(', ')}. `
            + 'Castearlos se aborta a propósito: `--agent` con un nombre inexistente cae en silencio al agente por defecto, con escritura completa. Volvé a registrarlos.';
        }
        return texto(salida);
      }

      if (accion === 'register') {
        if (!args.agent || !args.skill) {
          return error('`register` necesita `agent` (nombre corto) y `skill` (SKILL de origen).');
        }
        let entrada;
        try {
          entrada = registroAgentes.instalarAgente(args.agent, {
            skill: args.skill,
            readOnly: args.read_only !== false,
            projectId: args.project_id,
            addendum: args.addendum
          }, homeDir);
        } catch (err) {
          return error(`No se pudo registrar el agente: ${err.message}`);
        }

        // Verificar contra agy es parte del registro, no un extra: un agente que
        // no resuelve es peor que uno que no existe, porque el cast igual corre.
        const verificacion = await registroAgentes.verificarResuelve(args.agent, AGY_BIN);
        const servers = memoriaAgentes.serversMcpDelUsuario(homeDir);

        let salida = `### Agente \`${args.agent}\` registrado\n\n`;
        salida += `- SKILL de origen: \`${entrada.skill}\`\n`;
        salida += `- Acceso: ${entrada.read_only ? '`read-only`' : '`read/write`'}\n`;
        salida += `- Tools nativas: ${entrada.tools.map(t => `\`${t}\``).join(', ')}\n`;
        salida += `- Definición: \`${entrada.agent_md}\`\n`;
        salida += `- Addendum de proyecto: ${entrada.addendum ? `sí (${entrada.addendum.length} caracteres)` : 'no'}\n`;
        salida += `- Antigravity lo resuelve: ${verificacion.ok ? '✅ sí' : '⚠️ no'}\n`;
        if (!verificacion.ok) salida += `\n⚠️ ${verificacion.motivo}\n`;
        if (entrada.read_only && servers.length) {
          salida += `\n> **Límite de \`read-only\`:** Antigravity inyecta \`call_mcp_tool\` sin importar el allowlist, `
            + `así que este agente alcanza igual tus servidores MCP: ${servers.map(x => `\`${x}\``).join(', ')}. `
            + 'El allowlist cierra las tools nativas de escritura, no la puerta MCP.\n';
        }
        return texto(salida);
      }

      if (accion === 'unregister') {
        if (!args.agent) return error('`unregister` necesita `agent`.');
        let existia;
        try {
          existia = registroAgentes.desinstalarAgente(args.agent, homeDir);
        } catch (err) {
          return error(`No se pudo desregistrar: ${err.message}`);
        }
        return texto(existia
          ? `Agente \`${args.agent}\` desregistrado. Su memoria en mcp-memory queda intacta.`
          : `No había ningún agente registrado como \`${args.agent}\`.`);
      }

      if (accion === 'forget') {
        if (!args.agent) return error('`forget` necesita `agent`.');
        const habia = estadoAgentes.olvidarHilo(args.agent, homeDir);
        return texto(habia
          ? `Hilo de \`${args.agent}\` olvidado. El próximo cast arranca conversación nueva, con la misma identidad y la misma memoria de largo plazo.`
          : `\`${args.agent}\` no tenía ningún hilo guardado.`);
      }

      // --- cast ---
      // La orquestación vive en agents/cast.js, compartida con el `/cast` del
      // bot de Telegram (FEAT-022). Acá queda solo lo propio del MCP: registrar
      // uso y formatear la salida para Claude Code.
      if (!args.agent) return error('`cast` necesita `agent`. Usá `action: "list"` para ver los registrados.');
      if (!args.prompt) return error('`cast` necesita `prompt`.');

      const cast = await castAgentes.castear({
        agent: args.agent,
        prompt: args.prompt,
        cwd: args.cwd,
        agyBin: AGY_BIN,
        homeDir,
        ejecutar: (cliArgs, { cwd, timeoutMinutes }) => executeAgy(cliArgs, { cwd, timeoutMinutes }),
        opciones: {
          memory: args.memory,
          fresh: args.fresh,
          projectId: args.project_id,
          budgetTokens: args.budget_tokens,
          model: args.model || config.defaultModel,
          effort: args.effort,
          effortPorDefecto: config.defaultEffort,
          timeoutMinutes: args.timeout_minutes || config.defaultTimeoutMinutes || 15
        }
      });

      if (cast.usage) {
        recordUsage('cast', cast.model, cast.effort, cast.conversationId || '', cast.duracion,
          cast.usage, !cast.ok, cast.error || '');
      }

      if (!cast.ok) {
        if (cast.noRegistrado) {
          const conocidos = Object.keys(registroAgentes.leerRegistro(homeDir).agents);
          return error(
            `\`${args.agent}\` no está registrado como agente persistido.`
            + (conocidos.length ? ` Registrados: ${conocidos.map(x => `\`${x}\``).join(', ')}.` : '')
            + ' Registralo con `action: "register"`.'
          );
        }
        // Sin `conversationId` en el resultado, el cast no llegó a ejecutarse
        // (falló la verificación contra `agy agents`): el motivo va tal cual.
        if (!('conversationId' in cast)) return error(cast.error);
        let err = `Falló el cast de \`${args.agent}\`:\n${cast.error}`;
        if (cast.conversationId) err += `\n\nEl hilo \`${cast.conversationId}\` quedó guardado: el próximo cast lo retoma.`;
        return error(err);
      }

      let salida = `${cast.respuesta.trim()}\n\n---\n`;
      salida += `**Cast de \`${args.agent}\`** (SKILL: \`${cast.entrada.skill}\`)\n`;
      salida += `- Acceso: \`${cast.entrada.read_only ? 'read-only' : 'read/write'}\``
        + `${cast.entrada.read_only ? ' (allowlist de tools + `--mode plan`)' : ''}\n`;
      salida += `- Contexto recuperado: ${cast.memoria.recuperada ? '✅ sí' : `— no (${cast.memoria.motivo || 'memoria desactivada'})`}\n`;
      // Que esto se vea importa: si el agente deja de emitir el bloque, el
      // síntoma es silencioso (sigue respondiendo bien, pero nunca más
      // aprende). Acá se nota en el acto.
      if (cast.memoria.usada) {
        let criterio;
        if (cast.memoria.guardadas) {
          criterio = `✅ ${cast.memoria.guardadas} entrada(s)`;
        } else if (cast.memoria.extraidas) {
          criterio = `⚠️ ninguna: el agente emitió ${cast.memoria.extraidas} entrada(s) `
            + `pero la memoria no aceptó el cierre (${cast.memoria.motivoCierre})`;
        } else {
          criterio = '— ninguna (el agente no emitió bloque de memoria en este turno)';
        }
        salida += `- Criterio guardado: ${criterio}\n`;
      }
      if (cast.conversationId) {
        salida += `- Hilo: \`${cast.conversationId}\`${cast.continuado ? ' (continuado)' : ' (nuevo)'}\n`;
      }
      salida += `- Duración: ${cast.duracion ? `${cast.duracion.toFixed(1)}s` : 'desconocida'} (límite: ${cast.timeoutMinutes}m)\n`;
      if (cast.usage) {
        salida += `- Tokens: entrada ${cast.usage.input_tokens}, salida ${cast.usage.output_tokens}\n`;
      }

      return texto(salida);
    }

    case 'agy_run': {
      const effectivePerms = resolvePermissions(args.permissions, config);
      const canEdit = permits(effectivePerms, 'edit');

      let effectiveMode = args.mode || (canEdit ? 'accept-edits' : 'plan');
      if (!canEdit && effectiveMode === 'accept-edits') {
        effectiveMode = 'plan';
      }

      const cliArgs = ['--output-format', 'json'];

      if (args.dangerously_skip_permissions !== false) {
        cliArgs.push('--dangerously-skip-permissions');
      }

      cliArgs.push('--mode', effectiveMode);

      if (effectivePerms.sandbox) {
        cliArgs.push('--sandbox');
      }

      const effectiveModel = args.model || config.defaultModel;
      const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: config.defaultEffort });
      if (effectiveEffort) cliArgs.push('--effort', effectiveEffort);
      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      if (args.conversation_id) {
        cliArgs.push('--conversation', args.conversation_id);
      } else if (args.continue_session) {
        cliArgs.push('-c');
      }

      const finalPrompt = applyGuardrails(args.prompt, buildSecurityRules(effectivePerms));

      cliArgs.push('-p', finalPrompt);

      const timeoutMin = args.timeout_minutes || config.defaultTimeoutMinutes || 15;
      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: timeoutMin
      });

      const resData = result.data || {};
      const conversationId = resData.conversation_id || args.conversation_id || '';
      const duration = resData.duration_seconds || 0;

      // Record telemetry
      if (resData.usage) {
        recordUsage('run', effectiveModel, effectiveEffort, conversationId, duration, resData.usage, !result.success, result.error || '');
      }

      if (!result.success) {
        let errText = `Error executing Antigravity subagent:\n${result.error}`;
        if (conversationId) {
          errText += `\n\nSession Conversation ID: \`${conversationId}\``;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      const responseText = resData.response || result.rawOutput || '(No response text returned)';
      const durationStr = duration ? `${duration.toFixed(1)}s` : 'unknown';
      const tokens = resData.usage ? `Input: ${resData.usage.input_tokens}, Output: ${resData.usage.output_tokens}, Thinking: ${resData.usage.thinking_tokens || 0}` : '';

      let formatted = `${responseText.trim()}\n\n---\n`;
      formatted += `**Antigravity Execution Details:**\n`;
      if (effectiveModel) formatted += `- Model: \`${effectiveModel}\`\n`;
      formatted += `- Effort: \`${effectiveEffort}\`\n`;
      // La etiqueta se derivaba solo de los permisos, así que una sesión en
      // `--mode plan` se anunciaba como (read/write) pese a tener las escrituras
      // bloqueadas por el propio CLI. Plan mode manda: es el único read-only con
      // enforcement real, frente a los guardarraíles de permisos, que viajan
      // como texto en el prompt.
      const soloLectura = effectiveMode === 'plan' || !canEdit;
      formatted += `- Mode: \`${effectiveMode}\` (${soloLectura ? 'read-only' : 'read/write'})\n`;
      formatted += `- Permissions Enforced: ${formatPermissionSummary(effectivePerms)}\n`;
      if (conversationId) {
        formatted += `- Conversation ID: \`${conversationId}\` (pass as \`conversation_id\` to continue this thread)\n`;
      }
      formatted += `- Duration: ${durationStr} (timeout limit: ${timeoutMin}m)\n`;
      if (tokens) {
        formatted += `- Tokens: ${tokens}\n`;
      }

      return {
        content: [
          {
            type: 'text',
            text: formatted
          }
        ]
      };
    }

    case 'agy_voice_stream': {
      const action = args.action;

      if (action === 'start') {
        const effectiveModel = args.model || config.defaultModel;
        const effectiveEffort = args.effort || 'low';
        const effectiveMode = args.mode || 'plan';

        const session = createVoiceStreamSession({
          cwd: args.cwd,
          model: effectiveModel,
          effort: effectiveEffort,
          mode: effectiveMode,
          conversation_id: args.conversation_id,
          dangerously_skip_permissions: args.dangerously_skip_permissions
        });

        let prewarmNote = '';
        if (args.prewarm_voicebox !== false) {
          const voiceboxUrl = resolveVoiceboxUrl(args, config);
          const modelSize = args.voicebox_model_size || '1.7B';
          // Además de precargar: levanta Voicebox si no corre, y respeta el pin
          // y la regla de un solo TTS residente antes de cargar (plan A y C).
          (async () => {
            const s = await vb.ensureVoicebox(voiceboxUrl, { config });
            if (!s.ok) return { ok: false, error: s.error };
            const a = await vb.aplicarModeloActivo(servidoresVoz(voiceboxUrl, config), { engine: 'qwen', modelSize });
            if (!a.ok) return { ok: false, error: a.error };
            return voiceboxModelsLoad(voiceboxUrl, modelSize);
          })()
            .then((r) => {
              if (!r.ok) {
                process.stderr.write(`[antigravity-mcp] Voicebox pre-warm failed for session ${session.id}: ${r.error}\n`);
              }
            })
            .catch((err) => {
              process.stderr.write(`[antigravity-mcp] Voicebox pre-warm error for session ${session.id}: ${err.message}\n`);
            });
          prewarmNote = `\n- Voicebox pre-warm: requested \`POST ${voiceboxUrl}/models/load?model_size=${modelSize}\` (non-blocking)`;
        }

        // Give the process a short window to emit its `init` event so conversation_id
        // is available immediately, without making session start wait on a full turn.
        const deadline = Date.now() + 3000;
        while (session.status === 'starting' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }

        // Priming turn: without this, agy treats spoken questions as coding-agent tasks
        // and can do things like write a plan.md file instead of just answering out loud
        // (verified live 2026-08-30 — a plain "tell me two facts" prompt produced a written
        // plan document and markdown links). Send one throwaway turn establishing
        // conversational behavior, then drain it away so callers never see it.
        let primingNote = '';
        if (args.prime_conversational !== false) {
          // Incluye la regla del aviso previo antes de usar herramientas (lib/voice-drain.js).
          const primingText = PRIMING_CHARLA;
          try {
            sendVoiceStreamTurn(session, primingText);
            const primingDeadline = Date.now() + 10000;
            while (Date.now() < primingDeadline && !session.events.slice(session.cursor).some(e => e.event === 'result')) {
              await new Promise((r) => setTimeout(r, 50));
            }
            drainVoiceStreamEvents(session); // discard the priming exchange
            primingNote = '\n- Priming conversacional: aplicado';
          } catch (err) {
            primingNote = `\n- Priming conversacional: falló (${err.message})`;
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Voice stream session started.\n- stream_id: \`${session.id}\`\n- conversation_id: \`${session.conversationId || 'pending'}\`\n- Model: \`${effectiveModel || 'default'}\` | Effort: \`${effectiveEffort}\` | Mode: \`${effectiveMode}\`\n- Status: \`${session.status}\`${prewarmNote}${primingNote}\n\nUse \`action: "send"\` with this stream_id to send a turn, then poll \`action: "drain"\` to read incremental text_delta events as they arrive.`
          }]
        };
      }

      const session = voiceStreamSessions.get(args.stream_id);
      if (!session) {
        return {
          isError: true,
          content: [{ type: 'text', text: `No voice stream session found with stream_id "${args.stream_id}". Call action: "start" first.` }]
        };
      }

      if (action === 'send') {
        if (!args.text) {
          return { isError: true, content: [{ type: 'text', text: '"text" is required for action "send".' }] };
        }
        try {
          sendVoiceStreamTurn(session, args.text);
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: err.message }] };
        }
        return {
          content: [{ type: 'text', text: `Turn sent to session \`${session.id}\`. Poll \`action: "drain"\` to receive text_delta events as they stream in.` }]
        };
      }

      if (action === 'drain') {
        const events = drainVoiceStreamEvents(session);
        // Fase 3: each delta goes through the per-session Sentence Chunker so the
        // caller gets TTS-ready sentences. The chunker is flushed on turn completion
        // (short replies like "OK") and when a tool step starts, so a spoken
        // heads-up before a web search is not held until the search ends.
        const { sentences, deltas, herramientas, resultEvent } = procesarEventosDrain(events, session.chunker, session.drainEstado || (session.drainEstado = {}));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              stream_id: session.id,
              status: session.status,
              conversation_id: session.conversationId,
              turn_complete: !!resultEvent,
              sentences,
              deltas,
              herramientas,
              result: resultEvent ? resultEvent.result : null,
              raw_event_count: events.length
            }, null, 2)
          }]
        };
      }

      if (action === 'status') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              stream_id: session.id,
              status: session.status,
              conversation_id: session.conversationId,
              model: session.model,
              effort: session.effort,
              pid: session.child.pid,
              buffered_undrained_events: session.events.length - session.cursor,
              created_at: new Date(session.createdAt).toISOString(),
              last_activity: new Date(session.lastActivity).toISOString(),
              exit_code: session.exitCode
            }, null, 2)
          }]
        };
      }

      if (action === 'stop') {
        stopVoiceStreamSession(session);
        voiceStreamSessions.delete(session.id);
        return { content: [{ type: 'text', text: `Voice stream session \`${session.id}\` stopped.` }] };
      }

      return { isError: true, content: [{ type: 'text', text: `Unknown action "${action}" for agy_voice_stream.` }] };
    }

    case 'agy_plan': {
      const planPrompt = `You are acting as an Architectural & Planning Subagent.
Task:
${args.task}

Analyze the codebase and provide a thorough, structured step-by-step implementation plan.
DO NOT execute code modifications. Outline files to create/modify, architectural choices, edge cases, tests to write, and verification steps.`;

      const effectiveModel = args.model || config.defaultModel;
      const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: config.defaultEffort });
      const perms = resolvePermissions(args.permissions, config);

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan'
      ];
      if (effectiveEffort) cliArgs.push('--effort', effectiveEffort);

      if (perms.sandbox) {
        cliArgs.push('--sandbox');
      }

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      if (args.conversation_id) {
        cliArgs.push('--conversation', args.conversation_id);
      }

      cliArgs.push('-p', applyGuardrails(planPrompt, buildSecurityRules(perms, { readOnly: true })));

      const timeoutMin = args.timeout_minutes || config.defaultTimeoutMinutes || 15;
      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: timeoutMin
      });

      const resData = result.data || {};
      const conversationId = resData.conversation_id || args.conversation_id || '';
      const duration = resData.duration_seconds || 0;

      if (resData.usage) {
        recordUsage('plan', effectiveModel, effectiveEffort, conversationId, duration, resData.usage, !result.success, result.error || '');
      }

      if (!result.success) {
        let errText = `Error generating plan with Antigravity:\n${result.error}`;
        if (conversationId) {
          errText += `\n\nSession Conversation ID: \`${conversationId}\``;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      const responseText = resData.response || result.rawOutput || '';

      let formatted = `### Antigravity Implementation Plan\n\n${responseText.trim()}\n\n---\n`;
      formatted += `Effort: \`${effectiveEffort}\``;
      if (effectiveModel) formatted += ` | Model: \`${effectiveModel}\``;
      formatted += ` | Mode: \`plan\` (read-only enforced) | Timeout: \`${timeoutMin}m\``;
      formatted += `\nPermissions Enforced: ${formatPermissionSummary(perms)}`;
      if (conversationId) {
        formatted += `\nConversation ID: \`${conversationId}\` (pass as \`conversation_id\` to refine this plan, or to \`agy_run\` to begin execution)`;
      }

      return {
        content: [{ type: 'text', text: formatted }]
      };
    }

    case 'agy_audit': {
      const auditMode = args.audit_mode || 'implementation';
      const modeLabel = auditMode === 'plan' ? 'Mode 2 — Plan vs. Real Project' : 'Mode 1 — Implementation vs. Plan';

      let auditPrompt = `${ADVERSARIAL_REVIEW_PROMPT}\n\n---\n\n[AUDIT TASK]\n\nYou are operating in **${modeLabel}**.\n\n`;

      if (auditMode === 'implementation') {
        if (args.plan) {
          auditPrompt += `## Plan / Spec / Acceptance Criteria\n\n${args.plan}\n\n`;
        } else {
          auditPrompt += `## Plan / Spec\n\n(No explicit plan provided. Infer requirements from the code changes, commit messages, and any available documentation. Flag this as a review limitation.)\n\n`;
        }
        auditPrompt += `## Implementation to Audit\n\n${args.target}\n\n`;
        auditPrompt += `Perform the full Mode 1 process: rebuild the plan as an atomic checklist, map each requirement to the implementation, classify coverage, look for deviations, check project fit, inspect and execute tests, then assign severity and verdict.\n`;
      } else {
        auditPrompt += `## Proposed Plan / Design to Audit Against the Real Codebase\n\n${args.target}\n\n`;
        auditPrompt += `Perform the full Mode 2 process: investigate the repository FIRST before judging. Search for existing flows, reconstruct current behavior, contrast with the plan, check for contradictions, evaluate integration points, evaluate testability, explicitly check for over-engineering, then assign severity and verdict.\n`;
      }

      const effectiveModel = args.model || config.defaultModel;
      const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: config.defaultEffort });
      const perms = resolvePermissions(args.permissions, config);

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan'
      ];
      if (effectiveEffort) cliArgs.push('--effort', effectiveEffort);

      if (perms.sandbox) {
        cliArgs.push('--sandbox');
      }

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      if (args.conversation_id) {
        cliArgs.push('--conversation', args.conversation_id);
      }

      cliArgs.push('-p', applyGuardrails(auditPrompt, buildSecurityRules(perms, { readOnly: true })));

      const timeoutMin = args.timeout_minutes || 25;
      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: timeoutMin
      });

      const resData = result.data || {};
      const conversationId = resData.conversation_id || args.conversation_id || '';
      const duration = resData.duration_seconds || 0;

      if (resData.usage) {
        recordUsage('audit', effectiveModel, effectiveEffort, conversationId, duration, resData.usage, !result.success, result.error || '');
      }

      if (!result.success) {
        let errText = `Error running adversarial audit with Antigravity:\n${result.error}`;
        if (conversationId) {
          errText += `\n\nSession Conversation ID: \`${conversationId}\` (you can resume this audit thread by passing this ID).`;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      const responseText = resData.response || result.rawOutput || '';

      let formatted = `### 🔍 Antigravity Adversarial Audit (${modeLabel})\n\n${responseText.trim()}\n\n---\n`;
      formatted += `Effort: \`${effectiveEffort}\``;
      if (effectiveModel) formatted += ` | Model: \`${effectiveModel}\``;
      formatted += ` | Mode: \`read-only\` | Timeout: \`${timeoutMin}m\``;
      formatted += `\nPermissions Enforced: ${formatPermissionSummary(perms)}`;
      if (conversationId) {
        formatted += `\nConversation ID: \`${conversationId}\` (pass as \`conversation_id\` to follow up on this audit)`;
      }

      return {
        content: [{ type: 'text', text: formatted }]
      };
    }

    case 'agy_review': {
      const reviewPrompt = `You are acting as an Adversarial Code Review Subagent.
Target to review:
${args.review_target}

${args.guidelines ? `Guidelines and Rules to verify:\n${args.guidelines}\n` : ''}
Review the code changes or files with high rigor and precision. Focus on high-impact findings:
1. Architectural integrity, contracts, and regressions
2. Security & privacy issues
3. Performance and edge cases
4. Accessibility (WCAG) and error handling
Provide specific findings with file paths, line numbers, issue descriptions, and concrete recommendations. Prioritize actionable findings over exhaustive repetition.`;

      const effectiveModel = args.model || config.defaultModel;
      const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: config.defaultEffort });
      const perms = resolvePermissions(args.permissions, config);

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan'
      ];
      if (effectiveEffort) cliArgs.push('--effort', effectiveEffort);

      if (perms.sandbox) {
        cliArgs.push('--sandbox');
      }

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      if (args.conversation_id) {
        cliArgs.push('--conversation', args.conversation_id);
      }

      cliArgs.push('-p', applyGuardrails(reviewPrompt, buildSecurityRules(perms, { readOnly: true })));

      const timeoutMin = args.timeout_minutes || config.defaultTimeoutMinutes || 20;
      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: timeoutMin
      });

      const resData = result.data || {};
      const conversationId = resData.conversation_id || args.conversation_id || '';
      const duration = resData.duration_seconds || 0;

      if (resData.usage) {
        recordUsage('review', effectiveModel, effectiveEffort, conversationId, duration, resData.usage, !result.success, result.error || '');
      }

      if (!result.success) {
        let errText = `Error reviewing with Antigravity:\n${result.error}`;
        if (conversationId) {
          errText += `\n\nSession Conversation ID: \`${conversationId}\` (you can resume this review thread by passing this ID).`;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      const responseText = resData.response || result.rawOutput || '';

      let formatted = `### Antigravity Code Review (Effort: ${effectiveEffort}${effectiveModel ? `, Model: ${effectiveModel}` : ''}, Mode: read-only)\n\n${responseText.trim()}\n\n---\n`;
      formatted += `Permissions Enforced: ${formatPermissionSummary(perms)}\n`;
      if (conversationId) {
        formatted += `Conversation ID: \`${conversationId}\` (pass as \`conversation_id\` to follow up on this review)`;
      }

      return {
        content: [{ type: 'text', text: formatted }]
      };
    }

    case 'agy_research': {
      const perms = resolvePermissions(args.permissions, config);

      // Research is meaningless without live search. Fail loudly instead of
      // letting agy answer from memory and pass it off as researched.
      if (!permits(perms, 'network')) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Cannot run web research: the "network" capability is not permitted by the current policy (${formatPermissionSummary(perms)}).\n\nRe-enable it with \`agy_set_config\` (include "network" in \`permissions.allow\` and remove it from \`permissions.deny\`), or pass \`permissions: { "allow": ["read", "network"], "deny": [] }\` for this call only.\n\nRefusing to produce a research report from the model's memory, since it would carry citations it never actually verified.`
          }]
        };
      }

      const researchPrompt = `You are acting as a Deep Web Research Subagent.

## Topic
${args.topic}
${args.recency ? `\n## Recency Requirement\nPrioritize sources from: ${args.recency}. Explicitly flag any source outside this window as potentially stale.\n` : ''}${args.project_context ? `\n## Project Context\n${args.project_context}\n` : ''}
Investigate this topic thoroughly using web search and any available research tools. Do not rely on memory: every factual claim must trace to a source you actually retrieved during this session.

Return a structured report with exactly these sections:

## Summary
A concise 2-3 sentence overview of the findings.

## Key Findings
Numbered list of the most important discoveries, facts, or insights.

## Sources
For each source used:
- [Title](URL) — brief description of what this source contributed

## Relevance to Current Project
If the research topic relates to the current codebase or project, explain how the findings apply and what actions could be taken. If it does not, say so plainly rather than inventing a connection.

Be thorough but concise. Prioritize primary sources and official documentation over blog posts. If searches return nothing usable on some sub-question, say so explicitly instead of filling the gap from memory.`;

      const effectiveModel = args.model || config.defaultModel;
      const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: config.defaultEffort });

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan'
      ];
      if (effectiveEffort) cliArgs.push('--effort', effectiveEffort);

      if (perms.sandbox) {
        cliArgs.push('--sandbox');
      }

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      if (args.conversation_id) {
        cliArgs.push('--conversation', args.conversation_id);
      }

      cliArgs.push('-p', applyGuardrails(researchPrompt, buildSecurityRules(perms, { readOnly: true })));

      const timeoutMin = args.timeout_minutes || 20;
      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: timeoutMin
      });

      const resData = result.data || {};
      const conversationId = resData.conversation_id || args.conversation_id || '';
      const duration = resData.duration_seconds || 0;

      if (resData.usage) {
        recordUsage('research', effectiveModel, effectiveEffort, conversationId, duration, resData.usage, !result.success, result.error || '');
      }

      if (!result.success) {
        let errText = `Error running web research with Antigravity:\n${result.error}`;
        if (conversationId) {
          errText += `\n\nSession Conversation ID: \`${conversationId}\` (you can resume this research thread by passing this ID).`;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      const responseText = resData.response || result.rawOutput || '';

      let formatted = `### 🌐 Antigravity Web Research\n\n${responseText.trim()}\n\n---\n`;
      formatted += `Effort: \`${effectiveEffort}\``;
      if (effectiveModel) formatted += ` | Model: \`${effectiveModel}\``;
      formatted += ` | Mode: \`read-only\` | Timeout: \`${timeoutMin}m\``;
      formatted += `\nPermissions Enforced: ${formatPermissionSummary(perms)}`;
      if (conversationId) {
        formatted += `\nConversation ID: \`${conversationId}\` (pass as \`conversation_id\` to ask follow-up questions without re-running the search)`;
      }

      return {
        content: [{ type: 'text', text: formatted }]
      };
    }

    case 'agy_session_summary': {
      const cwd = args.cwd || process.cwd();

      // 1. Discover the session log directory
      const logDir = getProjectLogDir(cwd);
      if (!logDir) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Could not find Claude Code session logs for project: ${cwd}\n\nExpected location: ~/.claude/projects/<encoded-project-path>/\nMake sure you're running this from within a project that has active Claude Code sessions.`
          }]
        };
      }

      // 2. Find the specific session file
      const sessionFile = findSessionFile(logDir, args.session_id);
      if (!sessionFile) {
        const hint = args.session_id
          ? `Session ID "${args.session_id}" not found in ${logDir}`
          : `No .jsonl session files found in ${logDir}`;
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Could not find session log file.\n${hint}\n\nAvailable sessions:\n${
              fs.readdirSync(logDir)
                .filter(f => f.endsWith('.jsonl'))
                .slice(0, 10)
                .map(f => `  - ${f.replace('.jsonl', '')}`)
                .join('\n') || '  (none)'
            }`
          }]
        };
      }

      // 3. Extract session ID from filename
      const sessionId = path.basename(sessionFile, '.jsonl');
      const fileSize = fs.statSync(sessionFile).size;

      process.stderr.write(`[antigravity-mcp] Session summary: processing ${sessionFile} (${(fileSize / 1024).toFixed(1)}KB)\n`);

      // 4. Pre-process the JSONL
      let processed;
      try {
        processed = preprocessSessionLog(sessionFile);
      } catch (err) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Error reading session log: ${err.message}\n\nFile: ${sessionFile} (${(fileSize / 1024).toFixed(1)}KB)`
          }]
        };
      }

      if (!processed.transcript || processed.totalTurns === 0) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Session log appears empty or contains no processable turns.\n\nFile: ${sessionFile}\nTotal lines parsed: ${processed.totalTurns}`
          }]
        };
      }

      process.stderr.write(`[antigravity-mcp] Pre-processed: ${processed.totalTurns} turns, ${(processed.transcript.length / 1024).toFixed(1)}KB transcript\n`);

      // 5. Build the summarization prompt
      const focus = args.focus || 'full';
      // Con narrate + personality, la voz se resuelve ANTES del prompt: el digest
      // sale en persona en esta misma llamada a agy, sin reescribirlo después.
      // Si falla, el resumen sigue sin persona y la narración informa el fallo.
      let destinoVoz = null;
      if (args.narrate && args.personality) {
        const d = await prepareNarrationTarget(args, config, { modoPorDefecto: 'diferido' });
        if (!d.error) destinoVoz = d;
      }
      const summarySystemPrompt = getSummaryPrompt(focus, Boolean(args.narrate), destinoVoz ? destinoVoz.profile : null);
      const keyPoints = Array.isArray(args.key_points)
        ? args.key_points.map(p => String(p).trim()).filter(Boolean)
        : [];
      const keyBlock = renderKeyPoints(keyPoints);
      const factsBlock = renderFacts(processed.facts);
      const finalBlock = renderFinalState(processed.finalState, processed.facts);
      const fullPrompt = `${summarySystemPrompt}\n\n---\n\n## Session Metadata\n- Project: ${processed.sessionMeta.cwd || cwd}\n- Branch: ${processed.sessionMeta.branch || 'unknown'}\n- Claude Version: ${processed.sessionMeta.version || 'unknown'}\n- Session Start: ${processed.sessionMeta.startTime || 'unknown'}\n- Session End: ${processed.sessionMeta.endTime || 'unknown'}\n- Total Turns: ${processed.totalTurns}\n- Log File Size: ${(fileSize / 1024).toFixed(1)}KB\n\n---\n\n${keyBlock ? `${keyBlock}

---

` : ''}${factsBlock ? `${factsBlock}\n\n---\n\n` : ''}${finalBlock ? `${finalBlock}\n\n---\n\n` : ''}## Session Transcript\n\n${processed.transcript}`;

      // 6. Delegate to agy for summarization
      //
      // Eleccion automatica de modelo. Hasta 0.7.2 esto era
      // `args.model || config.defaultModel`, sin mirar el tamano: una sesion de
      // 8,3 MB se resumio con Flash y el resultado perdio el hilo -- invento un
      // SHA de commit que no existe en el repositorio, presentado como dato.
      // El umbral ya estaba documentado en el comando y en el skill;
      // solo faltaba aplicarlo.
      //
      // Un `model` explicito siempre manda: esto solo decide cuando nadie eligio.
      const { model: effectiveModel, effort: effectiveEffort, nota: notaModelo } =
        elegirModeloResumen(args, config, fullPrompt.length);
      const perms = resolvePermissions(args.permissions, config);

      // Sin --output-format: lo fija executeAgyStdin en stream-json, y pasarlo
      // dos veces deja a agy con dos formatos de salida contradictorios.
      const cliArgs = [
        '--dangerously-skip-permissions',
        '--mode', 'plan'
      ];
      if (effectiveEffort) cliArgs.push('--effort', effectiveEffort);

      if (perms.sandbox) {
        cliArgs.push('--sandbox');
      }

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      // El prompt va por stdin, no como argumento. Con 400+ KB de transcripcion
      // el camino de `-p` obliga a volcar el prompt a un PROMPT.md y pasarle un
      // puntero, y eso convierte el trabajo en un paso que el modelo puede
      // saltear: medido, tres corridas dieron tres comportamientos distintos y
      // una devolvio "I'm ready for your next request". Ver agy-stream.js.
      const promptFinal = applyGuardrails(fullPrompt, buildSecurityRules(perms, { readOnly: true }));

      const timeoutMin = args.timeout_minutes || config.defaultTimeoutMinutes || 15;
      const result = await executeAgyStdin(AGY_BIN, promptFinal, cliArgs, {
        cwd,
        timeoutMinutes: timeoutMin,
        log: (m) => process.stderr.write(m),
        terminate: (child) => terminateTree(child)
      });

      const resData = result.data || {};
      const conversationId = resData.conversation_id || '';
      const duration = resData.duration_seconds || 0;

      if (resData.usage) {
        recordUsage('summary', effectiveModel, effectiveEffort, conversationId, duration, resData.usage, !result.success, result.error || '');
      }

      if (!result.success) {
        let errText = `Error generating session summary with Antigravity:\n${result.error}`;
        if (conversationId) {
          errText += `\n\nConversation ID: \`${conversationId}\``;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      // 7. Save the summary document
      let responseText = resData.response || result.rawOutput || '';
      let notaRecuperado = '';
      const recuperado = recuperarDocumentoEnlazado(responseText);
      if (recuperado) {
        process.stderr.write(`[antigravity-mcp] Response was a pointer; recovered document from ${recuperado.ruta}\n`);
        responseText = recuperado.contenido;
        notaRecuperado = recuperado.ruta;
      }
      // Nunca pisar un resumen bueno con una respuesta que no es un documento.
      const veredicto = validarDocumento(responseText);
      if (!veredicto.ok) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `El resumen NO se guardo: ${veredicto.motivo}.\n\n`
              + `Nada se sobrescribio, el archivo anterior de esta sesion sigue intacto.\n\n`
              + `Respuesta recibida de Antigravity:\n---\n${String(responseText).trim().slice(0, 1000)}\n---\n\n`
              + `Session: \`${sessionId}\` | Turns: ${processed.totalTurns} | Focus: \`${focus}\``
              + (conversationId ? ` | Conversation ID: \`${conversationId}\`` : '')
              + `\n\nEsto suele pasar cuando el prompt no cabe en un argumento y agy ignora el fichero PROMPT.md al que se le apunta. Reintentar suele bastar.`
          }]
        };
      }

      // El digest se separa ANTES de validar y guardar: el documento archivado
      // no debe llevar una seccion escrita para el oido.
      let digestHablado = null;
      if (args.narrate) {
        const partido = separarDigest(responseText);
        if (partido.digest) {
          responseText = partido.documento;
          digestHablado = partido.digest;
        } else {
          process.stderr.write('[antigravity-mcp] narrate: el modelo no emitio la seccion de digest\n');
        }
      }

      // Verificacion mecanica: siempre. No cuesta una llamada y no puede
      // inventar, porque compara contra los `facts` del log y contra git.
      const auditoria = auditarDocumento(responseText, {
        facts: processed.facts,
        shasReales: leerShasDelRepo(cwd),
        keyPoints,
        tagsReales: leerTagsDelRepo(cwd)
      });

      // Pase adversarial: solo con strict, y solo para lo que no se puede
      // comprobar mecanicamente. Se le pasan los hallazgos deterministas para
      // que no los repita.
      let revisionStrict = null;
      if (args.strict) {
        const promptRevision = getStrictReviewPrompt(responseText, auditoria)
          + `\n\n---\n\n## SESSION TRANSCRIPT\n\n${processed.transcript}`;
        const rev = await executeAgyStdin(AGY_BIN, applyGuardrails(promptRevision, buildSecurityRules(perms, { readOnly: true })), cliArgs, {
          cwd,
          timeoutMinutes: timeoutMin,
          log: (m) => process.stderr.write(m),
          terminate: (child) => terminateTree(child)
        });
        revisionStrict = rev.success
          ? ((rev.data && rev.data.response) || '').trim()
          : `(el pase de revision fallo: ${rev.error})`;
      }

      // El veredicto adversarial NO bloquea, y esto se midio: en la primera
      // prueba real devolvio RECHAZADO acusando al documento de inventar
      // `daemon.sh`, `bash -n`, systemd y loginctl. Los cuatro terminos estaban
      // en el transcript que el propio revisor recibio -- systemd 71 veces,
      // daemon.sh 62. La capa mecanica dijo "sin hallazgos" y acerto.
      //
      // El fallo es asimetrico y por eso importa: un resumidor que no atiende a
      // todo el material omite, un revisor que no atiende a todo acusa, y lo
      // hace con prosa convincente. Darle poder de bloqueo convierte un falso
      // positivo en trabajo perdido. Se reporta como opinion, etiquetada.
      if (args.strict && auditoria.bloqueantes > 0) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `El resumen NO se guardo: strict activo y la verificacion encontro problemas.\n\n`
              + `Nada se sobrescribio.\n\n${renderAuditoria(auditoria)}\n\n`
              + (revisionStrict ? `### Revision adversarial\n\n${revisionStrict}\n\n` : '')
              + `Session: \`${sessionId}\` | Focus: \`${focus}\`\n\n`
              + `El documento generado va debajo para que puedas juzgarlo:\n\n---\n\n${responseText.trim()}`
          }]
        };
      }

      let savedPath;
      try {
        savedPath = saveSummary(responseText, sessionId, processed.sessionMeta, args.output_path, cwd);
      } catch (err) {
        // Summary generated but couldn't save — still return it
        return {
          content: [{
            type: 'text',
            text: `### 📋 Session Summary\n\n${responseText.trim()}\n\n---\n⚠️ Could not save summary file: ${err.message}\n\nSession: \`${sessionId}\` | Turns: ${processed.totalTurns} | Focus: ${focus}`
          }]
        };
      }

      // 8. Return the summary
      let formatted = `### 📋 Session Summary\n\n${responseText.trim()}\n\n---\n`;
      formatted += `**Summary Details:**\n`;
      formatted += `- Session: \`${sessionId}\`\n`;
      formatted += `- Source: \`${sessionFile}\` (${(fileSize / 1024).toFixed(1)}KB)\n`;
      formatted += `- Turns Processed: ${processed.totalTurns}\n`;
      formatted += `- Focus: \`${focus}\`\n`;
      formatted += `- Saved to: \`${savedPath}\`\n`;
      if (notaRecuperado) formatted += `- Recovered: la respuesta era un enlace; se guardo el documento leido de \`${notaRecuperado}\`\n`;
      formatted += `- Strict: ${args.strict ? 'si' : 'no (solo verificacion mecanica)'}\n`;

      // Narracion al final: el documento ya esta guardado, asi que un fallo de
      // voz no puede costar el resumen. Es el mismo canje que hace agy_say al
      // narrar el texto original cuando el pulido falla.
      if (args.narrate) {
        if (!digestHablado) {
          formatted += `- Narracion: no se emitio (el modelo no incluyo la seccion \`${MARCA_DIGEST}\`; el documento se guardo igual)\n`;
        } else {
          // Diferido por defecto: el resumen se narra cuando termina, nadie lo espera en vivo.
          const destino = destinoVoz || await prepareNarrationTarget(args, config, { modoPorDefecto: 'diferido' });
          if (destino.error) {
            formatted += `- Narracion: fallo la preparacion de voz; el digest va abajo en texto\n`;
          } else {
            const { text: textoHablado } = normalizeSpokenText(digestHablado);
            const emision = await emitNarration({
              spokenText: textoHablado,
              voiceboxUrl: destino.voiceboxUrl,
              profile: destino.profile,
              language: destino.language,
              localPlayback: args.local_playback !== false,
              sendTelegram: args.send_telegram !== false,
              ...camposEmision(destino)
            });
            formatted += `- Narracion: ${emision && emision.ok === false ? `fallo (${emision.error || 'sin detalle'})` : (destinoVoz ? 'emitida, con el digest escrito en personaje' : 'emitida')}\n`;
          }
          formatted += `\n**Digest hablado:** ${digestHablado}\n`;
        }
      }
      if (effectiveModel) formatted += `- Model: \`${effectiveModel}\`\n`;
      formatted += `- Effort: \`${effectiveEffort}\`\n`;
      if (notaModelo) formatted += `- Model choice: ${notaModelo}\n`;
      formatted += `- Duration: ${duration ? `${duration.toFixed(1)}s` : 'unknown'}\n`;
      if (conversationId) {
        formatted += `- Conversation ID: \`${conversationId}\`\n`;
      }
      formatted += `\n${renderAuditoria(auditoria)}\n`;
      if (revisionStrict) {
        formatted += `\n### Revision adversarial (orientativa, NO bloqueante)\n\n`
          + `Un segundo modelo releyo el transcript buscando afirmaciones sin respaldo. Sus hallazgos son pistas, no veredictos: en pruebas devolvio RECHAZADO acusando de inventar terminos que aparecian decenas de veces en el material que el mismo recibio. Verifica cada punto antes de actuar.\n\n${revisionStrict}\n`;
      }

      return {
        content: [{ type: 'text', text: formatted }]
      };
    }

    case 'agy_narrate': {
      const cwd = args.cwd || process.cwd();

      // 1-3. Voicebox, perfiles y resolucion de voz (comun con agy_say)
      const destino = await prepareNarrationTarget(args, config);
      if (destino.error) return destino.error;
      const { voiceboxUrl, voiceResolution, profile: chosenProfile, language: targetLang } = destino;

      // 4. Locate session log & extract last checkpoint
      const logDir = getProjectLogDir(cwd);
      let sessionFile = null;
      if (logDir) {
        sessionFile = findSessionFile(logDir, args.session_id);
      }

      let checkpoint = {
        userGoal: 'Tarea de desarrollo completada',
        filesModified: [],
        commandsCount: 0,
        testExecutions: [],
        overallTestStatus: 'NO_TESTS',
        assistantNotes: '',
        turnsBack: 0
      };

      if (sessionFile) {
        try {
          checkpoint = extractLastCheckpoint(sessionFile);
        } catch (err) {
          process.stderr.write(`[antigravity-mcp] Error extracting checkpoint: ${err.message}\n`);
        }
      }

      // 5. Generate conversational spoken narration script via agy (Gemini)
      const enablePersonality = Boolean(args.personality);
      const narratePrompt = getNarrationPrompt(checkpoint, targetLang, chosenProfile, enablePersonality);
      const effectiveModel = args.model || config.defaultModel;
      // `low` por latencia, pero solo si el modelo lo admite (BE-015).
      const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: 'low' });

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan'
      ];
      if (effectiveEffort) cliArgs.push('--effort', effectiveEffort);

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      cliArgs.push('-p', narratePrompt);

      const agyRes = await executeAgy(cliArgs, {
        cwd,
        timeoutMinutes: 3
      });

      const resData = agyRes.data || {};
      const conversationId = resData.conversation_id || '';
      const duration = resData.duration_seconds || 0;

      if (resData.usage) {
        recordUsage('narrate', effectiveModel, effectiveEffort, conversationId, duration, resData.usage, !agyRes.success, agyRes.error || '');
      }

      if (!agyRes.success) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Error generando el guión de narración con Antigravity:\n${agyRes.error}`
          }]
        };
      }

      // El guion lo escribe un modelo con acceso al repo: pasa por el mismo
      // saneado que el texto libre de agy_say, redaccion de secretos incluida.
      let spokenText = normalizeSpokenText(resData.response || agyRes.rawOutput || '').text;
      // El guion con persona lo escribe Gemini; si no devolvió nada, se narra
      // el texto de respaldo, que es neutro.
      const personaAplicada = enablePersonality && Boolean(spokenText);

      if (!spokenText) {
        spokenText = targetLang === 'en'
          ? 'The latest task has completed successfully.'
          : 'La última tarea se ha completado exitosamente.';
      }

      // Emision compartida con agy_say: Voicebox, altavoces, Telegram, limpieza.
      const playLocally = Boolean(args.local_playback);
      const emision = await emitNarration({
        spokenText,
        voiceboxUrl,
        profile: chosenProfile,
        language: targetLang,
        localPlayback: playLocally,
        sendTelegram: args.send_telegram !== false,
        ...camposEmision(destino)
      });

      if (!emision.ok) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ **Guión generado pero falló la generación en Voicebox:**\n\n"${spokenText}"\n\nError: ${emision.error}`
          }]
        };
      }

      // 7. Salida estructurada. La cabecera comun la genera formatNarrationOutput;
      // el contexto del checkpoint es lo unico propio de esta herramienta.
      let out = `### 🎙️ Narración de Voz Emitida (Voicebox)\n\n`;
      out += formatNarrationOutput({
        spokenText,
        profile: chosenProfile,
        language: targetLang,
        personality: enablePersonality,
        localPlayback: playLocally,
        emision,
        voiceboxUrl,
        voiceResolution,
        destino,
        personaAplicada
      });
      out += `\n**Contexto del Checkpoint detectado:**\n`;
      out += `- **Objetivo**: ${checkpoint.userGoal.slice(0, 150)}${checkpoint.userGoal.length > 150 ? '...' : ''}\n`;
      // Se informa el retroceso: si la petición de narrar no contenía trabajo,
      // la ventana se abrió en un turno anterior, y saber CUÁL se narró es la
      // diferencia entre confiar en el resumen y tener que deducirlo.
      if (checkpoint.turnsBack > 0) {
        out += `- **Ventana**: ${checkpoint.turnsBack} turno(s) atrás (la petición de narrar no contenía trabajo)\n`;
      }
      out += `- **Estado de Tests**: \`${checkpoint.overallTestStatus}\``;
      out += (checkpoint.testExecutions || []).length > 0
        ? ` (${checkpoint.testExecutions.length} ejecución(es) detectada(s))\n`
        : '\n';
      out += `- **Comandos ejecutados**: ${checkpoint.commandsCount}\n`;
      if (checkpoint.filesModified.length > 0) {
        out += `- **Archivos identificados**: ${checkpoint.filesModified.map(f => `\`${path.basename(f)}\``).slice(0, 5).join(', ')}${checkpoint.filesModified.length > 5 ? ` (+${checkpoint.filesModified.length - 5} más)` : ''}\n`;
      }
      if (duration) {
        out += `- **Tiempo de generación (Gemini)**: ${duration.toFixed(1)}s\n`;
      }

      return {
        content: [{ type: 'text', text: out }]
      };
    }

    case 'agy_say': {
      const rawText = typeof args.text === 'string' ? args.text : '';
      if (!rawText.trim()) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'agy_say requiere el parámetro `text` con el contenido a narrar.' }]
        };
      }

      const destino = await prepareNarrationTarget(args, config);
      if (destino.error) return destino.error;
      const { voiceboxUrl, voiceResolution, profile: chosenProfile, language: targetLang } = destino;

      const enablePersonality = Boolean(args.personality);
      let polishDuration = 0;
      let polishApplied = false;
      let textoBase = rawText;

      // El pulido es OPCIONAL y va antes del saneado. Es lo unico de esta
      // herramienta que justifica una llamada a agy: reescribir en estilo
      // hablado es tarea de lenguaje. Quitar markdown o redactar secretos no lo
      // es, y mandarlos a un modelo solo anadiria latencia sin ganar nada —el
      // llamante YA tiene el texto, que es la premisa de agy_say.
      if (args.polish) {
        const effectiveModel = args.model || config.defaultModel;
        const effectiveEffort = esfuerzoParaCli({ modelo: effectiveModel, pedido: args.effort, porDefecto: 'low' });
        const cliArgs = [
          '--output-format', 'json',
          '--dangerously-skip-permissions',
          '--mode', 'plan'
        ];
        if (effectiveEffort) cliArgs.push('--effort', effectiveEffort);
        if (effectiveModel) cliArgs.push('--model', effectiveModel);
        cliArgs.push('-p', getPolishPrompt(rawText, targetLang, chosenProfile, enablePersonality));

        const agyRes = await executeAgy(cliArgs, { cwd: args.cwd || process.cwd(), timeoutMinutes: 3 });
        const resData = agyRes.data || {};
        polishDuration = resData.duration_seconds || 0;

        if (resData.usage) {
          recordUsage('say', effectiveModel, effectiveEffort, resData.conversation_id || '', polishDuration, resData.usage, !agyRes.success, agyRes.error || '');
        }

        if (agyRes.success && (resData.response || agyRes.rawOutput)) {
          textoBase = resData.response || agyRes.rawOutput;
          polishApplied = true;
        } else {
          // Que falle el pulido no debe impedir hablar: se narra el original.
          // Perder el mensaje por no poder embellecerlo seria el peor canje.
          process.stderr.write(`[antigravity-mcp] Polish falló, se narra el texto original: ${agyRes.error || 'sin respuesta'}\n`);
        }
      }

      // personality sin polish: agy reescribe en persona (con polish, el prompt
      // de pulido ya la incluye). Antes lo hacía el LLM de Voicebox.
      let personaAplicada = enablePersonality && polishApplied;
      let personaDuracion = 0;
      if (enablePersonality && !args.polish) {
        const r = await reescribirEnPersona({ texto: rawText, destino, args, config });
        if (r.aplicado) {
          textoBase = r.texto;
          personaAplicada = true;
          personaDuracion = r.duracion;
        }
      }

      const { text: spokenText, truncated, originalLength } = normalizeSpokenText(textoBase);

      if (!spokenText) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: 'Tras sanear el texto no quedó nada que narrar. Probablemente era solo código, enlaces o emoji, que no se leen en voz alta.'
          }]
        };
      }

      const playLocally = Boolean(args.local_playback);
      const emision = await emitNarration({
        spokenText,
        voiceboxUrl,
        profile: chosenProfile,
        language: targetLang,
        localPlayback: playLocally,
        sendTelegram: args.send_telegram !== false,
        ...camposEmision(destino)
      });

      if (!emision.ok) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ **Falló la generación en Voicebox:**\n\n"${spokenText}"\n\nError: ${emision.error}`
          }]
        };
      }

      let out = `### 🗣️ Texto Narrado (Voicebox)\n\n`;
      out += formatNarrationOutput({
        spokenText,
        profile: chosenProfile,
        language: targetLang,
        personality: enablePersonality,
        localPlayback: playLocally,
        emision,
        voiceboxUrl,
        voiceResolution,
        destino,
        personaAplicada
      });
      let origen = '📝 Texto del llamante, saneado localmente';
      if (polishApplied) origen = `✨ Pulido por agy (${polishDuration.toFixed(1)}s)`;
      else if (personaAplicada) origen = `🎭 Reescrito en personaje por agy (${personaDuracion.toFixed(1)}s)`;
      out += `- **Origen del guión**: ${origen}\n`;
      if (truncated) {
        out += `- **⚠️ Truncado**: el texto tenía ${originalLength} caracteres y se cortó en ${spokenText.length}. Usa \`polish: true\` para condensarlo en vez de recortarlo.\n`;
      } else if (!polishApplied && originalLength > POLISH_SUGGESTED_OVER) {
        out += `- **Sugerencia**: con ${originalLength} caracteres, \`polish: true\` daría una narración más escuchable.\n`;
      }

      return {
        content: [{ type: 'text', text: out }]
      };
    }

    case 'agy_voice_model': {
      const voiceboxUrl = resolveVoiceboxUrl(args, config);
      const responder = (texto, isError = false) => ({
        ...(isError ? { isError: true } : {}),
        content: [{ type: 'text', text: texto }]
      });
      const action = args.action;

      if (action === 'status') return responder(await describirEstadoVoicebox(voiceboxUrl, config));

      if (action === 'release') {
        const pin = vb.leerPin();
        vb.escribirPin(null);
        return responder(pin
          ? `Pin liberado (\`${pin.model}\`). Se descarga tras ${config.voiceboxIdleUnloadMinutes} min sin uso.`
          : 'No había ningún modelo fijado.');
      }

      if (!['start', 'activate', 'pin', 'unload'].includes(action)) {
        return responder(`Acción desconocida: \`${action}\`.`, true);
      }

      const esOmni = args.engine === vb.MODELO_OMNI;
      const urlO = om.urlOmni(config);

      if (action === 'unload') {
        // Primero OmniVoice (el server es nuestro, siempre se puede); después
        // Voicebox, solo si lo levantó el plugin o con force.
        const liberados = [];
        const pinPrevio = vb.leerPin();
        if (om.omniInstalado({ config })) {
          const eo = await vb.estadoOmniServidor(urlO);
          if (eo.models.some(m => m.loaded)) {
            try {
              await vb.descargarOmniServidor(urlO);
              liberados.push(`\`${vb.MODELO_OMNI}\` (${vb.SIZE_MB_OMNI} MB)`);
            } catch (err) {
              process.stderr.write(`[antigravity-mcp] unload de omnivoice falló: ${err.message}\n`);
            }
          }
        }
        if (esOmni) {
          if (pinPrevio && pinPrevio.model === vb.MODELO_OMNI) vb.escribirPin(null);
          return responder(liberados.length ? `🗑️ Descargado: ${liberados.join(', ')}.` : 'OmniVoice no tenía el modelo cargado.');
        }
        const vbArriba = (await vb.salud(voiceboxUrl)).ok;
        const k = vb.leerKeeper();
        if (vbArriba && !(k && k.vivo && k.ownsServer) && !args.force) {
          const aviso = 'Este Voicebox no lo levantó el plugin (probablemente la GUI): no descargo sus modelos. Pasá `force: true` para hacerlo igual.';
          return liberados.length ? responder(`🗑️ Descargado: ${liberados.join(', ')}.\n\n${aviso}`) : responder(aviso, true);
        }
        vb.escribirPin(null);
        const tts = vbArriba ? (await vb.estadoModelos(voiceboxUrl)).filter(m => m.loaded && vb.esModeloTts(m.model_name)) : [];
        for (const m of tts) {
          try {
            await vb.descargarModelo(voiceboxUrl, m.model_name);
            liberados.push(`\`${m.model_name}\`${m.size_mb ? ` (${Math.round(m.size_mb)} MB)` : ''}`);
          } catch (err) {
            process.stderr.write(`[antigravity-mcp] unload de ${m.model_name} falló: ${err.message}\n`);
          }
        }
        return responder(liberados.length ? `🗑️ Descargados: ${liberados.join(', ')}. Pin liberado.` : 'No había modelos TTS cargados. Pin liberado.');
      }

      // OmniVoice (segundo proveedor): start/activate/pin con engine "omnivoice".
      if (esOmni) {
        if (!om.omniInstalado({ config })) return responder('OmniVoice no está instalado: `npm run omnivoice:install`.', true);
        const s = await om.ensureOmniVoice(urlO, { config });
        if (!s.ok) return responder(`⚠️ ${s.error}`, true);
        if (action === 'start') return responder(s.started ? `✅ OmniVoice levantado en \`${urlO}\`.` : `✅ OmniVoice ya estaba corriendo en \`${urlO}\`.`);
        const vbArriba = (await vb.salud(voiceboxUrl)).ok;
        const r = await vb.aplicarModeloActivo(servidoresVoz(vbArriba ? voiceboxUrl : null, config), {
          proveedor: vb.MODELO_OMNI,
          engine: vb.MODELO_OMNI,
          voz: args.voice || null,
          fijar: action === 'pin'
        });
        if (!r.ok) return responder(`⚠️ ${r.error}`, true);
        return responder(formatearActivacion(r, action, args.voice ? ` (voz ${args.voice})` : ''));
      }

      const health = await vb.ensureVoicebox(voiceboxUrl, { config });
      if (!health.ok) return responder(`⚠️ **Voicebox no está disponible en \`${voiceboxUrl}\`**\n\n${health.error}`, true);

      if (action === 'start') {
        let out = health.started
          ? `✅ Voicebox levantado sin GUI (${health.variante}, \`${health.exe}\`).`
          : `✅ Voicebox ya estaba corriendo en \`${voiceboxUrl}\`.`;
        if (health.aviso) out += `\n\n⚠️ ${health.aviso}`;
        return responder(out);
      }

      // activate / pin
      let perfil = null;
      if (args.voice) {
        try {
          perfil = resolveVoiceProfile(await getVoiceboxProfiles(voiceboxUrl), args.voice, args.language).profile;
        } catch (err) {
          return responder(`⚠️ ${err.message}`, true);
        }
      }
      if (!perfil && !args.engine) return responder('Indicá `voice` o `engine` (y opcionalmente `model_size`).', true);

      const mapa = {};
      for (const m of await vb.estadoModelos(voiceboxUrl)) mapa[m.model_name] = m;
      const motor = vb.resolverMotor(perfil || {}, mapa, args.engine || null, args.model_size || null);
      const r = await vb.aplicarModeloActivo(servidoresVoz(voiceboxUrl, config), { ...motor, voz: perfil ? perfil.name : null, fijar: action === 'pin' });
      if (!r.ok) return responder(`⚠️ ${r.error}`, true);
      return responder(formatearActivacion(r, action, perfil ? ` (voz ${perfil.name})` : ''));
    }

    case 'telegram_bridge_status': {
      const bridgeDir = path.join(__dirname, '..', 'telegram-bridge');

      // Import dinamico de un modulo ESM desde este servidor CommonJS. Se
      // prefiere a duplicar la resolucion de rutas: si las dos copias
      // discreparan, esta herramienta mentiria precisamente sobre lo que existe
      // para detectar discrepancias.
      let rutas;
      try {
        const { pathToFileURL } = require('node:url');
        rutas = await import(pathToFileURL(path.join(bridgeDir, 'paths.js')).href);
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `No se pudo cargar telegram-bridge/paths.js: ${err.message}` }]
        };
      }

      const dataDir = rutas.bridgeDataDirPath();
      const stateFile = path.join(dataDir, 'state.json');
      const lockFile = path.join(dataDir, 'bridge.lock');

      // De donde saldria el bot si lo arrancara la tarea programada. Es LA
      // comparacion que importa: el daemon guarda una ruta absoluta y puede
      // apuntar a una copia distinta de la que sirve estas herramientas.
      let daemonDir = null;
      let daemonTaskState = null;
      let gestorServicios = null;

      if (process.platform === 'win32') {
        gestorServicios = 'Task Scheduler';
        try {
          const ps = execFileSync('powershell', [
            '-NoProfile', '-Command',
            "$t = Get-ScheduledTask -TaskName 'AntigravityTelegramBridge' -ErrorAction SilentlyContinue; " +
            "if ($t) { \"$($t.State)`n$($t.Actions.Arguments)\" }"
          ], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
          if (ps) {
            const [estado, args] = ps.split(/\r?\n/);
            daemonTaskState = estado || null;
            const m = (args || '').match(/"?([A-Za-z]:[\\/][^"]*?)[\\/]daemon-hidden\.vbs"?/i)
              || (args || '').match(/"?([A-Za-z]:[\\/][^"]*?)[\\/]bot\.js"?/i);
            if (m) daemonDir = m[1];
          }
        } catch {}
      } else if (process.platform === 'linux') {
        gestorServicios = 'systemd --user';
        try {
          // `WorkingDirectory` es la ruta que daemon.sh escribe en la unidad, y
          // es la que interesa: revela desde que copia del bridge se registro.
          const out = execFileSync('systemctl', [
            '--user', 'show', 'lagrange-telegram-bridge.service',
            '-p', 'ActiveState', '-p', 'WorkingDirectory', '-p', 'LoadState'
          ], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] });
          const campos = Object.fromEntries(
            out.trim().split(/\r?\n/).map(l => {
              const i = l.indexOf('=');
              return i === -1 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)];
            })
          );
          if (campos.LoadState && campos.LoadState !== 'not-found') {
            daemonTaskState = campos.ActiveState || null;
            if (campos.WorkingDirectory) daemonDir = campos.WorkingDirectory;
          }
        } catch {}
      }

      // El mismo criterio con el que `telegram_ask` decide si puede preguntar
      // (paths.js): si divergieran, status diría «vivo» y el ask se negaría.
      const daemon = rutas.estadoDaemon({ dataDir });
      const botVivo = daemon.vivo;
      const lock = daemon.pid !== null ? { pid: daemon.pid, startedAt: daemon.startedAt } : null;

      let stateInfo = null;
      try {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        stateInfo = {
          chats: Object.keys(s.chats || {}).length,
          asksPendientes: Object.values(s.pendingAsks || {}).filter(a => a.status === 'pending').length
        };
      } catch {}

      const envCandidatos = rutas.bridgeEnvCandidates(bridgeDir);
      const envActivo = envCandidatos.find(f => fs.existsSync(f)) || null;
      const envDuradero = path.join(dataDir, '.env');

      // El .env que usaria el DAEMON, que puede salir de otra copia del codigo
      // y por tanto de otro fichero. Es el mismo desfase que se arreglo para
      // state.json, pero en credenciales, y no se ve desde ningun lado: cada
      // mitad lee el suyo y ninguna sabe de la otra.
      let envDaemon = null;
      if (daemonDir) {
        try {
          envDaemon = rutas.bridgeEnvCandidates(daemonDir).find(f => fs.existsSync(f)) || null;
        } catch {}
      }
      const norm2 = (p) => p ? path.resolve(p).replace(/\\/g, '/').toLowerCase() : null;
      const envDistinto = envDaemon && envActivo && norm2(envDaemon) !== norm2(envActivo);
      let envIguales = null;
      if (envDistinto) {
        // Se comparan los BYTES, nunca el contenido: si son copias identicas la
        // division es inofensiva, y si difieren hay que decirlo sin revelar nada.
        try {
          envIguales = fs.readFileSync(envDaemon).equals(fs.readFileSync(envActivo));
        } catch { envIguales = null; }
      }

      const norm = (p) => p ? path.resolve(p).replace(/\\/g, '/').toLowerCase() : null;
      const mismaCopia = daemonDir ? norm(daemonDir) === norm(bridgeDir) : null;
      const enCopiaGestionada = /(\.claude|claude)\/plugins\/(cache|marketplaces)\//i.test(norm(bridgeDir) || '');

      let out = '### 🌉 Estado del Telegram Bridge\n\n';

      out += '**Daemon**\n';
      if (daemonTaskState) {
        out += `- Servicio (${gestorServicios}): \`${daemonTaskState}\`\n`;
        out += `- Bot en ejecución: ${botVivo ? `✅ PID ${lock.pid} (desde ${lock.startedAt || 'desconocido'})` : '❌ no hay proceso vivo'}\n`;
      } else if (gestorServicios) {
        out += `- Servicio (${gestorServicios}): _no registrado_ (\`npm run bridge:daemon:install\` desde un clon)\n`;
        if (botVivo) {
          out += `- Bot en ejecución: ✅ PID ${lock.pid} — arrancado a mano, no por el gestor de servicios\n`;
        }
      } else {
        // macOS y cualquier otra: el bridge funciona, solo que sin daemon.
        out += `- Servicio: _no hay gestor soportado en ${process.platform}_ (arráncalo con \`npm run bridge\`)\n`;
        out += `- Bot en ejecución: ${botVivo ? `✅ PID ${lock.pid} (desde ${lock.startedAt || 'desconocido'})` : '❌ no hay proceso vivo'}\n`;
      }

      out += '\n**Qué código corre cada mitad**\n';
      out += `- Herramientas MCP: \`${bridgeDir}\`${enCopiaGestionada ? ' _(copia gestionada del plugin)_' : ''}\n`;
      out += `- Daemon del bot: ${daemonDir ? `\`${daemonDir}\`` : '_desconocido_'}\n`;
      if (mismaCopia === true) {
        out += '- ✅ Ambas mitades corren la misma copia.\n';
      } else if (mismaCopia === false) {
        out += '- ⚠️ **Corren copias distintas.** El estado y las credenciales se comparten, así que\n';
        out += '  el human-in-the-loop funciona igual; pero un cambio de código solo lo verá la mitad\n';
        out += '  que lo tenga. Si algo no se comporta como esperas tras editar o actualizar, es aquí.\n';
      }

      out += '\n**Credenciales (.env)**\n';
      out += envActivo ? `- Herramientas MCP usan: \`${envActivo}\`\n` : '- ⚠️ No se encontró ningún `.env` para las herramientas MCP.\n';
      if (envDaemon) out += `- Daemon del bot usa: \`${envDaemon}\`\n`;

      if (envDistinto) {
        out += '- ⚠️ **Cada mitad lee un `.env` distinto.**';
        if (envIguales === true) {
          out += ' Ahora mismo son idénticos, así que no hay síntoma —\n';
          out += '  pero editar uno solo los desincroniza sin que nada lo avise.\n';
        } else if (envIguales === false) {
          out += ' **Y su contenido NO coincide.**\n';
          out += '  Si difieren en el token o en `ALLOWED_USER_IDS`, el bot y las notificaciones\n';
          out += '  actúan como dos bots distintos. Borra el que sobre y deja solo el duradero.\n';
        } else {
          out += ' No se pudo comparar su contenido.\n';
        }
        out += `  El duradero, que ambas mitades comparten, es: \`${envDuradero}\`\n`;
      } else if (envActivo && path.resolve(envActivo) !== path.resolve(envDuradero)) {
        out += `- ℹ️ Ubicación duradera recomendada: \`${envDuradero}\`\n`;
        out += '  (un `.env` dentro del directorio de una versión se pierde en el próximo `claude plugin update`)\n';
      } else if (envActivo) {
        out += '- ✅ En la ubicación duradera: sobrevive a `claude plugin update`.\n';
      }

      out += '\n**Estado compartido**\n';
      out += `- Directorio de datos: \`${dataDir}\`\n`;
      out += `- \`state.json\`: ${stateInfo ? `✅ ${stateInfo.chats} chat(s), ${stateInfo.asksPendientes} ask(s) pendiente(s)` : '_todavía no existe_'}\n`;
      out += `- \`bridge.lock\`: ${lock ? `PID ${lock.pid}` : '_ninguno_'}\n`;
      out += '- Ambas copias resuelven aquí, que es lo que permite responder desde el móvil\n';
      out += '  un `telegram_ask` registrado por la otra.\n';

      return { content: [{ type: 'text', text: out }] };
    }

    case 'agy_narrate_voices': {
      const voiceboxUrl = resolveVoiceboxUrl(args, config);

      // 1. Voicebox arriba (se levanta sin GUI si hace falta)
      const health = await vb.ensureVoicebox(voiceboxUrl, { config });
      if (!health.ok) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ **Voicebox no está disponible en \`${voiceboxUrl}\`**\n\n${health.error}`
          }]
        };
      }

      // 2. Fetch available profiles
      let profiles = [];
      try {
        profiles = await getVoiceboxProfiles(voiceboxUrl);
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ Error al consultar los perfiles de voz de Voicebox: ${err.message}`
          }]
        };
      }

      // 3. Filter if requested
      const langFilter = (args.language || 'all').toLowerCase();
      const filtered = langFilter === 'all'
        ? profiles
        : profiles.filter(p => (p.language || '').toLowerCase().startsWith(langFilter));

      // 4. Role tagger helper
      function getRoleTag(name, lang) {
        const n = (name || '').toLowerCase();
        const l = (lang || '').toLowerCase();
        if (n.includes('diego')) return '⭐ **Default Español**';
        if (n.includes('emily')) return '⭐ **Default English**';
        if (n.includes('isabel')) return '🔄 Fallback Español (P1)';
        if (n.includes('anna') || n.includes('ono')) return '🔄 Fallback Español (P2)';
        if (n.includes('aria')) return '🔄 Fallback English (P1)';
        if (n.includes('aiden')) return '🔄 Fallback English (P2)';
        if (l.startsWith('es')) return 'Disponible (es)';
        if (l.startsWith('en')) return 'Disponible (en)';
        return 'Disponible';
      }

      // 5. Build presentation
      const hInfo = health.info || {};
      let out = `### 🎙️ Perfiles de Voz en Voicebox\n\n`;
      out += `**Estado del servicio:**\n`;
      out += `- **Endpoint**: \`${voiceboxUrl}\`\n`;
      if (hInfo.gpu_type) out += `- **Aceleración**: \`${hInfo.gpu_type}\` (${hInfo.backend_variant || 'cuda'})\n`;
      if (hInfo.model_size) out += `- **Modelo TTS**: \`${hInfo.model_size}\` (${hInfo.model_loaded ? 'Cargado en memoria' : 'Descargado'})\n`;
      out += `- **Total de perfiles instalados**: ${profiles.length}${langFilter !== 'all' ? ` (${filtered.length} mostrando filtro: \`${langFilter}\`)` : ''}\n\n`;

      out += `| Perfil | Idioma | Tipo | Rol en Antigravity | Personalidad |\n`;
      out += `|---|---|---|---|---|\n`;

      for (const p of filtered) {
        const role = getRoleTag(p.name, p.language);
        const pers = p.personality ? '✅ Sí' : '—';
        out += `| **${p.name}** | \`${p.language || '?'}\` | ${p.voice_type || 'cloned'} | ${role} | ${pers} |\n`;
      }

      out += `\n> **Cómo usar una voz específica:**\n`;
      out += `> - Comando: \`/lagrange:narrate <nombre>\` (ej: \`/lagrange:narrate aria\` o \`/lagrange:narrate "Mi voz"\`)\n`;
      out += `> - Con Claude: *"Narra el último checkpoint con [nombre de voz]"*\n`;

      return {
        content: [{ type: 'text', text: out }]
      };
    }

    case 'telegram_notify': {
      const res = await invokeTelegramBridge('--notify-json', {
        title: args.title,
        message: args.message,
        level: args.level || 'info',
        filePath: args.file_path
      });

      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to send Telegram notification: ${res.error}` }]
        };
      }

      return {
        content: [{ type: 'text', text: `✅ Notification successfully delivered to your mobile Telegram app.` }]
      };
    }

    case 'telegram_ask': {
      const res = await invokeTelegramBridge('--ask-json', {
        question: args.question,
        options: args.options || ['Aprobar', 'Rechazar'],
        timeoutSeconds: args.timeout_seconds || 300
      });

      if (!res.ok || !res.answered) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Telegram ask error or timeout: ${res.error || 'No answer received within time limit'}` }]
        };
      }

      return {
        content: [{
          type: 'text',
          text: `User responded from mobile Telegram app:\n- Selected Choice: "${res.selected}"\n- Answered By ID: ${res.answeredBy || 'Authorized User'}`
        }]
      };
    }

    case 'telegram_send_voice': {
      const res = await invokeTelegramBridge('--voice-json', {
        audioPath: args.audio_path,
        caption: args.caption || '🎙️ Nota de voz de Voicebox'
      });

      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to send voice note to Telegram: ${res.error}` }]
        };
      }

      return {
        content: [{ type: 'text', text: `✅ Voice note delivered to your mobile Telegram app.` }]
      };
    }

    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }]
      };
  }
}

// JSON-RPC stdio Handler
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    sendResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` }
    });
    return;
  }

  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      process.stderr.write('[antigravity-mcp] Client initialized notification received\n');
    }
    return;
  }

  try {
    switch (method) {
      case 'initialize': {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: 'antigravity-mcp',
              version: '1.5.0'
            }
          }
        });
        break;
      }

      case 'ping': {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {}
        });
        break;
      }

      case 'tools/list': {
        sendResponse({
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS
          }
        });
        break;
      }

      case 'tools/call': {
        const { name, arguments: toolArgs } = params || {};
        process.stderr.write(`[antigravity-mcp] Call tool: ${name}\n`);
        const result = await handleToolCall(name, toolArgs || {});
        sendResponse({
          jsonrpc: '2.0',
          id,
          result
        });
        break;
      }

      default: {
        sendResponse({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        });
        break;
      }
    }
  } catch (err) {
    process.stderr.write(`[antigravity-mcp] Error handling ${method}: ${err.stack}\n`);
    sendResponse({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: `Internal error: ${err.message}`
      }
    });
  }
});

process.stderr.write(`[antigravity-mcp] Server started, binary: ${AGY_BIN}\n`);
