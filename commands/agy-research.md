---
description: Delegate deep web research to Antigravity with citations and structured findings
argument-hint: <research topic or question>
---

Delegate web research to Google Antigravity CLI (`agy`):

$ARGUMENTS

Instructions:
1. Use `mcp__antigravity__agy_run` with:
   - `mode: "plan"` (read-only, no file changes)
   - `effort: "high"`
   - `dangerously_skip_permissions: true`
   - Prepend to the user's prompt:
     ```
     Investigate the following topic thoroughly using web search and any available research tools.
     Return a structured report with these sections:
     
     ## Summary
     A concise 2-3 sentence overview of the findings.
     
     ## Key Findings
     Numbered list of the most important discoveries, facts, or insights.
     
     ## Sources
     For each source used:
     - [Title](URL) — brief description of what this source contributed
     
     ## Relevance to Current Project
     If the research topic relates to the current codebase or project, explain how the findings apply and what actions could be taken.
     
     Be thorough but concise. Prioritize primary sources and official documentation over blog posts.
     ```
2. Present findings with source URLs prominently displayed.
3. If Antigravity returns a `conversation_id`, display it so the user can follow up with deeper questions.
