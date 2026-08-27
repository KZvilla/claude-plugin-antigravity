# Antigravity Claude Code Plugin

A Claude Code plugin that integrates **Google Antigravity CLI (`agy`)** as an autonomous subagent and pair-programming partner.

With this plugin, Claude Code can delegate deep reasoning, architectural planning, TDD implementation, and adversarial code reviews to Antigravity running directly in your terminal.

---

## Features

- 🤖 **Autonomous Subagent**: Claude can spin up Antigravity (`agy.exe`) to execute complex tasks, multi-step refactors, and test suites.
- 🧠 **Dual Model Intelligence**: Combines Anthropic's Claude with Google's Gemini models (Gemini 2.5 / 3.7 Pro & Flash) with High reasoning effort.
- 🔄 **Multi-Turn Continuity**: Sessions capture `conversation_id`, enabling back-and-forth iteration where Antigravity remembers all previous conversation turns and workspace context.
- ⚡ **Zero External Dependencies**: Lightweight stdio MCP server implemented directly in standard Node.js.
- 🛠️ **Slash Commands**: Quick terminal commands (`/agy`, `/agy-plan`, `/agy-review`).
- 🛡️ **Safe Headless Execution**: Configured with `--dangerously-skip-permissions` and configurable timeouts to run headlessly without getting stuck on interactive prompts.

---

## Components

| Component | Path | Description |
|-----------|------|-------------|
| **MCP Server** | `mcp-server/index.js` | Zero-dependency MCP JSON-RPC server exposing `agy_run`, `agy_plan`, `agy_review`, `agy_status` |
| **Subagent** | `agents/antigravity.md` | Autonomous subagent definition for Claude Code |
| **Skill** | `skills/antigravity/SKILL.md` | Context-aware guidelines on when and how to delegate to Antigravity |
| **Commands** | `commands/agy.md` | Slash command `/agy <prompt>` |
| | `commands/agy-plan.md` | Slash command `/agy-plan <task>` |
| | `commands/agy-review.md` | Slash command `/agy-review [target]` |

---

## MCP Tools Reference

### `agy_run`
Executes an Antigravity subagent session.

**Parameters:**
- `prompt` (string, required): The task, instructions, or question.
- `effort` (`"low"` | `"medium"` | `"high"`, default: `"high"`): Reasoning effort.
- `conversation_id` (string, optional): ID of previous conversation to resume context.
- `continue_session` (boolean, optional): Continue most recent conversation (`-c`).
- `model` (string, optional): Specific model override (e.g. `gemini-3.7-flash`, `gemini-2.5-pro`).
- `mode` (`"accept-edits"` | `"plan"`, default: `"accept-edits"`): Execution mode.
- `dangerously_skip_permissions` (boolean, default: `true`): Run headlessly without prompts.
- `timeout_minutes` (number, default: `10`): Max runtime in minutes.
- `cwd` (string, optional): Working directory.

### `agy_plan`
Generates a step-by-step architectural and implementation plan without modifying files.

**Parameters:**
- `task` (string, required): The feature or problem to plan.
- `effort` (default: `"high"`).
- `cwd` (string, optional).

### `agy_review`
Performs an adversarial code review on git diffs or specific files.

**Parameters:**
- `review_target` (string, required): Target to review (e.g. `"git diff HEAD~1"`, `"src/routes/__root.tsx"`).
- `guidelines` (string, optional): Specific rules or standards to enforce.
- `effort` (default: `"high"`).

### `agy_status`
Checks binary path, version, and health of the Antigravity CLI installation.

---

## Slash Commands

- `/agy <prompt>`: Delegate a task directly to Antigravity and view the results.
- `/agy-plan <task>`: Ask Antigravity to analyze the workspace and produce an implementation plan.
- `/agy-review [target]`: Run an adversarial review of recent git changes.

---

## Installation & Setup

Because this plugin is located in `~/.claude/skills/antigravity/`, Claude Code automatically discovers and enables it as `antigravity@skills-dir` across all sessions!

To reload plugins in an active Claude Code session:
```bash
/reload-plugins
```

To verify the installation:
```bash
claude plugin details antigravity@skills-dir
```
