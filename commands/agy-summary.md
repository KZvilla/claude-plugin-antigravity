---
description: Generate a structured summary of the current or recent Claude Code session via Antigravity (Gemini)
argument-hint: [session_id | "decisions" | "changes" | "debugging"]
---

Generate a session summary using Google Antigravity CLI (`agy`).

Session ID or focus area (may be empty — if so, summarize the current session with full focus):
$ARGUMENTS

Instructions:
1. Parse the user's argument to determine:
   - If it looks like a UUID → pass it as `session_id`
   - If it's "decisions", "changes", or "debugging" → pass it as `focus`
   - If empty or "current" → use defaults (most recent session, full focus)
2. Use the `mcp__antigravity__agy_session_summary` tool with `effort: "high"`.
3. Present the generated summary, then report the run details the tool actually returns:
   the saved file path, turns processed, source log size, and focus. Report only what
   appears in the tool output — do not guess whether the transcript was truncated.
4. If the session log is very large (>1MB), suggest using `model: "gemini-2.5-pro"` for better results.
