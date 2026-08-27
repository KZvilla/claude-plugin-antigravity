# Antigravity Claude Code Plugin

A Claude Code plugin that integrates **Google Antigravity CLI (`agy`)** as an autonomous subagent and pair-programming partner.

With this plugin, Claude Code can delegate deep reasoning, architectural planning, TDD implementation, and adversarial code reviews to Antigravity running directly in your terminal.

---

## Features

- 🤖 **Autonomous Subagent**: Claude can spin up Antigravity (`agy.exe`) to execute complex tasks, multi-step refactors, and test suites.
- 🧠 **Dual Model Intelligence**: Combines Anthropic's Claude with Google's Gemini models (Gemini 2.5 / 3.7 Pro & Flash) with configurable reasoning effort (`low`, `medium`, `high`).
- 🛡️ **Granular ALLOW / DENY Permissions**: Define exact capabilities, forbidden file paths (e.g. `.env*`, `*.key`), forbidden commands (e.g. `git push*`, `npm publish*`), and sandbox isolation.
- ⏱️ **Robust Timeout Handling**: Automatic injection of `--print-timeout` into Antigravity CLI (15m default, 20m for reviews), preventing premature drops during deep reasoning.
- 📊 **Model & Quota Telemetry**: Live tracking of token usage, deep thinking tokens, context caching savings, and context window saturation via `/agy-usage`.
- 🔄 **Multi-Turn Continuity**: Sessions capture `conversation_id`, enabling back-and-forth iteration where Antigravity remembers all previous conversation turns and workspace context.
- ⚙️ **Flexible Configuration**: Set model, effort, and permissions dynamically per prompt, persistently in JSON config files, or via environment variables.
- ⚡ **Zero External Dependencies**: Lightweight stdio MCP server implemented directly in standard Node.js.
- 🛠️ **Slash Commands**: Quick terminal commands (`/agy`, `/agy-plan`, `/agy-review`, `/agy-usage`).

---

## Components

| Component | Path | Description |
|-----------|------|-------------|
| **MCP Server** | `mcp-server/index.js` | Zero-dependency MCP JSON-RPC server exposing `agy_run`, `agy_plan`, `agy_review`, `agy_usage`, `agy_status`, `agy_set_config` |
| **Subagent** | `agents/antigravity.md` | Autonomous subagent definition for Claude Code (`antigravity:Antigravity`) |
| **Skill** | `skills/antigravity/SKILL.md` | Context-aware guidelines on when and how to delegate to Antigravity |
| **Commands** | `commands/agy.md` | Slash command `/agy <prompt>` |
| | `commands/agy-plan.md` | Slash command `/agy-plan <task>` |
| | `commands/agy-review.md` | Slash command `/agy-review [target]` |
| | `commands/agy-usage.md` | Slash command `/agy-usage` |
| **Installers** | `install.ps1` / `install.sh` | 1-step installation scripts for Windows, Linux, and macOS |

---

## 📊 Telemetry & Usage Tracking (`/agy-usage`)

Antigravity automatically tracks token consumption, context caching efficiency, and context window saturation across all subagent calls:

Run in terminal:
```text
/agy-usage
```
*(Or `/agy_usage`)*

To reset the session counters:
```text
/agy-usage reset
```

### Metrics Reported:
- **Active Model Specs:** Context window capacity (1M for Flash, 2M for Pro), maximum output tokens, and reasoning effort.
- **Session Cumulative Telemetry:** Total delegated calls, input tokens, output tokens, thinking/reasoning tokens, and context caching savings.
- **Last Task Breakdown:** Tokens consumed, duration, percentage of context window used (`[████████░░░░] 62.4%`), and conversation ID.
- **API / Quota Health:** Real-time health indicator (`HEALTHY` vs `RATE_LIMITED / QUOTA EXCEEDED`).

---

## 🛡️ Granular Permissions System (ALLOW / DENY)

The plugin features a comprehensive permission enforcement layer:

