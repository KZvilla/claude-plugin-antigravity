---
description: List the installed Voicebox voice profiles, languages, and role assignments
argument-hint: ["all" | "es" | "en"]
---

List available voice profiles from Voicebox TTS.

Language filter (may be empty — if so, treat it as `all`):
$ARGUMENTS

Instructions:
1. Parse the user's argument:
   - If argument is "es" or "spanish" -> pass `language: "es"`
   - If argument is "en" or "english" -> pass `language: "en"`
   - If omitted or "all" -> pass `language: "all"`
2. Call the `mcp__antigravity__agy_narrate_voices` tool.
3. Present the returned markdown table and Voicebox service status to the user.
4. Explain how to invoke any of the listed voices using `/antigravity:narrate <name>` or natural prompt.
