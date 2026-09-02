---
description: Deep web research via Antigravity, with citations and structured findings
argument-hint: <research topic or question>
---

Delegate web research to Google Antigravity CLI (`agy`):

$ARGUMENTS

Instructions:
1. Use the `mcp__antigravity__agy_research` tool with:
   - `topic`: the user's research question, verbatim
   - `effort: "high"`
   - `project_context`: a one-line note on how the topic relates to the current repo, if it plausibly does — omit it otherwise rather than inventing a connection
   - `recency`: only when the topic is time-sensitive (releases, pricing, API changes)
2. Present the findings with source URLs prominently displayed.
3. If the tool returns a `conversation_id`, display it so the user can follow up with deeper questions on the same research thread.
4. If the tool errors because the `network` capability is denied, relay that to the user and stop — do not fall back to answering the research question from memory, and do not silently re-run it with `agy_run`.
