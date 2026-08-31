---
name: session-summary
description: Use this skill when the user wants to create a session summary, document what was done in a session, preserve context before compaction, generate a handoff document, or mentions "summarize session", "session summary", "what did we do", "document this session", or "save session notes".
metadata:
  version: 0.3.0
---

# Session Summary Skill

This skill teaches Claude Code how to generate structured summaries of development sessions by delegating to Antigravity (Gemini).

## Why This Exists

Claude Code's context window compaction is lossy — it discards details, intermediate decisions, and reasoning when the conversation gets too long. This tool solves that by:

1. Reading the raw session JSONL log (which preserves everything)
2. Pre-processing it to filter noise and fit within Gemini's context window
3. Delegating the summarization to Gemini (1M-2M token window)
4. Saving a persistent markdown document with YAML frontmatter

## When to Use

- **Before compaction**: When the context window is getting full, proactively suggest generating a summary
- **End of session**: When the user is wrapping up work for the day
- **Handoff**: When context needs to be transferred to a new session or team member
- **Documentation**: When the user wants a record of what was accomplished
- **On demand**: When the user asks "what did we do?" or "summarize this session"

## How to Use

### Basic (summarize current session)
```
/agy-summary
```

### With focus area
```
/agy-summary decisions    → emphasizes architectural/design choices
/agy-summary changes      → emphasizes files modified
/agy-summary debugging    → emphasizes problems and resolutions
```

### Specific session by ID
```
/agy-summary 057c77fc-17d4-4ada-86c4-b9f40f2f4d93
```

### Programmatic via MCP tool
```json
{
  "session_id": "057c77fc-17d4-4ada-86c4-b9f40f2f4d93",
  "focus": "decisions",
  "model": "gemini-2.5-pro",
  "output_path": "./docs/session-2026-08-28.md"
}
```

## Output Location

Summaries are saved to `~/.claude/session-summaries/<date>-<session-id-short>.md` by default.

Each file includes YAML frontmatter for programmatic access:
```yaml
---
session_id: "057c77fc-..."
project: "c:/vs work/my-project"
branch: "main"
date: "2026-08-28"
start_time: "2026-08-28T10:00:00Z"
end_time: "2026-08-28T14:30:00Z"
summarized_by: "antigravity-mcp"
claude_version: "2.1.241"
---
```

## Proactive Behavior

If you detect that the user's session has been long and productive (many tool calls, multiple files modified), consider suggesting:

> "This has been a productive session. Want me to generate a summary before we wrap up? Run `/agy-summary` to save a structured record."

## Size Handling

| Session Size | Behavior |
|---|---|
| < 100KB | Full transcript sent to Gemini |
| 100KB - 1MB | Filtered (noise removed, tool results condensed) |
| > 1MB | Truncated: first 10 turns + most recent turns that fit in 500K chars |

For very large sessions (>5MB), recommend using `gemini-2.5-pro` which has a 2M token context window.
