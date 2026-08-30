# Antigravity Claude Code Plugin

![Version](https://img.shields.io/badge/version-0.3.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20|%20Linux%20|%20macOS-lightgrey)
![Dependencies](https://img.shields.io/badge/dependencies-0-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![License](https://img.shields.io/badge/license-MIT-yellow)

A Claude Code plugin that integrates **Google Antigravity CLI (`agy`)** as an autonomous subagent and pair-programming partner.

Delegate deep reasoning, architectural planning, TDD implementation, adversarial code reviews, session documentation, and cited web research to Antigravity — running directly in your terminal, orchestrated by Claude.

---

## 📑 Table of Contents

- [Quick Start](#-quick-start)
- [Features](#-features)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation--setup)
- [Slash Commands](#-slash-commands)
- [MCP Tools Reference](#-mcp-tools-reference)
- [Voice Checkpoint Narration](#-voice-checkpoint-narration-agy-narrate)
- [Session Summary & Anti-Compaction](#-session-summary--anti-compaction-agy-summary)
- [Permissions (ALLOW / DENY)](#-granular-permissions-system-allow--deny)
- [Model & Effort Configuration](#-model--reasoning-effort-configuration)
- [Telemetry (`/agy-usage`)](#-telemetry--usage-tracking-agy-usage)
- [Components](#-components)
- [Documentation Hub (`docs/`)](docs/README.md)

---

## ⚡ Quick Start

**1. Install** (one command):

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.ps1 | iex
```

**Linux / macOS (Bash):**
```bash
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
/agy-summary
```

```text
/agy-narrate
```

```text
/agy-research "Latest patterns for Claude Code plugins in 2026"
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
| 🎙️ | **Voice Checkpoint Narration** | Zero-Claude-token spoken status updates via Voicebox TTS with automatic profile fallback |
| 📋 | **Anti-Compaction Session Summary** | Analyzes raw JSONL session logs with Gemini (1M-2M context) to generate persistent, structured Markdown docs before context degrades |
| 🌐 | **Cited Web Research** | Leverages Antigravity's native web search and synthesis capabilities that Claude Code lacks out of the box |
| 🛡️ | **Granular Permissions** | ALLOW / DENY capabilities, forbidden paths, forbidden commands, and sandbox isolation |
| ⏱️ | **Robust Timeouts** | Auto-injects `--print-timeout` (15m default, 20m for reviews, 25m for audits) to prevent premature drops |
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
| `/agy-audit [target]` | Heavyweight, evidence-based adversarial audit (Mode 1: Code vs Plan, Mode 2: Plan vs Repo) |
| `/agy-summary [focus]` | Generate structured session summary from Claude Code's raw JSONL logs (`full`, `decisions`, `changes`, `debugging`) |
| `/agy-narrate [voice/lang]` | Narrate spoken voice summary of the latest task/checkpoint via Voicebox TTS (`emily`, `diego`, `es`, `en`) |
| `/agy-narrate-voices [lang]` | List all installed Voicebox voice profiles, languages, roles, and service health |
| `/agy-research <topic>` | Conduct deep web research with cited sources and structured insights |
| `/agy-usage` | Display token telemetry, context saturation, and quota health |

> **Tip:** You can also ask Claude naturally — *"Delegale a agy que resuma esta sesión"*, *"¿Qué voces tengo disponibles?"* o *"Cuando termines, ejecuta la narración con Diego"* — and it will pick the right tool automatically.

---

## 🔧 MCP Tools Reference

Ten tools exposed via the MCP server:

| Tool | Mode | Default Timeout | Description |
|------|------|-----------------|-------------|
| `agy_run` | read + write | 15m | Execute a full subagent session with optional permission guardrails |
| `agy_plan` | read-only | 15m | Step-by-step architectural / implementation plan without modifying files |
| `agy_review` | read-only | 20m | Adversarial code review on git diffs or specific files |
| `agy_audit` | read-only | 25m | Rigorous adversarial audit with severity rubric (BLOCKER, MAJOR, MINOR) |
| `agy_session_summary` | read-only | 15m | Parse session JSONL and generate structured summary doc with Gemini |
| `agy_narrate` | audio TTS | 3m | Spoken audio update of latest checkpoint via Voicebox (zero Claude tokens) |
| `agy_narrate_voices` | read-only | — | List installed Voicebox voice profiles, languages, roles, and GPU health |
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

**Windows (PowerShell):**
```powershell
$env:AGY_MODEL = "gemini-3.7-flash"
$env:AGY_EFFORT = "high"
$env:AGY_TIMEOUT_MINUTES = "20"
```

**Linux / macOS (Bash / Zsh):**
```bash
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

## 📋 Session Summary & Anti-Compaction (`/agy-summary`)

Claude Code's automatic context compaction can be lossy — intermediate decisions, edge cases, and reasoning get dropped as sessions grow. 

Antigravity solves this by reading the raw session JSONL log from `~/.claude/projects/`, pre-processing and stripping noise in Node.js, and feeding the structured transcript to **Gemini's 1M-2M token context window** to generate a persistent Markdown summary with YAML frontmatter.

```text
/agy-summary
```

You can also target specific areas:
- `/agy-summary decisions` — focus on architectural rationale and choices
- `/agy-summary changes` — focus on modified files and code diffs
- `/agy-summary debugging` — focus on errors, root causes, and fixes

Summaries are automatically saved to `~/.claude/session-summaries/<YYYY-MM-DD>-<session-id>.md`.

---

## 🎙️ Voice Checkpoint Narration (`/agy-narrate`)

Narrate a spoken audio status update upon completing a task or checkpoint via **Voicebox Text-To-Speech (TTS)**.

### Zero-Claude-Token Architecture
Claude **does not** generate or summarize the text in its context window. Instead:
1. Claude simply invokes `/agy-narrate` (or the `agy_narrate` tool).
2. The plugin locates Claude Code's session log (`.jsonl`), extracts the latest task checkpoint (user goal, modified files, and final test execution status).
3. The plugin invokes Gemini CLI (`agy`) with `--effort low` to draft a concise 2-3 sentence conversational spoken script in ~1-2 seconds (using Gemini quota, **0 Claude tokens**).
4. The plugin sends the text directly to Voicebox HTTP (`POST /speak`), playing the audio out loud on your speakers.

### Usage

```text
/agy-narrate
```

With specific voice or language preference:
```text
/agy-narrate emily       # English narration with Emily voice
/agy-narrate diego       # Spanish narration with Diego Alvarez voice
/agy-narrate en          # English narration (defaults to Emily)
/agy-narrate es          # Spanish narration (defaults to Diego Alvarez)
```

Or ask Claude conversationally:
> *"Cuando termines de implementar las pruebas, ejecuta la narración con Diego"*
> *"Narra el último checkpoint con Emily en inglés"*

### Voicebox Detection & Automatic Fallback Hierarchy
The plugin detects available voices installed in your local Voicebox (`http://127.0.0.1:17493` by default):

- **Spanish (`es`)**:
  - Preferred: `Diego Alvarez`
  - Fallback: `Isabel` $\rightarrow$ `Ono Anna` $\rightarrow$ First installed Spanish profile
- **English (`en`)**:
  - Preferred: `Emily`
  - Fallback: `Aria` $\rightarrow$ `Aiden` $\rightarrow$ First installed English profile

If Voicebox is offline or unreachable, the plugin returns a friendly diagnostic notification without failing your development session.

### 🎭 Enriquecer la Personalidad desde Voicebox (Sin tocar código)

La naturalidad y el estilo de la narración en personaje se adaptan automáticamente según cómo completes la ficha de cada voz en la interfaz de Voicebox:

- **`description`**: Describe la identidad, acento o tono (ej: *"Comediante uruguayo de internet con voz rasposa"* o *"Locutor profesional español"*).
- **`personality`**: Define modismos, actitud y muletillas (ej: *"Humor bizarro e irreverente, usa modismos como '¡Sapeee!', 'más bien loquita', festejando con euforia si los tests pasaron"*).

Gemini (`agy`) lee estos campos dinámicamente en tiempo real desde la API de Voicebox. Al activar el modo personaje (con `/agy-narrate <voz> personality` o pidiéndoselo a Claude), el guión adoptará ese personaje manteniendo siempre la veracidad técnica sobre los archivos y tests del proyecto.

---

## 🌐 Deep Web Research (`/agy-research`)

Delegate deep web research and live doc searches directly to Antigravity, which leverages Gemini's native search tools and Vertex AI:

```text
/agy-research "Best practices for Claude Code hooks and lifecycle events 2026"
```

Returns a structured report with an Executive Summary, Key Findings, Cited Source URLs, and direct relevance to your current project.

---

## 📦 Components

| Component | Path | Description |
|-----------|------|-------------|
| **MCP Server** | `mcp-server/index.js` | Zero-dependency JSON-RPC stdio server (10 tools) |
| **Subagent** | `agents/antigravity.md` | Autonomous subagent definition (`antigravity:Antigravity`) |
| **Skills** | `skills/antigravity/SKILL.md` | Context-aware delegation guidelines |
| | `skills/adversarial-review/SKILL.md` | Skeptical, evidence-based audit guidelines |
| | `skills/session-summary/SKILL.md` | Session summary & anti-compaction skill |
| **Commands** | `commands/agy.md` | `/agy <prompt>` |
| | `commands/agy-plan.md` | `/agy-plan <task>` |
| | `commands/agy-review.md` | `/agy-review [target]` |
| | `commands/agy-audit.md` | `/agy-audit [target]` |
| | `commands/agy-summary.md` | `/agy-summary [focus]` |
| | `commands/agy-narrate.md` | `/agy-narrate [voice/lang]` |
| | `commands/agy-narrate-voices.md` | `/agy-narrate-voices [lang]` |
| | `commands/agy-research.md` | `/agy-research <topic>` |
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

In an active Claude Code session:
```text
/reload-plugins
```

Verify installation in your terminal:
```bash
claude plugin details antigravity@skills-dir
```

---

## 📚 Documentation Hub

Explore the in-depth technical documentation in the [`docs/`](docs/README.md) directory:

- **[Architecture](docs/architecture/README.md):** MCP server design, stdio transport, permissions, and security.
- **[Integrations](docs/integrations/README.md):** External bridges such as the [Telegram Bridge](docs/integrations/telegram-bridge.md) ($0 cost, CGNAT-ready).
- **[Future Implementations](docs/future-implementations/README.md):** Upcoming roadmap features like the [Real-Time Voice Mode](docs/future-implementations/voice-chat-architecture.md).
- **[Old Implementations / History](docs/old-implementations/README.md):** Historical milestone logs like the [Foundational Session Summary](docs/old-implementations/session-summary-2026-08-27.md).

---

## 📄 License

MIT
