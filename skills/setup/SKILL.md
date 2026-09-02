---
name: setup
description: '[skill, loads itself] Guided setup and troubleshooting for the optional parts of this plugin: the Antigravity CLI itself, local Voicebox TTS, outbound Telegram notifications, and the bidirectional Telegram daemon. /lagrange:setup is the explicit trigger. Use this skill when the user wants to configure, install, connect or fix any of those — or mentions "configurar telegram", "instalar voicebox", "set up the bridge", "no me llegan las notificaciones", "el bot no responde", "how do I get the voice narration working", or asks why a Telegram/voice tool is failing.'
license: MIT
---

# Guided Setup

Walk the user through configuring the optional pieces of this plugin. Diagnose
first, then guide only what is actually missing.

## The one rule that outranks convenience

**Never ask the user to paste a bot token, API key, or any other secret into the
chat, and never write one to disk for them.**

This is not generic caution. In this repository there is a concrete path:
anything typed in the conversation is stored in Claude Code's session JSONL, and
`agy_session_summary` reads that raw JSONL and embeds it inside a prompt sent to
Gemini. A token pasted here can reach a third-party model through the plugin's
own tooling.

So: tell the user exactly which file to create and which two lines to put in it,
and let them do it in their editor. Then verify **by effect** — send a test
notification and ask whether it arrived — never by reading the value back or
asking them to confirm it in the chat.

If the user offers a token anyway, do not repeat it, do not write it, and do not
acknowledge its value. Say plainly that it belongs only in the `.env` file, and
carry on with the steps.

## Step 1 — Diagnose before proposing anything

Call these three read-only tools and read the actual state. Never guess, and
never walk someone through a step they have already completed:

| Tool | Tells you |
|---|---|
| `mcp__lagrange__agy_status` | `agy` binary path, version, model/effort defaults, permission policy |
| `mcp__lagrange__agy_narrate_voices` | whether Voicebox is reachable, which voice profiles exist |
| `mcp__lagrange__telegram_bridge_status` | daemon state, which copy of the code each half runs, the effective `.env` path, shared state |

Report a short status of all four tracks, then work only on what is missing.

## Step 2 — The four tracks are independent

Present them as such. A linear installer would push someone who only wanted
desktop notifications into registering a background daemon they do not need.

| Track | Needed for | Optional? |
|---|---|---|
| **A. Antigravity CLI** | everything | No |
| **B. Voicebox** | `agy_narrate`, `agy_say`, voice chat | Yes |
| **C. Telegram outbound** | `telegram_notify`, `telegram_ask`, voice notes to phone | Yes |
| **D. Telegram daemon** | messaging the bot *from* the phone, answering `telegram_ask` | Yes — and it needs C |

Ask which ones they want before walking through anything. If they already said
("configurar telegram"), do C, mention D exists, and skip B.

### Track A — Antigravity CLI

From `agy_status`. If the binary is missing or unauthenticated:

1. Install from <https://antigravity.google/cli>.
2. Authenticate: `agy auth login` (or set `GEMINI_API_KEY`).
3. Re-run `agy_status` to confirm.

### Track B — Voicebox (local TTS)

From `agy_narrate_voices`. If unreachable, Voicebox is simply not running —
it is a separate desktop app, not something this plugin installs. Ask them to
start it, then re-check. If it reports profiles, the track is done; offer
`/lagrange:voices` to see them and `/lagrange:narrate` to try one.

Non-default port: `voicebox_url` / `voicebox_port` on the narration tools, or
persist it with `agy_set_config`.

**Outside Windows**, the *synthesis* goes over HTTP and works anywhere Voicebox
is listening, but the bridge only knows the on-disk location of the generated
`.wav` files on Windows (`%APPDATA%\sh.voicebox.app`). On Linux or macOS, voice
notes therefore fail with a message saying so, immediately rather than after a
timeout. If they do have Voicebox there, `VOICEBOX_DIR` points at the directory
containing `generations/` and `captures/`. If they do not, say plainly that this
track does not apply on their platform and move on — nothing else in the bridge
depends on it.

