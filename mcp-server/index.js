#!/usr/bin/env node

/**
 * Antigravity MCP Server for Claude Code
 * Bridges Claude Code / Claude CLI to the Antigravity CLI (`agy.exe`).
 * Implements MCP stdio JSON-RPC 2.0 protocol with zero external dependencies.
 * Includes granular ALLOW / DENY permissions, robust timeout handling, and telemetry / usage metrics.
 */

const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

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
    defaultEffort: process.env.AGY_EFFORT || 'high',
    defaultTimeoutMinutes: parseInt(process.env.AGY_TIMEOUT_MINUTES, 10) || 15,
    voiceboxUrl: process.env.VOICEBOX_URL || null,
    voiceboxPort: parseInt(process.env.VOICEBOX_PORT, 10) || null,
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
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
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
      if (parsed.permissions) {
        config.permissions = { ...config.permissions, ...parsed.permissions };
      }
      config.configFile = projectPath;
    } catch {}
  }

  return config;
}

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

function loadUsage() {
  const usageFile = getUsageFilePath();
  const today = new Date().toISOString().slice(0, 10);

  const defaultUsage = {
    session_started_at: new Date().toISOString(),
    session: {
      total_calls: 0,
      calls_by_tool: { run: 0, plan: 0, review: 0, audit: 0, summary: 0, narrate: 0 },
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
    } catch {}
  }

  return { ...defaultUsage, usageFile };
}

