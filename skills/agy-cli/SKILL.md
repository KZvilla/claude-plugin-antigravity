---
name: agy-cli
description: '[skill, loads itself] Reference for working with the Antigravity CLI. Use this skill when delegating tasks to Google Antigravity CLI (agy), running Antigravity as an autonomous subagent, requesting architectural planning with Gemini reasoning, performing second-opinion code reviews, configuring ALLOW/DENY permissions, generating structured session summaries, delegating deep web research, or when the user mentions "ask agy", "run in agy", "delegate to agy", "antigravity plan", or "cross-check with agy".'
metadata:
  version: 0.3.0
---

# Antigravity Subagent Skill

This skill teaches Claude Code how to collaborate with **Google Antigravity CLI (`agy`)** as a complementary autonomous subagent and pair-programming partner.

## Overview

Antigravity (`agy`) is Google's terminal-based AI development agent powered by Gemini models (Gemini 2.5 / 3.7 Pro and Flash) with extended reasoning capabilities. It has native terminal access, code editing capabilities, background task management, and workspace discovery.

By pairing Claude Code and Antigravity:
- **Claude Code** acts as the primary orchestrator, interactive driver, or pair programmer.
- **Antigravity (`agy`)** acts as an autonomous subagent for deep reasoning, architectural planning, second opinions, and independent verification.

## When to Delegate to Antigravity

Delegate tasks to Antigravity when:
1. **Architectural Planning**: The task is complex and benefits from a high-effort reasoning breakdown (`agy_plan`).
2. **Autonomous Implementation / TDD**: You want a self-contained feature, refactoring, or test suite implemented end-to-end (`agy_run`).
3. **Adversarial Code Review / Sanity Check**: After modifying code, ask Antigravity to review the diff against project guidelines (`agy_review`).
4. **Rigorous Audit with a Blocking Verdict**: When a plain review is not strict enough — verifying an implementation against the plan it was supposed to follow, or a proposed plan against the real codebase (`agy_audit`).
5. **Second Opinion on Tricky Bugs**: When troubleshooting a puzzling bug or flaky test, delegate an investigation to Antigravity with a fresh perspective.
6. **Session Documentation & Anti-Compaction**: When the conversation gets long or at the end of a session, generate a structured markdown summary (`agy_session_summary`).
7. **Deep Web Research**: When comprehensive live information with cited sources is required (`agy_research`, or `/lagrange:research`).
8. **Spoken Status Updates**: When the user wants to *hear* what happened instead of reading it, or asks which voices are installed (`agy_narrate`, `agy_narrate_voices`).
9. **Real-Time Voice Conversation**: Backing a live spoken session ("Modo Charla") with a persistent, streaming `agy` process (`agy_voice_stream`). Normally driven by the `voice-chat/` scripts, not called by hand.
10. **Mobile Notifications & Approvals**: Pushing a notification, asking a blocking question, or sending a voice note to the user's phone (`telegram_notify`, `telegram_ask`, `telegram_send_voice`).

## Tool Reference

### 1. `mcp__lagrange__agy_run`
Run an autonomous Antigravity session.

```json
{
  "prompt": "Implement the missing test cases in src/lib/__tests__/date-contract.test.ts. Run 'npm test' to verify and fix any failures.",
  "model": "gemini-3.7-flash",
  "effort": "high",
  "permissions": {
    "allow": ["read", "edit", "commands"],
    "deny": ["network"],
    "deny_paths": [".env*", "**/*.key"],
    "deny_commands": ["git push*", "npm publish*"],
    "sandbox": false
  },
  "dangerously_skip_permissions": true
}
```

**Granular Permissions Policy:**
- `allow`: Capabilities permitted (`read`, `edit`, `commands`, `network`).
- `deny`: Capabilities forbidden (e.g. `deny: ["edit"]` clamps execution to read-only mode).
- `deny_paths`: File/directory patterns that Antigravity is strictly forbidden from accessing or editing.
- `deny_commands`: Command patterns that Antigravity is strictly forbidden from executing.
- `sandbox`: Enables Antigravity's terminal sandbox restrictions (`--sandbox`).

**Multi-Turn Threading:**
`agy_run` returns a `conversation_id`. To continue the same thread in a follow-up step:
```json
{
  "prompt": "Now also update the documentation in docs/architecture.md to reflect the new test cases.",
  "conversation_id": "94e7260d-51bb-478b-96ac-092525396df8"
}
```

### 2. `mcp__lagrange__agy_plan`
Produce a comprehensive implementation plan without making edits (guaranteed read-only).

```json
{
  "task": "Migrate legacy button classes to Radix UI across src/components/finance.",
  "model": "gemini-3.1-pro",
  "effort": "high"
}
```

Pass `conversation_id` to refine an existing plan without leaving read-only mode. To *execute* the plan instead, hand the same ID to `agy_run`.

### 3. `mcp__lagrange__agy_review`
Perform a thorough code review of recent changes (guaranteed read-only).

```json
{
  "review_target": "git diff HEAD~1",
  "guidelines": "Verify compliance with AGENTS.md, WCAG accessibility rules, and TypeScript strict checks."
}
```

### 4. `mcp__lagrange__agy_audit`
Run a skeptical, evidence-based audit. Much heavier than `agy_review`: it returns a BLOCKER / MAJOR / MINOR / NOTE finding rubric and a deterministic FAIL / PASS WITH RESERVATIONS / PASS verdict. Read-only, 25-minute default timeout.

