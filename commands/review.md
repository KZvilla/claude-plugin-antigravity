---
description: Adversarial code review of a diff, a commit range, or specific files
argument-hint: [optional review target, default: git diff]
---

Request an adversarial code review from Google Antigravity CLI (`agy`):

Target to review (may be empty — if so, default to `git diff HEAD~1`):
$ARGUMENTS

Instructions:
1. Run `git status` or check current diff if needed to gather context.
2. Use the `mcp__lagrange__agy_review` tool with `effort: "high"`.
3. Present the review findings categorized by severity: Critical, Warnings, Suggestions.
