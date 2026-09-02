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
- [Voice Checkpoint Narration](#-voice-checkpoint-narration-lagrangenarrate)
- [Real-Time Voice Mode (`voice-chat/`)](#-real-time-voice-mode-voice-chat)
- [Session Summary & Anti-Compaction](#-session-summary--anti-compaction-lagrangesummary)
- [Permissions (ALLOW / DENY)](#-granular-permissions-system-allow--deny)
- [Model & Effort Configuration](#-model--reasoning-effort-configuration)
- [Telemetry (`/lagrange:usage`)](#-telemetry--usage-tracking-lagrangeusage)
- [Components](#-components)

---

## ⚡ Quick Start

**1. Install** - two commands inside Claude Code, any platform:

```text
/plugin marketplace add KZvilla/claude-plugin-antigravity
/plugin install lagrange@kzvilla-lagrange
```

**2. Restart Claude Code.** `/reload-plugins` picks up commands, agents and
skills, but the MCP tool schemas of a running session are the ones registered
at startup - a restart is what makes `agy_run` and friends appear.

**3. Try it:**

```text
/lagrange:run Analiza este proyecto y describí la arquitectura
```

```text
/lagrange:review
```

```text
/lagrange:summary
```

```text
/lagrange:narrate
```

```text
/lagrange:research "Latest patterns for Claude Code plugins in 2026"
```

```text
/lagrange:usage
```

---

## 🚀 Features

| | Feature | Description |
|---|---------|-------------|
| 🤖 | **Autonomous Subagent** | Claude spins up Antigravity to execute complex tasks, multi-step refactors, and test suites |
| 🧠 | **Dual Model Intelligence** | Combines Claude with Gemini models (3.8 / 3.7 Flash, 3.1 Pro) with configurable reasoning effort |
| 🎙️ | **Voice Checkpoint Narration** | Zero-Claude-token spoken status updates via Voicebox TTS with automatic profile fallback |
| 🗣️ | **Real-Time Voice Mode** | Full-duplex spoken conversation with barge-in, mic capture, and Silero VAD (`voice-chat/`) — zero-cloud audio via a local Voicebox TTS/STT engine |
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
| **Antigravity CLI** | `agy` or `agy.exe` installed and on your `PATH` ([Install guide](https://antigravity.google/cli)) |
| **Claude Code** | Active Claude Code terminal session |
| **Google API Key** | Configured for Antigravity (`GEMINI_API_KEY` or `agy auth login`) |

---

## 🛠️ Slash Commands

| Command | Description |
|---------|-------------|
| `/lagrange:run <prompt>` | Delegate any task to Antigravity (read + write) |
| `/lagrange:plan <task>` | Generate an architectural plan (read-only, no file changes) |
| `/lagrange:review [target]` | Adversarial code review on staged/unstaged diffs or specific files |
| `/lagrange:audit [target]` | Heavyweight, evidence-based adversarial audit (Mode 1: Code vs Plan, Mode 2: Plan vs Repo) |
| `/lagrange:summary [focus]` | Generate structured session summary from Claude Code's raw JSONL logs (`full`, `decisions`, `changes`, `debugging`) |
| `/lagrange:narrate [voice/lang]` | Narrate spoken voice summary of the latest task/checkpoint via Voicebox TTS (`emily`, `diego`, `es`, `en`) |
| `/lagrange:voices [lang]` | List all installed Voicebox voice profiles, languages, roles, and service health |
| `/lagrange:research <topic>` | Conduct deep web research with cited sources and structured insights |
| `/lagrange:usage` | Display token telemetry, context saturation, and quota health |

> **Tip:** You can also ask Claude naturally — *"Delegale a agy que resuma esta sesión"*, *"¿Qué voces tengo disponibles?"* o *"Cuando termines, ejecuta la narración con Diego"* — and it will pick the right tool automatically.

---

## 🔧 MCP Tools Reference

Fifteen tools exposed via the MCP server — twelve `agy_*` tools plus three `telegram_*` bridge tools:

| Tool | Mode | Default Timeout | Description |
|------|------|-----------------|-------------|
| `agy_run` | read + write | 15m | Execute a full subagent session with optional permission guardrails |
| `agy_plan` | read-only | 15m | Step-by-step architectural / implementation plan without modifying files |
| `agy_review` | read-only | 20m | Adversarial code review on git diffs or specific files |
| `agy_audit` | read-only | 25m | Rigorous adversarial audit with severity rubric (BLOCKER, MAJOR, MINOR) |
| `agy_research` | read-only | 20m | Deep web research with cited sources — requires the `network` capability, errors out if denied |
| `agy_session_summary` | read-only | 15m | Parse session JSONL and generate structured summary doc with Gemini |
| `agy_voice_stream` | conversational | persistent (no fixed timeout) | Manage a long-lived, streaming `agy.exe` process for low-latency voice chat ("Modo Charla") — the backend behind `voice-chat/` |
| `agy_narrate` | audio TTS | 3m | Spoken audio update of latest checkpoint via Voicebox (zero Claude tokens) |
| `agy_narrate_voices` | read-only | — | List installed Voicebox voice profiles, languages, roles, and GPU health |
| `agy_usage` | — | — | Session token telemetry, context window saturation, model limits, quota health |
| `agy_status` | — | — | Binary path, CLI version, active model/effort defaults, permission policies |
| `agy_set_config` | — | — | Persist model, effort, timeout, or permission preferences |
| `telegram_notify` | outbound | — | Push a notification (with optional file attachment) to your phone — see [Telegram Bridge Setup](#-telegram-bridge-setup-manual--never-automated) |
| `telegram_ask` | Human-in-the-Loop | 5m | Ask a question with tappable choice buttons and block until you answer on your phone |
| `telegram_send_voice` | outbound audio | — | Send an audio file (or the latest Voicebox generation) as a native voice note |

### `agy_run` — Full Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | *required* | Task instructions for Antigravity |
| `model` | `string` | `"gemini-3.8-flash"` | Gemini model to use |
| `effort` | `string` | `"high"` | Reasoning effort: `"low"`, `"medium"`, `"high"` |
| `mode` | `string` | `"accept-edits"` | `"accept-edits"` (read+write) or `"plan"` (read-only) |
| `permissions` | `object` | — | Granular ALLOW/DENY policies (see below) |
| `conversation_id` | `string` | — | Resume a previous conversation |
| `continue_session` | `boolean` | — | Continue the most recent conversation (`-c`) |
| `timeout_minutes` | `number` | `15` | Max runtime in minutes |
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

Denying `"network"` blocks web search and URL fetching, and makes `agy_research` fail with an explicit error instead of answering from memory.

**Scope:** the policy applies to every delegating tool — `agy_run` plus the read-only ones (`agy_plan`, `agy_review`, `agy_audit`, `agy_research`, `agy_session_summary`). The read-only tools are locked to `--mode plan`, so `edit` is denied there regardless of policy, but `commands`, `network`, `deny_paths`, `deny_commands` and `sandbox` are enforced — which matters, because plan mode by itself does *not* stop a subagent from reading `.env` or running `git push`. Each tool's output footer prints the policy it actually ran under.

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
  "model": "gemini-3.8-flash",
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

> *"Claude, delegale esta tarea a agy usando el modelo `gemini-3.1-pro` y effort `high`"*

| Parameter | Values |
|-----------|--------|
| `model` | `"gemini-3.8-flash"`, `"gemini-3.1-pro"` |
| `effort` | `"low"`, `"medium"`, `"high"` |

### 2. Persistent Defaults via Tool

> *"Configurá agy por defecto con modelo gemini-3.8-flash y effort high"*

### 3. Environment Variables

**Windows (PowerShell):**
```powershell
$env:AGY_MODEL = "gemini-3.8-flash"
$env:AGY_EFFORT = "high"
$env:AGY_TIMEOUT_MINUTES = "20"
```

**Linux / macOS (Bash / Zsh):**
```bash
export AGY_MODEL="gemini-3.8-flash"
export AGY_EFFORT="high"
export AGY_TIMEOUT_MINUTES="20"
```

---

## 📊 Telemetry & Usage Tracking (`/lagrange:usage`)

Antigravity automatically tracks token consumption, context caching efficiency, and context window saturation across all subagent calls.

```text
/lagrange:usage
```

To reset session counters:

```text
/lagrange:usage reset
```

### Metrics Reported

| Category | Details |
|----------|---------|
| **Model Specs** | Context window (1M Flash / 2M Pro), max output tokens, reasoning effort |
| **Session Totals** | Delegated calls, input/output/thinking tokens, cache reuse, total duration |
| **Last Invocation** | Tokens consumed, context saturation bar (`[████████░░░░] 62.4%`), conversation ID |
| **Quota Health** | `HEALTHY` · `RATE_LIMITED` · `QUOTA_EXCEEDED` |

---

## 📋 Session Summary & Anti-Compaction (`/lagrange:summary`)

Claude Code's automatic context compaction can be lossy — intermediate decisions, edge cases, and reasoning get dropped as sessions grow. 

Antigravity solves this by reading the raw session JSONL log from `~/.claude/projects/`, pre-processing and stripping noise in Node.js, and feeding the structured transcript to **Gemini's 1M-2M token context window** to generate a persistent Markdown summary with YAML frontmatter.

```text
/lagrange:summary
```

You can also target specific areas:
- `/lagrange:summary decisions` — focus on architectural rationale and choices
- `/lagrange:summary changes` — focus on modified files and code diffs
- `/lagrange:summary debugging` — focus on errors, root causes, and fixes

Summaries are automatically saved to `~/.claude/session-summaries/<YYYY-MM-DD>-<session-id>.md`.

---

## 🎙️ Voice Checkpoint Narration (`/lagrange:narrate`)

Narrate a spoken audio status update upon completing a task or checkpoint via **Voicebox Text-To-Speech (TTS)**.

### Zero-Claude-Token Architecture
Claude **does not** generate or summarize the text in its context window. Instead:
1. Claude simply invokes `/lagrange:narrate` (or the `agy_narrate` tool).
2. The plugin locates Claude Code's session log (`.jsonl`), extracts the latest task checkpoint (user goal, modified files, and final test execution status).
3. The plugin invokes Gemini CLI (`agy`) with `--effort low` to draft a concise 2-3 sentence conversational spoken script in ~1-2 seconds (using Gemini quota, **0 Claude tokens**).
4. The plugin sends the text to Voicebox HTTP (`POST /generate`), which synthesizes a `.wav` silently, and then plays that file with the native OS audio player. (It deliberately avoids `POST /speak` — letting Voicebox do its own playback triggers a double-playback bug.)

Running `/lagrange:narrate` plays the result on your speakers. When `agy_narrate` is called programmatically, local playback is off by default (`local_playback: false`) so background narration doesn't startle anyone — it still reaches your phone if the Telegram bridge is configured.

### Usage

```text
/lagrange:narrate
```

With specific voice or language preference:
```text
/lagrange:narrate emily       # English narration with Emily voice
/lagrange:narrate diego       # Spanish narration with Diego Alvarez voice
/lagrange:narrate en          # English narration (defaults to Emily)
/lagrange:narrate es          # Spanish narration (defaults to Diego Alvarez)
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

Gemini (`agy`) lee estos campos dinámicamente en tiempo real desde la API de Voicebox. Al activar el modo personaje (con `/lagrange:narrate <voz> personality` o pidiéndoselo a Claude), el guión adoptará ese personaje manteniendo siempre la veracidad técnica sobre los archivos y tests del proyecto.

---

## 🗣️ Real-Time Voice Mode (`voice-chat/`)

Full-duplex spoken conversation with Antigravity — not a Claude Code slash command, since a persistent audio loop with real-time barge-in doesn't fit Claude Code's request/response tool-call model. Instead, `voice-chat/*.py` are standalone companion scripts that talk to the same MCP server (`agy_voice_stream` — see MCP Tools Reference above) as a client over the same stdio JSON-RPC protocol Claude Code itself uses, keeping one long-lived `agy.exe` process alive across turns instead of paying a cold start per message.

- `voice-chat/text_loop.py` — console input, zero pip dependencies (stdlib only).
- `voice-chat/voice_loop.py` — real microphone input via Silero VAD, with real barge-in: the instant it detects you starting to speak, it cuts playback and cancels any in-flight Voicebox synthesis.

Both require a local Voicebox instance reachable at `http://127.0.0.1:17493` (or `VOICEBOX_URL`) for TTS/STT; `voice_loop.py` additionally needs `pip install -r voice-chat/requirements.txt` (`sounddevice`, `silero-vad`, `numpy`).

```bash
# Console-only, zero extra dependencies
python voice-chat/text_loop.py --voice "Diego Alvarez" --language es

# Real microphone + VAD
python voice-chat/voice_loop.py --voice "Diego Alvarez" --language es --stt-model turbo
```

Run either script with `--help` for the full flag list (TTS engine/model overrides, VAD sensitivity, input device selection, VRAM unload-on-exit).

---

## 🌐 Deep Web Research (`/lagrange:research`)

Delegate deep web research and live doc searches directly to Antigravity, which leverages Gemini's native search tools and Vertex AI:

```text
/lagrange:research "Best practices for Claude Code hooks and lifecycle events 2026"
```

Returns a structured report with an Executive Summary, Key Findings, Cited Source URLs, and direct relevance to your current project.

Backed by the `agy_research` MCP tool, which is read-only and requires the `network` capability. If `network` is denied (or absent from `allow`), the tool returns an explicit error rather than producing a report from the model's memory — a research report with citations it never actually fetched is worse than no report.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topic` | `string` | *required* | The research topic or question |
| `project_context` | `string` | — | How this relates to your project, to focus the Relevance section |
| `recency` | `string` | — | Source recency constraint (e.g. `"past 6 months"`); older sources get flagged |
| `conversation_id` | `string` | — | Resume a research thread for follow-ups without re-running the search |
| `permissions` | `object` | — | Per-call policy override (read-only regardless) |

---

## 📦 Components

| Component | Path | Description |
|-----------|------|-------------|
| **MCP Server** | `mcp-server/index.js` | Zero-dependency JSON-RPC stdio server (15 tools) |
| | `mcp-server/lib/sentence-chunker.js` | Groups streamed `text_delta` fragments into complete sentences for TTS |
| **Subagent** | `agents/antigravity.md` | Autonomous subagent definition (`antigravity:Antigravity`) |
| **Skills** | `skills/agy-cli/SKILL.md` | Context-aware delegation guidelines |
| | `skills/adversarial-review/SKILL.md` | Skeptical, evidence-based audit guidelines |
| | `skills/session-summary/SKILL.md` | Session summary & anti-compaction skill |
| **Commands** | `commands/run.md` | `/lagrange:run <prompt>` |
| | `commands/plan.md` | `/lagrange:plan <task>` |
| | `commands/review.md` | `/lagrange:review [target]` |
| | `commands/audit.md` | `/lagrange:audit [target]` |
| | `commands/summary.md` | `/lagrange:summary [focus]` |
| | `commands/narrate.md` | `/lagrange:narrate [voice/lang]` |
| | `commands/voices.md` | `/lagrange:voices [lang]` |
| | `commands/research.md` | `/lagrange:research <topic>` |
| | `commands/usage.md` | `/lagrange:usage` |
| **Tests** | `test/` | Dependency-free suites that drive the MCP server over real stdio with `agy` stubbed — `npm test` |
| **Voice Chat** | `voice-chat/text_loop.py` / `voice_loop.py` | Real-Time Voice Mode companion scripts (console / real mic + VAD) |
| **Distribution** | `.claude-plugin/marketplace.json` | Marketplace manifest - the recommended install channel |
| | `scripts/stamp-release.mjs` | Pins the marketplace entry to the release tag's commit sha (`npm run release:stamp`) |

---

## 🔧 Installation & Setup

### Marketplace (recommended)

Inside a Claude Code session:

```text
/plugin marketplace add KZvilla/claude-plugin-antigravity
/plugin install lagrange@kzvilla-lagrange
```

Or from a terminal:

```bash
claude plugin marketplace add KZvilla/claude-plugin-antigravity
claude plugin install lagrange@kzvilla-lagrange
```

This is the managed path: enable/disable, user vs. project scope, a visible
version, and updates through `claude plugin marketplace update` instead of a
`git reset --hard` over your working copy.

### Migrating from a script install

`install.ps1` and `install.sh` were removed in 0.6.0. They cloned into
`~/.claude/skills/antigravity` and updated with `git reset --hard`, which
overwrote local changes and gave no version to point at. The marketplace does
the same job with a pinned `sha`, real versions and a managed lifecycle.

If you installed with them, remove the old clone: the two channels install to
different places, so keeping both means Claude Code loads the plugin **twice**
- duplicate commands, duplicate MCP tools.

The scripts only ever cloned into `~/.claude/skills/antigravity`; they wrote
nothing to `settings.json` and registered no MCP server, so removing that
directory is the whole uninstall. Two things deserve care, and both snippets
below handle them: the `.env` inside it is git-ignored and exists nowhere else,
and on Windows the bridge daemon may be a scheduled task pointing into the
directory you are about to delete.

**Linux / macOS:**
```bash
dir="$HOME/.claude/skills/antigravity"
if [ -d "$dir" ]; then
  pkill -f "$dir/telegram-bridge/bot.js" 2>/dev/null
  [ -f "$dir/.env" ] && cp "$dir/.env" "$HOME/antigravity.env.bak"
  rm -rf "$dir"
  echo "Uninstalled. Copy of .env kept at ~/antigravity.env.bak"
else
  echo "No script install found."
fi
```

**Windows (PowerShell):**
```powershell
$dir = Join-Path $env:USERPROFILE '.claude\skills\antigravity'
if (Test-Path $dir) {
    # Only unregister the bridge daemon if it was installed FROM this copy.
    $t = Get-ScheduledTask -TaskName AntigravityTelegramBridge -ErrorAction SilentlyContinue
    if ($t -and $t.Actions[0].WorkingDirectory -like "$dir*") {
        Stop-ScheduledTask $t.TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask $t.TaskName -Confirm:$false
    }
    if (Test-Path "$dir\.env") { Copy-Item "$dir\.env" (Join-Path $env:USERPROFILE 'antigravity.env.bak') -Force }
    Remove-Item -Recurse -Force $dir
    Write-Host "Uninstalled. Copy of .env kept at $env:USERPROFILE\antigravity.env.bak"
} else { Write-Host 'No script install found.' }
```

Then **restart Claude Code** - `/reload-plugins` drops commands, agents and
skills, but MCP tool schemas registered at session start stay until a restart.

A leftover `pluginUsage` entry in `~/.claude.json` is harmless telemetry; there
is nothing else to clean up.

### Post-Install

Restart Claude Code, then verify from a terminal:

```bash
claude plugin list
claude plugin details lagrange@kzvilla-lagrange
```

### 🔐 Telegram Bridge Setup (Manual — Never Automated)

The Telegram tools (`telegram_notify`, `telegram_ask`, `telegram_send_voice`, and `agy_narrate`'s `send_telegram` option) need your own bot token and chat ID in a `.env` file. **No install channel ever creates or copies them for you** — an installer that silently provisioned credentials would be a much worse security default than asking you to do it once, yourself.

1. Get a bot token from [@BotFather](https://t.me/BotFather) on Telegram.
2. Get your numeric user ID from [@userinfobot](https://t.me/userinfobot).
3. Copy the example file and fill in both values:
   ```bash
   cp telegram-bridge/.env.example .env
   ```
   (edit `TELEGRAM_BOT_TOKEN` and `ALLOWED_USER_IDS` in the new `.env`)

#### Where the `.env` has to live

`.env` is git-ignored on purpose, so no install channel ever brings it along — only tracked files are fetched. It has to sit at the **plugin root of the copy that actually runs**, and where that is depends on how you installed:

| Install channel | Put `.env` at | Survives an update? |
|---|---|---|
| Marketplace | `~/.claude/plugins/cache/kzvilla-lagrange/lagrange/<version>/.env` | **No** — the path is versioned, so a new version means a new empty directory |
| Git clone (development) | `<clone>/.env` | Yes |

A `.env` in a separate dev checkout does nothing for the installed plugin: outbound Telegram delivery will look unconfigured from the live plugin even though a manual test run elsewhere works fine.

Because of the second row, **if you use the Telegram bridge, run it from a git clone**, not from the marketplace cache. The marketplace channel is the right one for the plugin itself (commands, agents, MCP tools); the bridge is a long-running daemon with its own credentials and state, and it wants a stable directory:

```bash
git clone https://github.com/KZvilla/claude-plugin-antigravity.git
cd claude-plugin-antigravity
cp telegram-bridge/.env.example .env    # then fill in the two values
npm run bridge
```

The bidirectional bot (`telegram-bridge/bot.js`, started with `npm run bridge` from the repo root) is only needed if you want to message the bot *from* your phone to kick off `agy` tasks or answer `telegram_ask` prompts — outbound notifications and voice notes work without it. To keep it running across logins, see `telegram-bridge/daemon.ps1` (`npm run bridge:daemon:install` on Windows).

---

## 📄 License

MIT