```json
{
  "target": "git diff main..HEAD",
  "audit_mode": "implementation",
  "plan": "R1: add rate limiting to /api/login. R2: return 429 with Retry-After. R3: cover both in tests.",
  "effort": "high"
}
```

Two modes:
- `"implementation"` (default) — does the code satisfy the `plan` it was supposed to follow, no more and no less?
- `"plan"` — does the proposed plan in `target` fit the flows, data model, and conventions that already exist in the repo? Includes an explicit over-engineering check.

### 5. `mcp__lagrange__agy_research`
Deep web research using Gemini's native search tools. Returns a structured report: Summary, Key Findings, Sources (with URLs), and Relevance to Current Project. Read-only, 20-minute default timeout.

```json
{
  "topic": "Breaking changes in the Claude Code plugin manifest schema",
  "recency": "past 6 months",
  "effort": "high"
}
```

Requires the `network` capability. If `network` is denied — or simply missing from `allow` — the tool returns an error instead of a report. Relay that error to the user; do not re-run the question through `agy_run`, and do not answer it from memory. A research report is only worth anything if its citations were actually fetched.

### 6. `mcp__lagrange__agy_usage`
Display session token telemetry (input, output, thinking, cache read), context window saturation, active model limits, and quota status. Pass `reset: true` to clear session counters.

### 7. `mcp__lagrange__agy_status`
Check CLI path, version, active model/effort defaults, and active ALLOW/DENY permission policies.

### 8. `mcp__lagrange__agy_set_config`
Persist defaults for model, effort, or ALLOW/DENY policies in `~/.claude/antigravity.json` or `.claude/antigravity.json`.

```json
{
  "model": "gemini-3.7-flash",
  "effort": "high",
  "permissions": {
    "deny_paths": [".env*", "**/*.key", "**/*.pem"],
    "deny_commands": ["git push*", "npm publish*"]
  },
  "scope": "project"
}
```

### 9. `mcp__lagrange__agy_session_summary`
Read Claude Code's session JSONL log, preprocess turns to filter noise, and generate a structured markdown summary using Gemini. Solves context compaction degradation.

```json
{
  "focus": "full",
  "model": "gemini-3.7-flash",
  "effort": "high"
}
```
Available focuses: `"full"`, `"decisions"`, `"changes"`, `"debugging"`. Summaries are saved to `~/.claude/session-summaries/<date>-<session-id>.md`.

### 10. `mcp__lagrange__agy_narrate` / `agy_narrate_voices`
`agy_narrate` speaks a short status update out loud through local Voicebox TTS. It costs **zero Claude tokens**: the plugin reads the session log itself, has Gemini draft the spoken line, and sends it straight to Voicebox — Claude never writes the script. `agy_narrate_voices` lists the installed voice profiles, languages, and service health.

Use when the user asks to *hear* an update, or names a voice ("narralo con Diego"). Pass `voice`/`language` when they specify one; `send_telegram` is on by default so the voice note also reaches their phone.

### 11. `mcp__lagrange__agy_voice_stream`
Backs the Real-Time Voice Mode ("Modo Charla") by keeping one long-lived streaming `agy` process alive across turns, instead of the blocking one-shot `agy_run` uses. Actions: `start`, `send`, `drain`, `status`, `stop`.

This is normally driven by the `voice-chat/` scripts (`text_loop.py`, `voice_loop.py`), which poll `drain` in a loop and pipe sentences to TTS. Do not call it by hand during a normal Claude Code session unless the user explicitly asks to drive a voice session manually — and if you start one, always `stop` it, since the `agy` process outlives the tool call.

### 12. `telegram_notify` / `telegram_ask` / `telegram_send_voice`
Reach the user on their phone via the Telegram bridge. `telegram_notify` pushes a message (optionally attaching a file); `telegram_ask` asks a question with tappable buttons and **blocks until they answer or it times out** (default 300s), returning their choice; `telegram_send_voice` sends an audio file as a native voice note.

Requires `TELEGRAM_BOT_TOKEN` and `ALLOWED_USER_IDS` in a `.env` at the installed plugin root — if unconfigured these fail with a setup message rather than silently. Use `telegram_ask` only for decisions genuinely worth interrupting someone's phone for (a destructive migration, a deploy), not routine confirmations.

## Collaboration Workflow

```mermaid
sequenceDiagram
    participant User
    participant Claude as Claude Code
    participant MCP as Antigravity MCP Server
    participant AGY as agy CLI (Terminal)

    User->>Claude: "Implement feature X with agy as subagent (read-only plan first)"
    Claude->>MCP: agy_plan(task: "Feature X")
    MCP->>AGY: agy -p "Plan Feature X" --mode plan --effort high
    AGY-->>MCP: Returns Plan + conversation_id
    MCP-->>Claude: Plan + conversation_id
    Claude->>User: Reviews plan with user
    User->>Claude: "Looks good, execute with agy (deny git push, protect .env)"
    Claude->>MCP: agy_run(prompt: "Execute plan", conversation_id, permissions)
    MCP->>AGY: agy -p "Execute plan" --conversation <id> [Guardrails Enforced]
    AGY-->>MCP: Returns execution result
    MCP-->>Claude: Completed changes
    Claude->>MCP: agy_review(review_target: "git diff")
    AGY-->>Claude: Review verdict
    Claude->>User: Final summary & verification
```