function recordUsage(tool, model, effort, conversationId, durationSeconds, usage, isError = false, errorMsg = '') {
  try {
    const usageFile = getUsageFilePath();
    const claudeDir = path.dirname(usageFile);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

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
      effort: effort || 'high',
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

    fs.writeFileSync(usageFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[antigravity-mcp] Failed to record usage: ${err.message}\n`);
  }
}

function resetUsage() {
  const usageFile = getUsageFilePath();
  const today = new Date().toISOString().slice(0, 10);
  const fresh = {
    session_started_at: new Date().toISOString(),
    session: {
      total_calls: 0,
      calls_by_tool: { run: 0, plan: 0, review: 0, audit: 0, summary: 0, narrate: 0 },
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

  try {
    fs.writeFileSync(usageFile, JSON.stringify(fresh, null, 2), 'utf8');
  } catch {}
  return fresh;
}

function renderProgressBar(percent, length = 16) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * length);
  const empty = length - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${p.toFixed(1)}%`;
}

function getModelSpecs(modelName) {
  const m = (modelName || '').toLowerCase();
  if (m.includes('pro')) {
    return {
      name: modelName || 'gemini-2.5-pro',
      contextWindow: 2097152,
      maxOutput: 65536,
      description: 'Google Gemini Pro (Deep Reasoning & Multi-Turn Architecture)'
    };
  }
  return {
    name: modelName || 'gemini-3.7-flash',
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
          description: 'Model override for Antigravity session (e.g. "gemini-3.7-flash", "gemini-2.5-pro"). Falls back to configured default.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level. Defaults to configured default (usually "high").'
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
        permissions: {
          type: 'object',
          description: 'Granular ALLOW and DENY permission policies for this subagent execution.',
          properties: {
            allow: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicitly allowed capabilities: "read", "edit", "commands", "network".'
            },
            deny: {
              type: 'array',
              items: { type: 'string' },
              description: 'Explicitly denied capabilities (e.g. "edit" for read-only, "commands" to forbid shell execution).'
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
        },
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
          description: 'Model override for planning session (e.g. "gemini-2.5-pro", "gemini-3.7-flash").'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level. Defaults to "high".'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 15.'
        },
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
          description: 'Reasoning effort level. Defaults to "high".'
        },
        conversation_id: {
          type: 'string',
          description: 'Previous conversation ID to resume/continue an ongoing review thread.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 20 (can be increased for large repositories/diffs).'
        },
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
          description: 'Model override (e.g. "gemini-2.5-pro" recommended for deep audits).'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level. Defaults to "high".'
        },
        conversation_id: {
          type: 'string',
          description: 'Previous conversation ID to resume/continue an ongoing audit thread.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 25 (adversarial audits are deep and heavyweight).'
        },
        cwd: {
          type: 'string',
          description: 'Working directory.'
        }
      },
      required: ['target']
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
          description: 'Default model name (e.g. "gemini-3.7-flash", "gemini-2.5-pro").'
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
          description: 'Custom file path for the summary. Defaults to .claude/session-summaries/<date>-<session-id-short>.md'
        },
        focus: {
          type: 'string',
          enum: ['full', 'decisions', 'changes', 'debugging'],
          description: 'Summary focus area. "full" (default) covers everything. "decisions" emphasizes architectural/design choices. "changes" focuses on files modified. "debugging" highlights problems and resolutions.'
        },
        model: {
          type: 'string',
          description: 'Model override for summarization (e.g. "gemini-2.5-pro" for very large sessions). Falls back to configured default.'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort for summarization. Defaults to "high".'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes. Defaults to 15.'
        }
      }
    }
  },
  {
    name: 'agy_narrate',
    description: 'Narrate a voice summary of the latest completed checkpoint or task via Voicebox Text-To-Speech. Zero-Claude-token architecture: extracts checkpoint details directly from Claude Code session logs, generates a concise 2-3 sentence conversational update using Gemini (agy), and plays audio locally on your speakers via Voicebox.',
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
          description: 'Model override for Gemini narration generation (defaults to fast gemini-3.7-flash).'
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort level for narration script generation. Defaults to "low" for near-instant speech generation.'
        },
        personality: {
          type: 'boolean',
          description: 'When true, adopts the persona and personality configured on the Voicebox profile (from profile.description and profile.personality). Defaults to false (neutral professional tone).'
        },
        send_telegram: {
          type: 'boolean',
          description: 'When true (default: true if Telegram is configured), automatically delivers the synthesized speech as a native playable voice note to your mobile Telegram app.'
        },
        local_playback: {
          type: 'boolean',
          description: 'When true, plays the audio aloud through your PC speakers via Voicebox /speak. Defaults to false (silent background generation via /generate, delivering cleanly to Telegram without scaring anyone).'
        }
      }
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
      const content = typeof obj.message.content === 'string'
        ? obj.message.content
        : (Array.isArray(obj.message.content)
          ? obj.message.content.map(c => c.text || c.type || '').join(' ')
          : '');
      if (content.trim()) {
        turns.push({ role: 'user', content: content.trim(), ts: obj.timestamp });
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
    } else if (obj.type === 'tool_result' && obj.message) {
      // Condense tool results to first 300 chars
      const content = typeof obj.message.content === 'string'
        ? obj.message.content
        : (Array.isArray(obj.message.content)
          ? obj.message.content.map(c => c.text || '').join(' ')
          : '');
      if (content.trim()) {
        const truncated = content.trim().slice(0, 300);
        turns.push({
          role: 'tool_result',
          content: `[Result] ${truncated}${content.length > 300 ? '...' : ''}`,
          ts: obj.timestamp
        });
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

function getSummaryPrompt(focus = 'full') {
  const focusInstructions = {
    full: 'Cover all sections thoroughly and equally.',
    decisions: 'Emphasize the "Decisions Made" section. Go deeper on rationale, alternatives considered, and trade-offs.',
    changes: 'Emphasize the "Changes Made" section. List every file with detailed change descriptions.',
    debugging: 'Emphasize the "Problems Found and Resolutions" section. Detail each bug, error, or blocker with root cause analysis.'
  };

  return `You are a Session Documentation Specialist. Analyze the following transcript of a Claude Code development session and generate a structured summary document.

## Required Sections (in this exact order):

### 1. Executive Summary
- One sentence describing the main objective of the session
- Duration and key timestamps

### 2. Decisions Made
- Numbered list of each technical or design decision
- For each: context → decision → justification

### 3. Changes Made
- Files created, modified, or deleted
- For each file: what changed and why
- If tests were run: results

### 4. Problems Found and Resolutions
- Bugs, errors, or blockers encountered during the session
- How they were resolved (or if they remain pending)

### 5. Current State and Next Steps
- What was working at the end of the session
- Explicit pending tasks
- Dependencies or blockers for continuation

### 6. Context for Continuation
- The minimum information an agent or human needs to resume work where it was left off
- Relevant environment variables, branches, or configurations

## Focus: ${focusInstructions[focus] || focusInstructions.full}

## Rules:
- DO NOT invent information not present in the transcript
- Cite specific files when mentioning them
- If something is unclear, mark it as "[unclear in transcript]"
- Be concise: the document should not exceed 500 lines
- Write in the same language the user used in the session (if the session is in Spanish, write in Spanish)`;
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

async function checkVoiceboxHealth(baseUrl) {
  try {
    const res = await httpRequest(`${baseUrl}/health`, { timeout: 3000 });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      let info = {};
      try { info = JSON.parse(res.body); } catch {}
      return { ok: true, info };
    }
    return { ok: false, error: `Voicebox health endpoint returned HTTP ${res.statusCode}: ${res.body.slice(0, 150)}` };
  } catch (err) {
    return { ok: false, error: `Cannot reach Voicebox at ${baseUrl} (${err.message})` };
  }
}

async function getVoiceboxProfiles(baseUrl) {
  const res = await httpRequest(`${baseUrl}/profiles`, { timeout: 4000 });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return JSON.parse(res.body);
  }
  throw new Error(`Failed to fetch Voicebox profiles: HTTP ${res.statusCode}`);
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

async function sendVoiceboxSpeak(baseUrl, text, profileName, language) {
  const postData = {
    text,
    profile: profileName,
    language
  };
  const res = await httpRequest(`${baseUrl}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  }, postData);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    try {
      return JSON.parse(res.body);
    } catch {
      return { status: 'generating', raw: res.body };
    }
  }
  throw new Error(`Voicebox /speak returned HTTP ${res.statusCode}: ${res.body}`);
}

async function sendVoiceboxGenerate(baseUrl, text, profileId, language, options = {}) {
  const postData = {
    profile_id: profileId,
    text,
    language: language || 'es',
    model_size: '1.7B',
    engine: options.engine || 'qwen',
    personality: Boolean(options.personality),
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

function extractLastCheckpoint(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session log file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  function isRealUserMessage(obj) {
    if (obj.type !== 'user' || obj.isMeta) return false;
    const c = obj.message?.content;
    if (!c) return false;
    if (Array.isArray(c)) {
      if (c.some(item => item.type === 'tool_result')) return false;
      return c.some(item => item.type === 'text' && item.text && item.text.trim());
    }
    return typeof c === 'string' && c.trim().length > 0;
  }

  function getUserText(obj) {
    const c = obj.message?.content;
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) {
      return c.filter(item => item.type === 'text').map(item => item.text || '').join(' ').trim();
    }
    return '';
  }

  const userMessages = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (isRealUserMessage(obj)) {
        userMessages.push({ lineIndex: i, text: getUserText(obj), ts: obj.timestamp });
      }
    } catch {}
  }

  if (userMessages.length === 0) {
    return {
      userGoal: 'General development task',
      filesModified: [],
      commandsCount: 0,
      testExecutions: [],
      overallTestStatus: 'NO_TESTS',
      assistantNotes: ''
    };
  }

  let targetUserMsg = userMessages[userMessages.length - 1];
  const isOnlyNarrationCommand = targetUserMsg.text.startsWith('/agy-narrate') ||
    (targetUserMsg.text.length < 50 && (targetUserMsg.text.toLowerCase().includes('narra') || targetUserMsg.text.toLowerCase().includes('narrat')));

  if (isOnlyNarrationCommand && userMessages.length > 1) {
    targetUserMsg = userMessages[userMessages.length - 2];
  }

  const startLineIndex = targetUserMsg.lineIndex;
  const checkpointLines = lines.slice(startLineIndex);

  const filesModified = new Set();
  const commandsRun = [];
  const toolResults = new Map();
  let latestAssistantText = '';

  for (const line of checkpointLines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'assistant' && obj.message?.content) {
      for (const item of obj.message.content) {
        if (item.type === 'tool_use') {
          const name = item.name || '';
          const inp = item.input || {};

          if (['Edit', 'Write', 'NotebookEdit'].includes(name) && inp.file_path) {
            filesModified.add(inp.file_path);
          } else if (['write_to_file', 'replace_file_content'].includes(name) && inp.TargetFile) {
            filesModified.add(inp.TargetFile);
          }

          if (name === 'Bash' || name === 'run_command') {
            const cmd = inp.command || inp.CommandLine || '';
            if (cmd) {
              commandsRun.push({ id: item.id, command: cmd, ts: obj.timestamp });
            }
          }
        } else if (item.type === 'text' && item.text && item.text.trim()) {
          if (!item.text.includes('agy_narrate')) {
            latestAssistantText = item.text.trim();
          }
        }
      }
    } else if (obj.type === 'user' && obj.message?.content) {
      if (Array.isArray(obj.message.content)) {
        for (const item of obj.message.content) {
          if (item.type === 'tool_result' && item.tool_use_id) {
            toolResults.set(item.tool_use_id, {
              isError: Boolean(item.is_error),
              content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
            });
          }
        }
      }
    }
  }

  const testKeywords = ['test', 'pytest', 'jest', 'vitest', 'cargo test', 'go test', 'npm test', 'npx test', 'ctest'];
  const testExecutions = [];
  for (const cmd of commandsRun) {
    const lower = cmd.command.toLowerCase();
    const isTest = testKeywords.some(kw => lower.includes(kw));
    if (isTest) {
      const res = toolResults.get(cmd.id);
      const isFailed = res ? (res.isError || res.content.toLowerCase().includes('failed') || res.content.toLowerCase().includes('failing')) : false;
      testExecutions.push({
        command: cmd.command.slice(0, 120),
        passed: res ? !isFailed : null,
        outputSnippet: res ? res.content.slice(0, 200) : ''
      });
    }
  }

  let overallTestStatus = 'NO_TESTS';
  if (testExecutions.length > 0) {
    const lastTest = testExecutions[testExecutions.length - 1];
    overallTestStatus = lastTest.passed === true ? 'PASSED' : (lastTest.passed === false ? 'FAILED' : 'PENDING');
  }

  return {
    userGoal: targetUserMsg.text,
    filesModified: Array.from(filesModified),
    commandsCount: commandsRun.length,
    testExecutions,
    overallTestStatus,
    assistantNotes: latestAssistantText.slice(0, 500)
  };
}

function getNarrationPrompt(checkpoint, targetLang, profile, enablePersonality = false) {
  const langName = targetLang === 'en' ? 'English' : 'Spanish';
  const langCode = targetLang === 'en' ? 'en' : 'es';
  const profileName = (profile && profile.name) || 'Voice Assistant';

  let testSummary = 'No tests executed in this checkpoint.';
  if (checkpoint.overallTestStatus === 'PASSED') {
    testSummary = 'Tests were executed and PASSED successfully.';
  } else if (checkpoint.overallTestStatus === 'FAILED') {
    testSummary = 'Tests were executed and FAILED.';
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
function executeAgy(args, options = {}) {
  const timeoutMinutes = options.timeoutMinutes || 15;
  const timeoutMs = (timeoutMinutes + 1) * 60 * 1000;
  const cwd = options.cwd || process.cwd();

  const finalArgs = [...args];
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
      child.kill('SIGTERM');
      resolve({
        success: false,
        error: `Antigravity MCP process watchdog timed out after ${timeoutMinutes} minutes`,
        stdout,
        stderr
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      process.stderr.write(`[agy stderr] ${chunk}`);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        error: `Failed to spawn ${AGY_BIN}: ${err.message}`,
        stdout,
        stderr
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;

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

// Helper: Invoke Telegram Bridge for outbound notifications and human-in-the-loop decisions
function invokeTelegramBridge(command, payload = {}) {
  return new Promise((resolve) => {
    const notifyScript = path.join(__dirname, '..', 'telegram-bridge', 'notify.js');
    if (!fs.existsSync(notifyScript)) {
      return resolve({ ok: false, error: 'telegram-bridge/notify.js not found' });
    }

    const timeoutSec = (payload.timeoutSeconds || payload.timeout_seconds || 300) + 15;
    const child = spawn(process.execPath, [notifyScript, command, '-'], {
      shell: false,
      cwd: path.dirname(notifyScript),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, error: `Telegram operation timed out after ${timeoutSec}s` });
    }, timeoutSec * 1000);

    child.stdin.write(JSON.stringify(payload) + '\n');
    child.stdin.end();

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ ok: code === 0, ...parsed });
      } catch {
        resolve({
          ok: code === 0,
          raw: stdout.trim(),
          error: stderr.trim() || `Process exited with code ${code}`
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

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
      const activeModel = config.defaultModel || 'gemini-3.7-flash';
      const specs = getModelSpecs(activeModel);
      const s = usageData.session;
      const last = usageData.last_call;

      let out = `### 📊 Antigravity Subagent — Model & Usage Metrics\n\n`;

      out += `**🤖 Active Model Configuration:**\n`;
      out += `- Model: \`${specs.name}\` (${specs.description})\n`;
      out += `- Default Reasoning Effort: \`${config.defaultEffort || 'high'}\`\n`;
      out += `- Context Window: \`${formatTokens(specs.contextWindow)} tokens\`\n`;
      out += `- Max Output Tokens: \`${formatTokens(specs.maxOutput)} tokens\`\n`;
      out += `- Session Default Timeout: \`${config.defaultTimeoutMinutes}m\` (20m for reviews)\n`;
      out += `- Quota / API Health: **${usageData.quota_status}**\n\n`;

      out += `**📈 Cumulative Session Usage:**\n`;
      out += `- Total Delegated Calls: **${s.total_calls}** (run: ${s.calls_by_tool.run || 0}, plan: ${s.calls_by_tool.plan || 0}, review: ${s.calls_by_tool.review || 0}, audit: ${s.calls_by_tool.audit || 0}, summary: ${s.calls_by_tool.summary || 0})\n`;
      out += `- Input Tokens: \`${formatTokens(s.input_tokens)}\`\n`;
      out += `- Output Tokens: \`${formatTokens(s.output_tokens)}\`\n`;
      out += `- Thinking / Reasoning Tokens: \`${formatTokens(s.thinking_tokens)}\`\n`;
      out += `- Context Caching Reused: \`${formatTokens(s.cache_read_tokens)}\` tokens\n`;
      out += `- Total Tokens Processed: **\`${formatTokens(s.total_tokens)}\`**\n`;
      out += `- Total Reasoning Time: **${formatDuration(s.total_duration_seconds)}**\n\n`;

      if (last && last.usage) {
        const lastPercent = specs.contextWindow ? ((last.usage.total_tokens / specs.contextWindow) * 100) : 0;
        out += `**🎯 Last Invocation (${last.tool}):**\n`;
        out += `- Model: \`${last.model}\` | Effort: \`${last.effort}\`\n`;
        out += `- Total Tokens: **\`${formatTokens(last.usage.total_tokens)}\`** ${renderProgressBar(lastPercent)} of context window\n`;
        out += `- Deep Thinking: \`${formatTokens(last.usage.thinking_tokens)}\` tokens\n`;
        out += `- Cached Tokens: \`${formatTokens(last.usage.cache_read_tokens)}\` tokens\n`;
        out += `- Duration: ${formatDuration(last.duration_seconds)}\n`;
        if (last.conversation_id) {
          out += `- Conversation ID: \`${last.conversation_id}\`\n`;
        }
      } else {
        out += `*No subagent invocations recorded in this session yet.*\n`;
      }

      out += `\n*Tip: Run \`/agy-usage reset\` or pass \`reset: true\` to clear session counters.*`;

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
            text: `Antigravity CLI Status:\n- Binary: ${AGY_BIN}\n- Version/Info: ${version || 'Available'}\n- OS: ${process.platform} (${process.arch})\n- Default Model: ${config.defaultModel || '(cli default: gemini-3.7-flash)'}\n- Default Effort: ${config.defaultEffort || 'high'}\n- Default Timeout: ${config.defaultTimeoutMinutes}m\n- Permissions Policy:\n  * Allow: [${p.allow.join(', ')}]\n  * Deny: [${p.deny.join(', ') || 'none'}]\n  * Denied Paths: [${p.deny_paths.join(', ')}]\n  * Denied Commands: [${p.deny_commands.join(', ')}]\n  * Sandbox Mode: ${p.sandbox ? 'enabled' : 'disabled'}\n- Active Config File: ${config.configFile || 'none (using defaults)'}\n- Ready to execute subagent tasks.`
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

      const result = saveConfig(updates, scope, args.cwd);
      return {
        content: [
          {
            type: 'text',
            text: `Antigravity configuration updated successfully (${scope} scope in ${result.targetFile}):\n- Default Model: ${result.config.model || '(cli default)'}\n- Default Effort: ${result.config.effort || 'high'}\n- Default Timeout: ${result.config.timeout_minutes || 15}m\n- Permissions: ${JSON.stringify(result.config.permissions || {}, null, 2)}`
          }
        ]
      };
    }

    case 'agy_run': {
      const callPerms = args.permissions || {};
      const basePerms = config.permissions;
      const effectivePerms = {
        allow: callPerms.allow || basePerms.allow || ['read', 'edit', 'commands', 'network'],
        deny: callPerms.deny || basePerms.deny || [],
        deny_paths: callPerms.deny_paths || basePerms.deny_paths || [],
        deny_commands: callPerms.deny_commands || basePerms.deny_commands || [],
        sandbox: callPerms.sandbox !== undefined ? callPerms.sandbox : (basePerms.sandbox || false)
      };

      const canEdit = !effectivePerms.deny.includes('edit') && effectivePerms.allow.includes('edit');
      const canRunCommands = !effectivePerms.deny.includes('commands') && effectivePerms.allow.includes('commands');

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

      const effectiveEffort = args.effort || config.defaultEffort || 'high';
      cliArgs.push('--effort', effectiveEffort);

      const effectiveModel = args.model || config.defaultModel;
      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      if (args.conversation_id) {
        cliArgs.push('--conversation', args.conversation_id);
      } else if (args.continue_session) {
        cliArgs.push('-c');
      }

      let finalPrompt = args.prompt;
      const securityRules = [];

      if (!canEdit) {
        securityRules.push('- EDIT PERMISSION DENIED: You are operating in STRICT READ-ONLY mode. Do not write or edit any files.');
      }
      if (!canRunCommands) {
        securityRules.push('- COMMAND EXECUTION DENIED: Do not run or propose any shell/terminal commands.');
      }
      if (effectivePerms.deny_paths.length > 0) {
        securityRules.push(`- FORBIDDEN PATHS: You MUST NEVER access, read, write, or mention contents of these path patterns: ${effectivePerms.deny_paths.join(', ')}`);
      }
      if (effectivePerms.deny_commands.length > 0) {
        securityRules.push(`- FORBIDDEN COMMANDS: You MUST NEVER execute commands matching: ${effectivePerms.deny_commands.join(', ')}`);
      }

      if (securityRules.length > 0) {
        finalPrompt = `[SECURITY & PERMISSION GUARDRAILS ENFORCED BY USER POLICY]
${securityRules.join('\n')}
If any requested action violates these rules, refuse that specific action and explain the restriction.

[TASK INSTRUCTIONS]
${args.prompt}`;
      }

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
      formatted += `- Mode: \`${effectiveMode}\` (${canEdit ? 'read/write' : 'read-only'})\n`;
      formatted += `- Permissions Enforced: allow=[${effectivePerms.allow.join(', ')}], deny=[${effectivePerms.deny.join(', ') || 'none'}], sandbox=${effectivePerms.sandbox}\n`;
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

    case 'agy_plan': {
      const planPrompt = `You are acting as an Architectural & Planning Subagent.
Task:
${args.task}

Analyze the codebase and provide a thorough, structured step-by-step implementation plan.
DO NOT execute code modifications. Outline files to create/modify, architectural choices, edge cases, tests to write, and verification steps.`;

      const effectiveEffort = args.effort || config.defaultEffort || 'high';
      const effectiveModel = args.model || config.defaultModel;

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan',
        '--effort', effectiveEffort
      ];

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      cliArgs.push('-p', planPrompt);

      const timeoutMin = args.timeout_minutes || config.defaultTimeoutMinutes || 15;
      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: timeoutMin
      });

      const resData = result.data || {};
      const conversationId = resData.conversation_id || '';
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
      if (conversationId) {
        formatted += `\nConversation ID: \`${conversationId}\` (use \`agy_run\` with this ID to begin execution)`;
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

      const effectiveEffort = args.effort || config.defaultEffort || 'high';
      const effectiveModel = args.model || config.defaultModel;

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan',
        '--effort', effectiveEffort
      ];

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      if (args.conversation_id) {
        cliArgs.push('--conversation', args.conversation_id);
      }

      cliArgs.push('-p', auditPrompt);

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

      const effectiveEffort = args.effort || config.defaultEffort || 'high';
      const effectiveModel = args.model || config.defaultModel;

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan',
        '--effort', effectiveEffort
      ];

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      if (args.conversation_id) {
        cliArgs.push('--conversation', args.conversation_id);
      }

      cliArgs.push('-p', reviewPrompt);

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
      if (conversationId) {
        formatted += `Conversation ID: \`${conversationId}\` (pass as \`conversation_id\` to follow up on this review)`;
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
      const summarySystemPrompt = getSummaryPrompt(focus);
      const fullPrompt = `${summarySystemPrompt}\n\n---\n\n## Session Metadata\n- Project: ${processed.sessionMeta.cwd || cwd}\n- Branch: ${processed.sessionMeta.branch || 'unknown'}\n- Claude Version: ${processed.sessionMeta.version || 'unknown'}\n- Session Start: ${processed.sessionMeta.startTime || 'unknown'}\n- Session End: ${processed.sessionMeta.endTime || 'unknown'}\n- Total Turns: ${processed.totalTurns}\n- Log File Size: ${(fileSize / 1024).toFixed(1)}KB\n\n---\n\n## Session Transcript\n\n${processed.transcript}`;

      // 6. Delegate to agy for summarization
      const effectiveEffort = args.effort || config.defaultEffort || 'high';
      const effectiveModel = args.model || config.defaultModel;

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan',
        '--effort', effectiveEffort
      ];

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      cliArgs.push('-p', fullPrompt);

      const timeoutMin = args.timeout_minutes || config.defaultTimeoutMinutes || 15;
      const result = await executeAgy(cliArgs, {
        cwd,
        timeoutMinutes: timeoutMin
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
      const responseText = resData.response || result.rawOutput || '';
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
      if (effectiveModel) formatted += `- Model: \`${effectiveModel}\`\n`;
      formatted += `- Duration: ${duration ? `${duration.toFixed(1)}s` : 'unknown'}\n`;
      if (conversationId) {
        formatted += `- Conversation ID: \`${conversationId}\`\n`;
      }

      return {
        content: [{ type: 'text', text: formatted }]
      };
    }

    case 'agy_narrate': {
      const cwd = args.cwd || process.cwd();
      const voiceboxUrl = resolveVoiceboxUrl(args, config);

      // 1. Verify Voicebox connectivity
      const health = await checkVoiceboxHealth(voiceboxUrl);
      if (!health.ok) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ **Voicebox no está disponible en \`${voiceboxUrl}\`**\n\n${health.error}\n\n*Asegúrate de iniciar la aplicación Voicebox en tu equipo (o especifica un puerto/URL personalizado si corre en otra dirección).*`
          }]
        };
      }

      // 2. Fetch available voice profiles
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

      // 3. Resolve profile & language (with Emily / Diego Alvarez defaults & fallbacks)
      let voiceResolution;
      try {
        voiceResolution = resolveVoiceProfile(profiles, args.voice, args.language);
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ Error resolviendo el perfil de voz: ${err.message}`
          }]
        };
      }

      const chosenProfile = voiceResolution.profile;
      const targetLang = voiceResolution.language;

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
        assistantNotes: ''
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
      const effectiveEffort = args.effort || 'low';
      const effectiveModel = args.model || config.defaultModel;

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--mode', 'plan',
        '--effort', effectiveEffort
      ];

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

      // Clean spoken text: remove quotes, markdown, asterisks, brackets
      let spokenText = (resData.response || agyRes.rawOutput || '').trim();
      spokenText = spokenText
        .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
        .replace(/[*#`_~]/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\n+/g, ' ')
        .trim();

      if (!spokenText) {
        spokenText = targetLang === 'en'
          ? 'The latest task has completed successfully.'
          : 'La última tarea se ha completado exitosamente.';
      }

      // 5.9 Snapshot previo de archivos en generations/ para FIFO / detección exacta
      const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
      const genDir = path.join(appData, 'sh.voicebox.app', 'generations');
      const beforeFiles = fs.existsSync(genDir) ? fs.readdirSync(genDir) : [];

      // 6. Send to Voicebox TTS: siempre usamos /generate para evitar el bug de doble reproducción de Voicebox
      let speakRes;
      try {
        speakRes = await sendVoiceboxGenerate(voiceboxUrl, spokenText, chosenProfile.id, targetLang, {
          personality: enablePersonality
        });
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ **Guión generado pero falló la generación en Voicebox:**\n\n"${spokenText}"\n\nError: ${err.message}`
          }]
        };
      }

      const langLabel = targetLang === 'es' ? 'Español' : 'Inglés';
      const playLocally = Boolean(args.local_playback);
      let localPlayed = false;
      let telegramDelivered = false;
      let generatedWavPath = null;

      // 6.1 Si se solicitó reproducción local, esperar a que el archivo termine y reproducirlo con el motor nativo de Windows (0 eco)
      if (playLocally) {
        try {
          generatedWavPath = await waitForGenerationFile(
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

      // 6.2 Enviar nota de voz a Telegram si está configurado (por defecto activo)
      if (args.send_telegram !== false) {
        try {
          const tPayload = {
            generationId: (speakRes && speakRes.id) ? speakRes.id : null,
            beforeFiles,
            waitForGeneration: !generatedWavPath,
            timeoutSeconds: 95,
            caption: `🎙️ "${spokenText}"\n(Voz: ${chosenProfile.name} • ${langLabel})`
          };
          if (generatedWavPath) {
            tPayload.audioPath = generatedWavPath;
          }
          const tRes = await invokeTelegramBridge('--voice-json', tPayload);
          if (tRes && tRes.ok) telegramDelivered = true;
        } catch (tErr) {
          process.stderr.write(`[antigravity-mcp] Telegram delivery skipped: ${tErr.message}\n`);
        }
      }

      // 7. Format structured output for Claude
      const fallbackNotice = voiceResolution.isFallback
        ? ` *(Fallback: ${voiceResolution.reason})*`
        : ' *(Voz preferida)*';

      let out = `### 🎙️ Narración de Voz Emitida (Voicebox)\n\n`;
      out += `**Texto narrado:**\n`;
      out += `> "${spokenText}"\n\n`;
      out += `**Detalles de la emisión:**\n`;
      out += `- **Perfil de voz**: \`${chosenProfile.name}\` (${chosenProfile.voice_type || 'cloned'})${fallbackNotice}\n`;
      out += `- **Idioma**: \`${langLabel} (${targetLang})\`\n`;
      out += `- **Modo de Personalidad**: ${enablePersonality ? `🎭 En personaje (\`${chosenProfile.personality || chosenProfile.description || 'expresivo'}\`)` : '👔 Neutral / Profesional'}\n`;
      out += `- **Reproducción Local en PC**: ${playLocally ? (localPlayed ? '🔊 Reproducido limpiamente en altavoces (sin eco)' : '⚠️ Solicitado pero falló el reproductor local') : '🤫 Silencioso en PC'}\n`;
      out += `- **Endpoint**: \`${voiceboxUrl}\`\n`;
      if (speakRes && speakRes.id) {
        out += `- **Voicebox Generation ID**: \`${speakRes.id}\`\n`;
      }
      if (telegramDelivered) {
        out += `- **Telegram Móvil**: ✅ Nota de voz entregada a tu teléfono\n`;
      }
      out += `\n**Contexto del Checkpoint detectado:**\n`;
      out += `- **Objetivo**: ${checkpoint.userGoal.slice(0, 150)}${checkpoint.userGoal.length > 150 ? '...' : ''}\n`;
      out += `- **Estado de Tests**: \`${checkpoint.overallTestStatus}\`\n`;
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

    case 'agy_narrate_voices': {
      const voiceboxUrl = resolveVoiceboxUrl(args, config);

      // 1. Verify Voicebox health
      const health = await checkVoiceboxHealth(voiceboxUrl);
      if (!health.ok) {
        return {
          content: [{
            type: 'text',
            text: `⚠️ **Voicebox no está disponible en \`${voiceboxUrl}\`**\n\n${health.error}\n\n*Asegúrate de que la aplicación Voicebox esté iniciada en tu equipo (o especifica un puerto/URL personalizado si corre en otra dirección).*`
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
      out += `> - Comando: \`/agy-narrate <nombre>\` (ej: \`/agy-narrate aria\` o \`/agy-narrate "Mi voz"\`)\n`;
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
