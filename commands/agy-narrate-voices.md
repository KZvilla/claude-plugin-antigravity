---
description: List all installed Voicebox voice profiles and their role assignments (defaults and fallbacks)
argument-hint: ["all" | "es" | "en"]
---

List available voice profiles from Voicebox TTS:

${ARGUMENTS:-all}

Instructions:
1. Parse the user's argument:
   - If argument is "es" or "spanish" -> pass `language: "es"`
   - If argument is "en" or "english" -> pass `language: "en"`
   - If omitted or "all" -> pass `language: "all"`
2. Call the `mcp__antigravity__agy_narrate_voices` tool.
3. Present the returned markdown table and Voicebox service status to the user.
4. Explain how to invoke any of the listed voices using `/agy-narrate <name>` or natural prompt.