### Permission Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allow` | `string[]` | `["read", "edit", "commands", "network"]` | Capabilities explicitly allowed. |
| `deny` | `string[]` | `[]` | Capabilities explicitly blocked. Denying `"edit"` forces strict read-only execution (`--mode plan`). Denying `"commands"` forbids all terminal command execution. |
| `deny_paths` | `string[]` | `[".env*", "**/*.key", "**/*.pem"]` | Paths Antigravity is strictly forbidden from reading, modifying, or referencing. |
| `deny_commands` | `string[]` | `["git push*", "git reset --hard*", "npm publish*", "rm -rf /*"]` | Shell command patterns strictly prohibited from being run. |
| `sandbox` | `boolean` | `false` | Enables Antigravity's native terminal sandbox isolation (`--sandbox`). |

### 1. In Per-Call Invocations
Pass custom permissions for a specific task:
```json
{
  "prompt": "Investigate the authentication bug in src/server/auth.ts and propose fixes.",
  "permissions": {
    "deny": ["edit"],
    "deny_paths": [".env*", "config/secrets.json"],
    "sandbox": true
  }
}
```

### 2. Persistent Defaults in Config File
Set default permissions globally or per-project in `.claude/antigravity.json`:
```json
{
  "model": "gemini-3.7-flash",
  "effort": "high",
  "timeout_minutes": 15,
  "permissions": {
    "allow": ["read", "edit", "commands"],
    "deny": [],
    "deny_paths": [".env*", "**/*.key", "**/*.pem", "production.sqlite"],
    "deny_commands": ["git push*", "npm publish*", "rm -rf*"],
    "sandbox": false
  }
}
```

---

## ⚙️ Model & Reasoning Effort Configuration

### 1. Per Call / Prompt
Specify model or effort directly in your instruction to Claude:
> *"Claude, delegale esta tarea a agy usando el modelo `gemini-2.5-pro` y effort `high`"*

- `model`: e.g. `"gemini-3.7-flash"`, `"gemini-2.5-pro"`
- `effort`: `"low"`, `"medium"`, or `"high"`

### 2. Persistent Defaults via Tool
Ask Claude:
> *"Configurá agy por defecto con modelo gemini-3.7-flash y effort high"*

### 3. Environment Variables
```bash
# Windows PowerShell
$env:AGY_MODEL = "gemini-3.7-flash"
$env:AGY_EFFORT = "high"
$env:AGY_TIMEOUT_MINUTES = "20"

# Bash / Zsh
export AGY_MODEL="gemini-3.7-flash"
export AGY_EFFORT="high"
export AGY_TIMEOUT_MINUTES="20"
```

---

## MCP Tools Reference

### `agy_run`
Executes an Antigravity subagent session with optional permission guardrails and configurable timeouts.

### `agy_plan`
Generates a step-by-step architectural and implementation plan without modifying files (guaranteed read-only mode).

### `agy_review`
Performs an adversarial code review on git diffs or specific files (guaranteed read-only mode, 20m default timeout).

### `agy_usage`
Displays session token telemetry (input, output, thinking, cache read), context window saturation, active model limits, and quota health status. Supports `reset: true` to clear counters.

### `agy_status`
Checks binary path, CLI version, active model/effort defaults, active ALLOW/DENY permission policies, and active configuration file.

### `agy_set_config`
Saves default model, effort, timeout, or permission preferences persistently.

---

## Installation & Setup

### Automated (1-Command Install)

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.ps1 | iex
```

**Linux / macOS (Bash):**
```bash
curl -fsSL https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.sh | bash
```

### Manual Install

Clone or copy this repository into `~/.claude/skills/antigravity`:
```bash
git clone https://github.com/KZvilla/claude-plugin-antigravity.git "$HOME/.claude/skills/antigravity"
```

To reload plugins in an active Claude Code session:
```bash
/reload-plugins
```

To verify the installation:
```bash
claude plugin details antigravity@skills-dir
```
