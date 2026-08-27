---
description: Ask Antigravity to analyze the codebase and generate an architectural implementation plan
argument-hint: <feature or refactoring task>
---

Request an architectural and implementation plan from Google Antigravity CLI (`agy`):

Task:
$ARGUMENTS

Instructions:
1. Use the `mcp__antigravity__agy_plan` tool with `effort: "high"`.
2. Review the returned plan and present it clearly to the user.
3. Keep the `conversation_id` handy so the user can easily execute the plan with `/agy` or `agy_run`.
