---
name: session-summary
description: '[skill, loads itself] Background knowledge for session summaries; /lagrange:summary is the explicit trigger. Use this skill when the user wants to create a session summary, document what was done in a session, preserve context before compaction, generate a handoff document, or mentions "summarize session", "session summary", "what did we do", "document this session", or "save session notes".'
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
/lagrange:summary
```

### With focus area
```
/lagrange:summary decisions    → emphasizes architectural/design choices
/lagrange:summary changes      → emphasizes files modified
/lagrange:summary debugging    → emphasizes problems and resolutions
/lagrange:summary handoff      → context transfer for a fresh session
```

`handoff` is not an emphasis, it is a different document: written for an agent
starting cold, it prioritizes findings that exist only in the conversation over
anything recoverable from `git log`, and ends in a copy-paste prompt. Use it
before compacting or when the session is about to end.

### Declaring what must survive (`key_points`)

The single most valuable parameter, and the one most often skipped. Pass short
sentences that YOU know matter and that a reader of the log cannot recover:

```json
{
  "focus": "handoff",
  "key_points": [
    "Verify each gate with its own exit code ($?); never chain assertions with && through a pipe, they mask red tests.",
    "Truncate a command at the line that opens a heredoc (<<), keeping the previous statement.",
    "Rejected: passing the prompt as a CLI argument — over ~24KB it gets offloaded to a file the model may not read."
  ]
}
```

Each point is injected at the top of the prompt as mandatory to preserve, **and
then verified mechanically** in the result by its distinctive terms — a missing
one is a blocking finding.

Why it exists: method rules and invariants were lost in **6 of 6** runs, across
both models, at ~100k input tokens. That is not context saturation — those rules
are diffuse in the transcript and nothing marks them. The agent running the
session does know them.

### Hearing it (`narrate`)

```json
{ "focus": "handoff", "narrate": true }
```

The spoken digest is produced in the *same* call that writes the document, so it
costs no extra round-trip. Do not try to get it by passing the finished document
to `agy_say`: measured on a 36KB handoff, plain narration speaks 1029 characters
(2.8%, cut mid-sentence) and the polish path only ever sees the first 12000
characters — so the pending work and the findings, which live at the end, never
reach the ear. The saved document never contains the digest.

### Verification (`strict`)

A mechanical check **always** runs and cannot hallucinate: it compares the
document against facts extracted from the log and against git — commit SHAs
cited, the version the session actually ended at, file coverage, and the declared
`key_points`. Its findings are reported with every summary.

`strict: true` makes a blocking finding fail the call instead of only reporting
it, and adds a second adversarial pass over the transcript for what a machine
cannot check. **That second pass is advisory and never blocks**: measured, it
returned RECHAZADO accusing a correct document of inventing `daemon.sh`, `bash -n`
and `systemd`, terms that appeared 62, 6 and 71 times in the transcript it was
given. A summarizer that misses material omits; a reviewer that misses material
accuses, and does it in convincing prose.

### Specific session by ID
```
/lagrange:summary 057c77fc-17d4-4ada-86c4-b9f40f2f4d93
```

### Programmatic via MCP tool
```json
{
  "session_id": "057c77fc-17d4-4ada-86c4-b9f40f2f4d93",
  "focus": "decisions",
  "model": "gemini-3.1-pro",
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

> "This has been a productive session. Want me to generate a summary before we wrap up? Run `/lagrange:summary` to save a structured record."

## Size Handling

| Session Size | Behavior |
|---|---|
| < 100KB | Full transcript sent to Gemini |
| 100KB - 1MB | Filtered (noise removed, tool results condensed) |
| > 1MB | Truncated: first 10 turns + most recent turns that fit in 500K chars |

Above a 700KB preprocessed prompt the tool switches to `gemini-3.1-pro` by itself, because flash loses the
thread on transcripts that long — an 8.3MB session summarised with flash invented a
commit SHA that did not exist in the repository, printed as fact. Passing `model`
explicitly always overrides the choice, and the output says which model ran.

Run `agy models` for the current list. Note that the Pro family only accepts `low`
and `high` effort, so a `medium` inherited from config is raised to `high` (and the
output says so) rather than failing inside agy.