### Track C — Telegram outbound

This is the track with real friction, and the `.env` location is the part people
get wrong. Take the exact durable path from `telegram_bridge_status` output
(field: *Ubicación duradera recomendada* / *Estado compartido → Directorio de
datos*) rather than typing a path from memory — it differs per platform and can
be overridden by `TELEGRAM_BRIDGE_DATA_DIR`.

Guide them through:

1. **Bot token** — message [@BotFather](https://t.me/BotFather), `/newbot`, follow
   the prompts. It replies with a token. *They keep it; you never see it.*
2. **Numeric user ID** — message [@userinfobot](https://t.me/userinfobot); it
   replies with their ID. This one is not a secret, but there is no reason to
   have it in the chat either.
3. **Create the file** at the durable path the status tool reported, containing:
   ```
   TELEGRAM_BOT_TOKEN=<the token from BotFather>
   ALLOWED_USER_IDS=<the numeric id from userinfobot>
   ```
   Point out *why* that path and not next to the code: every plugin version
   installs into its own directory and an update leaves a `.env` there behind,
   silently. `telegram-bridge/.env.example` documents the full search order and
   the other optional settings.
4. **Verify by effect** — call `telegram_notify` with a short test message and
   ask whether it arrived on their phone. If it fails, the error now lists every
   path that was searched; read it back to them rather than speculating.

Common outcomes worth naming:
- *"No hay usuarios configurados"* → the `.env` was not found where the process
  looked. The error enumerates the paths; compare with where they saved it.
- Notification reports success but nothing arrives → they have never sent a
  message to their own bot. Telegram will not let a bot open a conversation;
  they must send it `/start` once.
- Wrong `ALLOWED_USER_IDS` → the bot ignores them silently by design. Re-check
  the ID from @userinfobot.

### Track D — Bidirectional daemon (optional)

Only needed to message the bot *from* the phone or answer `telegram_ask`.
Outbound notifications and voice notes work without it.

**Do not run this yourself.** Give them the commands and let them run them. The
commands are the same on every platform — a dispatcher picks the right service
manager:

```bash
git clone https://github.com/KZvilla/claude-plugin-antigravity.git
cd claude-plugin-antigravity
npm install --prefix telegram-bridge
npm run bridge:daemon:install
```

| Platform | Service manager | Logs |
|---|---|---|
| Windows | Task Scheduler, at logon | `telegram-bridge/daemon.log` |
| Linux | `systemd --user` | `journalctl --user -u lagrange-telegram-bridge` |
| macOS | **not supported** — `npm run bridge` in a terminal, or write your own launchd unit | — |

Explain why it must come from a clone: the installer refuses to run from a
managed plugin directory, on both platforms, because the scheduled task and the
systemd unit each store an **absolute path**. Installed from
`plugins/cache/…/<version>/`, the daemon would stay pinned to that version
forever — and since updates do not delete old versions, it would keep running
stale code with nothing failing to reveal it.

**On Linux, do not skip the linger step.** A `systemd --user` service stops when
the user's last session ends and does not start at boot. The installer detects
this and prints the fix, but confirm they ran it:

```bash
sudo loginctl enable-linger $USER
```

Without it the daemon looks fine right after installing and is silently gone
after the next reboot — which is exactly the sort of failure that gets blamed on
the bridge rather than on the missing setting.

Credentials and state are shared, so the clone uses the same `.env` and the same
`state.json` as the installed plugin. They do **not** configure anything twice.

Verify with `telegram_bridge_status`: the service should be `Running` (Windows)
or `active` (Linux) with a live PID. Then have them send `/status` to the bot
from their phone. `npm run bridge:daemon` gives the platform-native view, and on
Linux additionally reports the linger state.

## Step 3 — Close honestly

Summarize what is now working and what they chose to skip. If a track failed,
say so plainly with the actual error — do not report a setup as complete because
the steps were followed. The whole point of verifying by effect is that
following the steps and it working are different things.
