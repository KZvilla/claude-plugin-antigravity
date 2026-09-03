---
description: Structured summary of this Claude Code session, from its raw JSONL log
argument-hint: [session_id | "decisions" | "changes" | "debugging" | "handoff"]
---

Generate a session summary using Google Antigravity CLI (`agy`).

Session ID or focus area (may be empty — if so, summarize the current session with full focus):
$ARGUMENTS

Instructions:
1. Parse the user's argument to determine:
   - If it looks like a UUID → pass it as `session_id`
   - If it's "decisions", "changes", "debugging" or "handoff" → pass it as `focus`
   - If empty or "current" → use defaults (most recent session, full focus)
2. Use the `mcp__lagrange__agy_session_summary` tool with `effort: "high"`.
   - **Always pass `key_points`**, unless you have genuinely nothing to add. These are
     short sentences YOU know matter and that a reader of the log cannot recover:
     method rules and invariants the session established the hard way ("verify each
     gate with its own exit code, never chain them through a pipe"), findings whose
     evidence is scattered, and approaches already tried and discarded. Name the
     concrete identifier, file or flag in each — that is what makes them verifiable.
     Measured on this repo: that class of content was lost in 6 of 6 runs across both
     models until it was declared, and it is not a context-length problem. Each point
     is injected as mandatory and then checked mechanically in the result.
   - Use `focus: "handoff"` when the session is ending or about to be compacted: it
     produces a context transfer for a fresh session, not documentation, and ends in a
     copy-paste prompt.
   - Pass `narrate: true` to hear a spoken digest. Do NOT try to get that by feeding
     the finished document to `agy_say`: on a 36KB handoff that speaks 2.8% of it, cut
     mid-sentence, and the pending work — which lives at the end — never reaches the ear.
   - Pass `strict: true` when the document will be acted on without anyone re-reading
     the session. It roughly doubles time and tokens.
3. Present the generated summary, then report the run details the tool actually returns:
   the saved file path, turns processed, source log size, and focus. Report only what
   appears in the tool output — do not guess whether the transcript was truncated.
   Relay the **Verificacion mecanica** line as well: it compares the document against
   facts extracted from the log and against git (SHAs cited, the version the session
   actually ended at, file coverage), so it is the one part of the output that cannot
   be a hallucination. If `strict` was used, the adversarial review is ADVISORY — it
   has returned RECHAZADO over terms that appeared dozens of times in the transcript
   it was given, so present it as leads to check, never as a verdict.
4. Do not pick a model unless the user asks for one. The tool chooses on its own:
   the configured default up to a 700KB preprocessed prompt, `gemini-3.1-pro` above
   that. It measures the prompt, not the raw log. Its output
   reports the model, the effort and — when it switched — why. Relay that.
