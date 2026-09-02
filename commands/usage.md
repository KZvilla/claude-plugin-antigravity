---
description: Token usage, context saturation, and quota health for Antigravity sessions
argument-hint: [reset]
---

Retrieve and display the model usage metrics and quota status for Google Antigravity CLI (`agy`):

$ARGUMENTS

Instructions:
1. If the arguments contain "reset", invoke `mcp__antigravity__agy_usage` with `reset: true`.
2. Otherwise, invoke `mcp__antigravity__agy_usage` with default arguments.
3. Present the active model, context window capacity, session token consumption (input, output, thinking, cache read), and last task details cleanly formatted.
