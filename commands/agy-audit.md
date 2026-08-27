---
description: Run a skeptical adversarial audit via Antigravity (heavyweight, evidence-based, structured verdicts)
argument-hint: [target to audit, e.g. "git diff HEAD~3" or a plan/spec text]
---

Run a deep adversarial audit from Google Antigravity CLI (`agy`):

Target:
${ARGUMENTS:-git diff HEAD~1}

Instructions:
1. Determine the audit mode:
   - If the user provides a plan/spec AND code changes → use `audit_mode: "implementation"` (verify code vs plan).
   - If the user provides a plan/RFC to evaluate against the existing codebase → use `audit_mode: "plan"` (verify plan vs real project).
   - If unclear, default to `audit_mode: "implementation"`.
2. Use the `mcp__antigravity__agy_audit` tool with `effort: "high"`.
3. Present the full structured audit report: Verdict, Findings (BLOCKER/MAJOR/MINOR/NOTE), Coverage Table, Validation, and Over-engineering sections.
4. Highlight the verdict prominently at the top.
