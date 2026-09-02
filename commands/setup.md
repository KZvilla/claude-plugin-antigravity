---
description: Guided setup for the optional parts of the plugin — Antigravity CLI, Voicebox, Telegram notifications and the bidirectional daemon
argument-hint: [voicebox | telegram | daemon]
---

Guide the user through configuring this plugin.

Which track they asked for (may be empty — if so, cover all of them):
$ARGUMENTS

Instructions:
1. Load the `setup` skill and follow it. It carries the full procedure, the
   per-track detail, and the rule about never handling secrets in the chat.
2. Always diagnose first with `agy_status`, `agy_narrate_voices` and
   `telegram_bridge_status`, and only walk through what is actually missing. Do
   not make someone re-do a step they have already completed.
3. If an argument narrows the scope (`voicebox`, `telegram`, `daemon`), do that
   track and only mention the others in one line at the end.
4. Never ask for a bot token or any other secret in the chat, and never write one
   to disk on the user's behalf. Point at the file and the two lines; they fill
   it in. Verify by sending a test notification and asking whether it arrived.
