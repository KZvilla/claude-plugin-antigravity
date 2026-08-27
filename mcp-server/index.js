#!/usr/bin/env node

/**
 * Antigravity MCP Server for Claude Code
 * Bridges Claude Code / Claude CLI to the Antigravity CLI (`agy.exe`).
 * Implements MCP stdio JSON-RPC 2.0 protocol with zero external dependencies.
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

// Configuration Management (defaults for model and effort)
function loadConfig(cwd = process.cwd()) {
  const config = {
    defaultModel: process.env.AGY_MODEL || null,
    defaultEffort: process.env.AGY_EFFORT || 'high',
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
      config.configFile = globalPath;
    } catch {}
  }

  if (fs.existsSync(projectPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
      if (parsed.model) config.defaultModel = parsed.model;
      if (parsed.effort) config.defaultEffort = parsed.effort;
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

  fs.writeFileSync(targetFile, JSON.stringify(existing, null, 2), 'utf8');
  return { targetFile, config: existing };
}

// MCP Tool Definitions
const TOOLS = [
  {
    name: 'agy_run',
    description: 'Execute the Antigravity CLI (agy) as an autonomous subagent. Antigravity can edit files, run shell commands, perform deep reasoning, and access workspace tools. Returns structured response with conversation_id for multi-turn workflows.',
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
        cwd: {
          type: 'string',
          description: 'Working directory for the session. Defaults to Claude\'s current working directory.'
        },
        timeout_minutes: {
          type: 'number',
          description: 'Timeout in minutes before canceling execution. Defaults to 10.'
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
    description: 'Ask Antigravity to analyze the codebase and generate an architectural or implementation plan without executing modifications.',
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
    description: 'Ask Antigravity to perform an adversarial or complementary code review of recent changes, diffs, or specific files against guidelines and best practices.',
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
    description: 'Check the status, version, active model/effort defaults, and binary path of Antigravity CLI.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'agy_set_config',
    description: 'Set default model or reasoning effort for Antigravity subagent sessions (persisted in .claude/antigravity.json).',
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
  const timeoutMs = (options.timeoutMinutes || 10) * 60 * 1000;
  const cwd = options.cwd || process.cwd();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    process.stderr.write(`[antigravity-mcp] Spawning: ${AGY_BIN} ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')} (cwd: ${cwd})\n`);

    const child = spawn(AGY_BIN, args, {
      cwd,
      shell: false,
      env: { ...process.env }
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      resolve({
        success: false,
        error: `Antigravity CLI timed out after ${options.timeoutMinutes || 10} minutes`,
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

      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({
            success: true,
            data: parsed,
            rawOutput: stdout
          });
        } catch {
          resolve({
            success: true,
            data: { response: stdout },
            rawOutput: stdout
          });
        }
      } else {
        resolve({
          success: false,
          error: `Antigravity CLI exited with code ${code}. Stderr: ${stderr.trim() || 'none'}. Stdout: ${stdout.trim() || 'none'}`,
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

      return {
        content: [
          {
            type: 'text',
            text: `Antigravity CLI Status:\n- Binary: ${AGY_BIN}\n- Version/Info: ${version || 'Available'}\n- OS: ${process.platform} (${process.arch})\n- Default Model: ${config.defaultModel || '(cli default)'}\n- Default Effort: ${config.defaultEffort || 'high'}\n- Active Config File: ${config.configFile || 'none (using defaults)'}\n- Ready to execute subagent tasks.`
          }
        ]
      };
    }

    case 'agy_set_config': {
      const scope = args.scope || 'global';
      const updates = {};
      if (args.model !== undefined) updates.model = args.model;
      if (args.effort !== undefined) updates.effort = args.effort;

      const result = saveConfig(updates, scope, args.cwd);
      return {
        content: [
          {
            type: 'text',
            text: `Antigravity configuration updated successfully (${scope} scope in ${result.targetFile}):\n- Default Model: ${result.config.model || '(cli default)'}\n- Default Effort: ${result.config.effort || 'high'}`
          }
        ]
      };
    }

    case 'agy_run': {
      const cliArgs = ['--output-format', 'json'];

      if (args.dangerously_skip_permissions !== false) {
        cliArgs.push('--dangerously-skip-permissions');
      }

      if (args.mode) {
        cliArgs.push('--mode', args.mode);
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

      cliArgs.push('-p', args.prompt);

      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: args.timeout_minutes || 10
      });

      if (!result.success) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error executing Antigravity subagent:\n${result.error}`
            }
          ]
        };
      }

      const resData = result.data || {};
      const conversationId = resData.conversation_id || '';
      const responseText = resData.response || result.rawOutput || '(No response text returned)';
      const duration = resData.duration_seconds ? `${resData.duration_seconds.toFixed(1)}s` : 'unknown';
      const tokens = resData.usage ? `Input: ${resData.usage.input_tokens}, Output: ${resData.usage.output_tokens}, Thinking: ${resData.usage.thinking_tokens || 0}` : '';

      let formatted = `${responseText.trim()}\n\n---\n`;
      formatted += `**Antigravity Execution Details:**\n`;
      if (effectiveModel) {
        formatted += `- Model: \`${effectiveModel}\`\n`;
      }
      formatted += `- Effort: \`${effectiveEffort}\`\n`;
      if (conversationId) {
        formatted += `- Conversation ID: \`${conversationId}\` (pass as \`conversation_id\` to continue this thread)\n`;
      }
      formatted += `- Duration: ${duration}\n`;
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
        '--effort', effectiveEffort
      ];

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      cliArgs.push('-p', planPrompt);

      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: 10
      });

      if (!result.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error generating plan with Antigravity:\n${result.error}` }]
        };
      }

      const resData = result.data || {};
      const conversationId = resData.conversation_id || '';
      const responseText = resData.response || result.rawOutput || '';

      let formatted = `### Antigravity Implementation Plan\n\n${responseText.trim()}\n\n---\n`;
      formatted += `Effort: \`${effectiveEffort}\``;
      if (effectiveModel) formatted += ` | Model: \`${effectiveModel}\``;
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
Review the code changes or files with high rigor. Focus on:
1. Architectural integrity, contracts, and regressions
2. Security & privacy issues
3. Performance and edge cases
4. Accessibility (WCAG) and error handling
Provide specific findings with file paths, line numbers, issue descriptions, and concrete recommendations.`;

      const effectiveEffort = args.effort || config.defaultEffort || 'high';
      const effectiveModel = args.model || config.defaultModel;

      const cliArgs = [
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--effort', effectiveEffort
      ];

      if (effectiveModel) {
        cliArgs.push('--model', effectiveModel);
      }

      cliArgs.push('-p', reviewPrompt);

      const result = await executeAgy(cliArgs, {
        cwd: args.cwd,
        timeoutMinutes: 10
      });

      if (!result.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error reviewing with Antigravity:\n${result.error}` }]
        };
      }

      const resData = result.data || {};
      const responseText = resData.response || result.rawOutput || '';

      return {
        content: [{ type: 'text', text: `### Antigravity Code Review (Effort: ${effectiveEffort}${effectiveModel ? `, Model: ${effectiveModel}` : ''})\n\n${responseText.trim()}` }]
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
              version: '1.1.0'
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
