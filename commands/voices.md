---
description: Inspect voice profiles and setup without starting providers
argument-hint: ["all" | "es" | "en"]
---

Inspect available or cached voice profiles and their configured roles. This command is read-only.

Language filter (may be empty — if so, treat it as `all`):
$ARGUMENTS

Instructions:
1. Parse the user's argument:
   - If argument is "es" or "spanish" -> pass `language: "es"`
   - If argument is "en" or "english" -> pass `language: "en"`
   - If omitted or "all" -> pass `language: "all"`
2. Call the `mcp__lagrange__agy_narrate_voices` tool.
3. Present the returned markdown table, setup state, data source, and service status to the user.
4. Explain how to invoke any of the listed voices using `/lagrange:narrate <name>` or natural prompt.
