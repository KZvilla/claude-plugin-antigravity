# Antigravity Claude Code Plugin

A Claude Code plugin that integrates **Google Antigravity CLI (`agy`)** as an autonomous subagent and pair-programming partner.

With this plugin, Claude Code can delegate deep reasoning, architectural planning, TDD implementation, and adversarial code reviews to Antigravity running directly in your terminal.

---

## Features

- 🤖 **Autonomous Subagent**: Claude can spin up Antigravity (`agy.exe`) to execute complex tasks, multi-step refactors, and test suites.
- 🧠 **Dual Model Intelligence**: Combines Anthropic's Claude with Google's Gemini models (Gemini 2.5 / 3.7 Pro & Flash) with configurable reasoning effort (`low`, `medium`, `high`).
- 🔄 **Multi-Turn Continuity**: Sessions capture `conversation_id`, enabling back-and-forth iteration where Antigravity remembers all previous conversation turns and workspace context.
- ⚙️ **Flexible Configuration**: Set model and effort dynamically per prompt, persistently in JSON config files, or via environment variables.
- ⚡ **Zero External Dependencies**: Lightweight stdio MCP server implemented directly in standard Node.js.
- 🛠️ **Slash Commands**: Quick terminal commands (`/agy`, `/agy-plan`, `/agy-review`).
- 🛡️ **Safe Headless Execution**: Configured with `--dangerously-skip-permissions` and configurable timeouts to run headlessly without getting stuck on interactive prompts.

---

## Components

| Component | Path | Description |
|-----------|------|-------------|
| **MCP Server** | `mcp-server/index.js` | Zero-dependency MCP JSON-RPC server exposing `agy_run`, `agy_plan`, `agy_review`, `agy_status`, `agy_set_config` |
| **Subagent** | `agents/antigravity.md` | Autonomous subagent definition for Claude Code (`antigravity:Antigravity`) |
| **Skill** | `skills/antigravity/SKILL.md` | Context-aware guidelines on when and how to delegate to Antigravity |
| **Commands** | `commands/agy.md` | Slash command `/agy <prompt>` |
| | `commands/agy-plan.md` | Slash command `/agy-plan <task>` |
| | `commands/agy-review.md` | Slash command `/agy-review [target]` |
| **Installers** | `install.ps1` / `install.sh` | 1-step installation scripts for Windows, Linux, and macOS |

---

## ⚙️ Model & Reasoning Effort Configuration

You can customize which Gemini model and reasoning effort Antigravity uses at three different levels:

### 1. Per Call / Prompt
Specify model or effort directly in your instruction to Claude:
> *"Claude, delegale esta tarea a agy usando el modelo `gemini-2.5-pro` y effort `high`"*

Claude passes these parameters directly to the underlying tool:
- `model`: e.g. `"gemini-3.7-flash"`, `"gemini-2.5-pro"`
- `effort`: `"low"`, `"medium"`, or `"high"`

### 2. Persistent Defaults via Tool
Ask Claude to save your preferences:
> *"Configurá agy por defecto con modelo gemini-3.7-flash y effort high"*

Claude will execute `agy_set_config` to persist the setting.

### 3. Persistent Defaults via JSON File
Create or edit:
- **Global (all sessions):** `~/.claude/antigravity.json`
- **Project-specific:** `.claude/antigravity.json`

```json
{
  "model": "gemini-3.7-flash",
  "effort": "high"
}
```

### 4. Environment Variables
```bash
# Windows PowerShell
$env:AGY_MODEL = "gemini-3.7-flash"
$env:AGY_EFFORT = "high"

# Bash / Zsh
export AGY_MODEL="gemini-3.7-flash"
export AGY_EFFORT="high"
```

---

## MCP Tools Reference

### `agy_run`
Executes an Antigravity subagent session.

**Parameters:**
- `prompt` (string, required): The task, instructions, or question.
- `model` (string, optional): Specific model override (e.g. `gemini-3.7-flash`, `gemini-2.5-pro`). Falls back to configured default.
- `effort` (`"low"` | `"medium"` | `"high"`, optional): Reasoning effort level. Defaults to configured default (usually `"high"`).
- `conversation_id` (string, optional): ID of previous conversation to resume context across turns.
- `continue_session` (boolean, optional): Continue most recent conversation (`-c`).
- `mode` (`"accept-edits"` | `"plan"`, default: `"accept-edits"`): Execution mode.
- `dangerously_skip_permissions` (boolean, default: `true`): Run headlessly without interactive prompts.
- `timeout_minutes` (number, default: `10`): Max runtime in minutes.
- `cwd` (string, optional): Working directory.

### `agy_plan`
Generates a step-by-step architectural and implementation plan without modifying files.

**Parameters:**
- `task` (string, required): The feature or problem to plan.
- `model` (string, optional): Specific model override.
- `effort` (`"low"` | `"medium"` | `"high"`, optional): Reasoning effort level.
- `cwd` (string, optional).

### `agy_review`
Performs an adversarial code review on git diffs or specific files.

**Parameters:**
- `review_target` (string, required): Target to review (e.g. `"git diff HEAD~1"`, `"src/routes/__root.tsx"`).
- `model` (string, optional): Specific model override.
- `effort` (`"low"` | `"medium"` | `"high"`, optional): Reasoning effort level.
- `guidelines` (string, optional): Specific rules or standards to enforce.

### `agy_status`
Checks binary path, CLI version, active model/effort defaults, and active configuration file.

### `agy_set_config`
Saves default model or effort preferences persistently.

**Parameters:**
- `model` (string, optional): Default model name.
- `effort` (`"low"` | `"medium"` | `"high"`, optional): Default effort level.
- `scope` (`"global"` | `"project"`, default: `"global"`): Config file target.

---

## Slash Commands

- `/agy <prompt>`: Delegate a task directly to Antigravity and view the results.
- `/agy-plan <task>`: Ask Antigravity to analyze the workspace and produce an implementation plan.
- `/agy-review [target]`: Run an adversarial review of recent git changes.

---

## Installation & Setup

### Automated (1-Command Install)

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/<tu-usuario>/claude-plugin-antigravity/main/install.ps1 | iex
```

**Linux / macOS (Bash):**
```bash
curl -fsSL https://raw.githubusercontent.com/<tu-usuario>/claude-plugin-antigravity/main/install.sh | bash
```

### Manual Install

Clone or copy this repository into `~/.claude/skills/antigravity`:
```bash
git clone https://github.com/<tu-usuario>/claude-plugin-antigravity.git "$HOME/.claude/skills/antigravity"
```

To reload plugins in an active Claude Code session:
```bash
/reload-plugins
```

To verify the installation:
```bash
claude plugin details antigravity@skills-dir
```
