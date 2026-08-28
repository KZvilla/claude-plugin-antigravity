---
description: Generate a structured summary of the current or recent Claude Code session via Antigravity (Gemini)
argument-hint: [session_id | "decisions" | "changes" | "debugging"]
---

Generate a session summary using Google Antigravity CLI (`agy`):

${ARGUMENTS:-current session, full summary}

Instructions:
1. Parse the user's argument to determine:
   - If it looks like a UUID → pass it as `session_id`
   - If it's "decisions", "changes", or "debugging" → pass it as `focus`
   - If empty or "current" → use defaults (most recent session, full focus)
2. Use the `mcp__antigravity__agy_session_summary` tool with `effort: "high"`.
3. Present the generated summary and confirm:
   - The file path where it was saved
   - How many turns were processed
   - If any turns were truncated during pre-processing
4. If the session log is very large (>1MB), suggest using `model: "gemini-2.5-pro"` for better results.
