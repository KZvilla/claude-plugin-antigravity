# Antigravity Claude Code Plugin

![Version](https://img.shields.io/badge/version-0.2.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20|%20Linux%20|%20macOS-lightgrey)
![Dependencies](https://img.shields.io/badge/dependencies-0-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-MIT-yellow)

A Claude Code plugin that integrates **Google Antigravity CLI (`agy`)** as an autonomous subagent and pair-programming partner.

Delegate deep reasoning, architectural planning, TDD implementation, and adversarial code reviews to Antigravity — running directly in your terminal, orchestrated by Claude.

---

## 📑 Table of Contents

- [Quick Start](#-quick-start)
- [Features](#-features)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation--setup)
- [Slash Commands](#-slash-commands)
- [MCP Tools Reference](#-mcp-tools-reference)
- [Permissions (ALLOW / DENY)](#-granular-permissions-system-allow--deny)
- [Model & Effort Configuration](#-model--reasoning-effort-configuration)
- [Telemetry (`/agy-usage`)](#-telemetry--usage-tracking-agy-usage)
- [Components](#-components)

---

## ⚡ Quick Start

**1. Install** (one command):

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.ps1 | iex
```

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.sh | bash
```

**2. Reload plugins** in your Claude Code session:

```text
/reload-plugins
```

**3. Try it:**

```text
/agy Analiza este proyecto y describí la arquitectura
```

```text
/agy-review
```

```text
/agy-usage
```

---

## 🚀 Features

| | Feature | Description |
|---|---------|-------------|
| 🤖 | **Autonomous Subagent** | Claude spins up Antigravity to execute complex tasks, multi-step refactors, and test suites |
| 🧠 | **Dual Model Intelligence** | Combines Claude with Gemini models (2.5 / 3.7 Pro & Flash) with configurable reasoning effort |
| 🛡️ | **Granular Permissions** | ALLOW / DENY capabilities, forbidden paths, forbidden commands, and sandbox isolation |
| ⏱️ | **Robust Timeouts** | Auto-injects `--print-timeout` (15m default, 20m for reviews) to prevent premature drops |
| 📊 | **Live Telemetry** | Token usage, thinking tokens, context caching savings, and context window saturation |
| 🔄 | **Multi-Turn Continuity** | `conversation_id` enables back-and-forth iteration with full workspace memory |
| ⚙️ | **Flexible Config** | Per-prompt, per-project JSON, or environment variables |
| ⚡ | **Zero Dependencies** | Lightweight stdio MCP server in pure Node.js |

---

## 📋 Prerequisites

| Requirement | Details |
|-------------|---------|
| **Node.js** | ≥ 18 (used to run the MCP server) |
| **Antigravity CLI** | `agy` or `agy.exe` installed and on your `PATH` ([Install guide](https://github.com/google-gemini/antigravity)) |
| **Claude Code** | Active Claude Code terminal session |
| **Google API Key** | Configured for Antigravity (`GEMINI_API_KEY` or `agy auth login`) |

---

## 🛠️ Slash Commands

| Command | Description |
|---------|-------------|
| `/agy <prompt>` | Delegate any task to Antigravity (read + write) |
| `/agy-plan <task>` | Generate an architectural plan (read-only, no file changes) |
| `/agy-review [target]` | Adversarial code review on staged/unstaged diffs or specific files |
| `/agy-usage` | Display token telemetry, context saturation, and quota health |

> **Tip:** You can also ask Claude naturally — *"Delegale a agy que revise los cambios del último commit"* — and it will pick the right tool automatically.

---

## 🔧 MCP Tools Reference

Six tools exposed via the MCP server:

| Tool | Mode | Default Timeout | Description |
|------|------|-----------------|-------------|
| `agy_run` | read + write | 15m | Execute a full subagent session with optional permission guardrails |
| `agy_plan` | read-only | 15m | Step-by-step architectural / implementation plan without modifying files |
| `agy_review` | read-only | 20m | Adversarial code review on git diffs or specific files |
| `agy_usage` | — | — | Session token telemetry, context window saturation, model limits, quota health |
| `agy_status` | — | — | Binary path, CLI version, active model/effort defaults, permission policies |
| `agy_set_config` | — | — | Persist model, effort, timeout, or permission preferences |

### `agy_run` — Full Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | *required* | Task instructions for Antigravity |
| `model` | `string` | `"gemini-3.7-flash"` | Gemini model to use |
| `effort` | `string` | `"high"` | Reasoning effort: `"low"`, `"medium"`, `"high"` |
| `mode` | `string` | `"accept-edits"` | `"accept-edits"` (read+write) or `"plan"` (read-only) |
| `permissions` | `object` | — | Granular ALLOW/DENY policies (see below) |
| `conversation_id` | `string` | — | Resume a previous conversation |
| `continue_session` | `boolean` | — | Continue the most recent conversation (`-c`) |
| `timeout_minutes` | `number` | `10` | Max runtime in minutes |
| `cwd` | `string` | — | Working directory |
| `dangerously_skip_permissions` | `boolean` | `true` | Run headlessly without interactive prompts |

---

## 🛡️ Granular Permissions System (ALLOW / DENY)

### Permission Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allow` | `string[]` | `["read", "edit", "commands", "network"]` | Capabilities explicitly allowed |
| `deny` | `string[]` | `[]` | Capabilities blocked. Denying `"edit"` forces `--mode plan` |
| `deny_paths` | `string[]` | `[".env*", "**/*.key", "**/*.pem"]` | Paths forbidden from access |
| `deny_commands` | `string[]` | `["git push*", "git reset --hard*", "npm publish*", "rm -rf /*"]` | Shell commands prohibited |
| `sandbox` | `boolean` | `false` | Enables native terminal sandbox (`--sandbox`) |

### Per-Call Example

```json
{
  "prompt": "Investigate the authentication bug in src/server/auth.ts",
  "permissions": {
    "deny": ["edit"],
    "deny_paths": [".env*", "config/secrets.json"],
    "sandbox": true
  }
}
```

### Persistent Defaults (`.claude/antigravity.json`)

```json
{
  "model": "gemini-3.7-flash",
  "effort": "high",
  "timeout_minutes": 15,
  "permissions": {
    "allow": ["read", "edit", "commands"],
    "deny": [],
    "deny_paths": [".env*", "**/*.key", "**/*.pem"],
    "deny_commands": ["git push*", "npm publish*", "rm -rf*"],
    "sandbox": false
  }
}
```

> **Scope:** Place in `~/.claude/antigravity.json` for global defaults, or `.claude/antigravity.json` in a project root for per-project overrides.

---

## ⚙️ Model & Reasoning Effort Configuration

### 1. Per Call / Prompt

Ask Claude naturally:

> *"Claude, delegale esta tarea a agy usando el modelo `gemini-2.5-pro` y effort `high`"*

| Parameter | Values |
|-----------|--------|
| `model` | `"gemini-3.7-flash"`, `"gemini-2.5-pro"` |
| `effort` | `"low"`, `"medium"`, `"high"` |

### 2. Persistent Defaults via Tool

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

## 📊 Telemetry & Usage Tracking (`/agy-usage`)

Antigravity automatically tracks token consumption, context caching efficiency, and context window saturation across all subagent calls.

```text
/agy-usage
```

To reset session counters:

```text
/agy-usage reset
```

### Metrics Reported

| Category | Details |
|----------|---------|
| **Model Specs** | Context window (1M Flash / 2M Pro), max output tokens, reasoning effort |
| **Session Totals** | Delegated calls, input/output/thinking tokens, cache reuse, total duration |
| **Last Invocation** | Tokens consumed, context saturation bar (`[████████░░░░] 62.4%`), conversation ID |
| **Quota Health** | `HEALTHY` · `RATE_LIMITED` · `QUOTA_EXCEEDED` |

---

## 📦 Components

| Component | Path | Description |
|-----------|------|-------------|
| **MCP Server** | `mcp-server/index.js` | Zero-dependency JSON-RPC stdio server (6 tools) |
| **Subagent** | `agents/antigravity.md` | Autonomous subagent definition (`antigravity:Antigravity`) |
| **Skill** | `skills/antigravity/SKILL.md` | Context-aware delegation guidelines |
| **Commands** | `commands/agy.md` | `/agy <prompt>` |
| | `commands/agy-plan.md` | `/agy-plan <task>` |
| | `commands/agy-review.md` | `/agy-review [target]` |
| | `commands/agy-usage.md` | `/agy-usage` |
| **Installers** | `install.ps1` / `install.sh` | 1-command install for all platforms |

---

## 🔧 Installation & Setup

### Automated (1-Command)

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.ps1 | iex
```

**Linux / macOS (Bash):**
```bash
curl -fsSL https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.sh | bash
```

### Manual Install

```bash
git clone https://github.com/KZvilla/claude-plugin-antigravity.git "$HOME/.claude/skills/antigravity"
```

### Post-Install

```bash
# Reload in an active Claude Code session
/reload-plugins

# Verify installation
claude plugin details antigravity@skills-dir
```

---

## 📄 License

MIT
