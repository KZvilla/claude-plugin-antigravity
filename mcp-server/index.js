#!/usr/bin/env node

/**
 * Antigravity MCP Server for Claude Code
 * Bridges Claude Code / Claude CLI to the Antigravity CLI (`agy.exe`).
 * Implements MCP stdio JSON-RPC 2.0 protocol with zero external dependencies.
 * Includes granular ALLOW / DENY permissions, robust timeout handling, and telemetry / usage metrics.
 */

const { spawn, execSync } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');

// Resolve agy binary location
function resolveAgyBin() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'agy.exe' : 'agy';

  // 1. Try PATH
  try {
    const cmd = isWin ? `where.exe ${binName}` : `which ${binName}`;
    const found = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
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
      calls_by_tool: { run: 0, plan: 0, review: 0, audit: 0 },
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
      calls_by_tool: { run: 0, plan: 0, review: 0, audit: 0 },
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

    process.stderr.write(`[antigravity-mcp] Spawning: ${AGY_BIN} ${finalArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')} (cwd: ${cwd}, timeout: ${timeoutMinutes}m)\n`);

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
      out += `- Total Delegated Calls: **${s.total_calls}** (run: ${s.calls_by_tool.run || 0}, plan: ${s.calls_by_tool.plan || 0}, review: ${s.calls_by_tool.review || 0}, audit: ${s.calls_by_tool.audit || 0})\n`;
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
        version = execSync(`"${AGY_BIN}" --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      } catch {
        try {
          version = execSync(`"${AGY_BIN}" help`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).split('\n')[0].trim();
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
