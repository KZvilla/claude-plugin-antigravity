#!/usr/bin/env node

/**
 * Antigravity MCP Server for Claude Code
 * Bridges Claude Code / Claude CLI to the Antigravity CLI (`agy.exe`).
 * Implements MCP stdio JSON-RPC 2.0 protocol with zero external dependencies.
 * Includes granular ALLOW / DENY permission management and robust timeout handling.
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

// Configuration & Permission Management
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
          description: 'Timeout in minutes. Defaults to 15 (can be increased for large repositories/diffs).'
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

// Helper: Run agy process
function executeAgy(args, options = {}) {
  const timeoutMinutes = options.timeoutMinutes || 15;
  const timeoutMs = (timeoutMinutes + 1) * 60 * 1000; // 1-minute buffer after agy's internal timeout
  const cwd = options.cwd || process.cwd();

  // Inject --print-timeout into args if not already present
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
        // Structured error response handling
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
            text: `Antigravity CLI Status:\n- Binary: ${AGY_BIN}\n- Version/Info: ${version || 'Available'}\n- OS: ${process.platform} (${process.arch})\n- Default Model: ${config.defaultModel || '(cli default)'}\n- Default Effort: ${config.defaultEffort || 'high'}\n- Default Timeout: ${config.defaultTimeoutMinutes}m\n- Permissions Policy:\n  * Allow: [${p.allow.join(', ')}]\n  * Deny: [${p.deny.join(', ') || 'none'}]\n  * Denied Paths: [${p.deny_paths.join(', ')}]\n  * Denied Commands: [${p.deny_commands.join(', ')}]\n  * Sandbox Mode: ${p.sandbox ? 'enabled' : 'disabled'}\n- Active Config File: ${config.configFile || 'none (using defaults)'}\n- Ready to execute subagent tasks.`
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
      // Merge effective permissions
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

      // Security guardrails injection
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

      if (!result.success) {
        let errText = `Error executing Antigravity subagent:\n${result.error}`;
        if (result.data && result.data.conversation_id) {
          errText += `\n\nSession Conversation ID: \`${result.data.conversation_id}\``;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      const resData = result.data || {};
      const conversationId = resData.conversation_id || '';
      const responseText = resData.response || result.rawOutput || '(No response text returned)';
      const duration = resData.duration_seconds ? `${resData.duration_seconds.toFixed(1)}s` : 'unknown';
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
      formatted += `- Duration: ${duration} (timeout limit: ${timeoutMin}m)\n`;
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

      if (!result.success) {
        let errText = `Error generating plan with Antigravity:\n${result.error}`;
        if (result.data && result.data.conversation_id) {
          errText += `\n\nSession Conversation ID: \`${result.data.conversation_id}\``;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      const resData = result.data || {};
      const conversationId = resData.conversation_id || '';
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

      const timeoutMin = args.timeout_minutes || config.defaultTimeoutMinutes || 20; // 20 min default for reviews
      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: timeoutMin
      });

      if (!result.success) {
        let errText = `Error reviewing with Antigravity:\n${result.error}`;
        if (result.data && result.data.conversation_id) {
          errText += `\n\nSession Conversation ID: \`${result.data.conversation_id}\` (you can resume this review thread by passing this ID).`;
        }
        return {
          isError: true,
          content: [{ type: 'text', text: errText }]
        };
      }

      const resData = result.data || {};
      const responseText = resData.response || result.rawOutput || '';
      const conversationId = resData.conversation_id || '';

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
              version: '1.3.0'
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
