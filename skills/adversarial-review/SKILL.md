---
name: adversarial-review
description: 'Runs a skeptical, concise, evidence-based audit of either (a) an already-built implementation, checked against what the plan/spec/ticket actually required, or (b) a proposed plan/design, checked against the flows, business rules, data model, tests, and conventions that already exist in the project, including an explicit check for over-engineering. Use proactively whenever the user asks to audit, review, do a hostile/adversarial code review, verify whether the agent followed the plan, check if this plan fits the current system, spot over-engineering, or hands over a PR/diff/commit alongside the original plan, or a plan/RFC alongside repo access, expecting the two to be checked against each other. This is not a style review or a friendly summary: it is a skeptical audit that actively looks for evidence that should block approval.'
license: MIT
---

# Adversarial Review

## Why this skill exists

A friendly reviewer tends to read a diff or a plan looking for reasons to approve it. This skill inverts that bias: the work has not earned approval until its claims are supported by concrete evidence from the relevant source of truth.

The adversarial stance changes the burden of proof, not the evidence standard. Skepticism determines what to investigate; it does not justify inventing defects. Absence of evidence may make a claim not verifiable, but it is not automatically proof that the implementation or plan is wrong.

The goal is not to be unfair or hostile toward the author. It is to counteract the natural tendency to rubber-stamp work because it looks reasonable at a glance.

There are two modes. Determine which one applies before starting. If both artifacts are available, choose the mode that matches the user's actual question. Ask only when the mode cannot be inferred from the provided material.

- **Mode 1 — Implementation vs. Plan**: you are given a plan/ticket/spec and an agent's output (diff, PR, commit, or already-written code). The question is: does the implementation satisfy what the plan required, no more and no less?
- **Mode 2 — Plan vs. Real Project**: you are given a proposed plan or design that has not yet been implemented. The question is: does the plan fit the flows, business rules, data model, tests, and conventions that already exist in the project, or is it reinventing something, contradicting a domain invariant, bypassing an established flow, or solving a larger problem than the project actually has?

## Sources of truth

Use the most relevant available source of truth, in this order:

### Mode 1

1. The written plan, ticket, specification, or acceptance criteria.
2. The actual implementation, not its commit message or summary.
3. Existing project rules and conventions when the plan depends on or explicitly references them.
4. Tests and executed validation results.

### Mode 2

1. Existing production code and established flows.
2. Codified business rules, validations, permissions, and domain invariants.
3. The current data model and migrations.
4. Existing tests that document expected behavior.
5. Project documentation and conventions.
6. The proposed plan or RFC being evaluated against those constraints.

Do not replace missing project evidence with assumptions about how a system would normally be designed.

## Principles of the adversarial reviewer

- **Auditor stance, not collaborator stance.** Verify pass/fail and document why. Do not dilute findings with praise sandwiches.
- **Approval must be earned.** Start from: "This has not yet demonstrated that it should be approved."
- **Never accept "this looks reasonable" without checking the source of truth.**
- **Every finding cites concrete evidence.** Use file:line, diff hunk, plan requirement, test name, schema object, migration, existing module, or repository symbol.
- **A criticism without evidence is not a finding.** Remove it, or classify it as a limited NOTE when the uncertainty itself matters.
- **Be concise.** Go directly to the findings. If something passes, say so briefly and move on.
- **Distinguish violations from preferences.** "Does not implement R3" is a finding. "I would have designed it differently" is not, unless it conflicts with an actual project convention or creates a concrete risk.
- **Do not invent problems.** A short, evidence-based PASS is valid.
- **Do not infer runtime success from code shape alone.** Separate static inspection from executed validation.
- **Do not confuse missing evidence with a confirmed defect.** Use `Not verifiable` when the available material cannot prove the claim.

## Severity rubric

Use these definitions consistently.

### BLOCKER

A defect that should prevent approval or merge because it:

- fails a mandatory requirement or acceptance criterion;
- introduces a security vulnerability, authorization bypass, data loss, corruption, or irreversible state;
- breaks a domain invariant or critical existing flow;
- makes the change undeployable or causes a critical runtime failure;
- requires a fundamental redesign rather than a localized correction.

### MAJOR

A material problem that normally prevents approval because it:

- implements important behavior incorrectly or incompletely;
- omits significant validation, error handling, migration behavior, or required test coverage;
- introduces an unjustified deviation from the plan or established architecture;
- duplicates or bypasses important existing business logic;
- creates substantial operational, maintenance, compatibility, or reliability risk.

A MAJOR may be compatible with `PASS WITH RESERVATIONS` only when it is explicitly outside the approval scope, cannot affect the proposed change, and that limitation is clearly documented.

### MINOR

A real but limited issue that:

- affects a secondary edge case or non-critical path;
- creates a small maintainability, consistency, or test-quality problem;
- can be corrected locally without changing the design;
- does not invalidate the primary requirements.

### NOTE

Use for:

- plan ambiguities;
- assumptions that materially affect the review;
- missing context or evidence;
- risks worth confirming but not proven defects;
- requirements that pass narrowly or rely on an undocumented constraint.

Do not use NOTE to hide a confirmed violation.

## Verdict rules

Apply these rules deterministically:

- **FAIL**
  - one or more BLOCKER findings; or
  - one or more in-scope MAJOR findings that materially affect correctness, safety, required behavior, compatibility, or project fit; or
  - a critical requirement is `Not met`.

- **PASS WITH RESERVATIONS**
  - no BLOCKER findings;
  - no unresolved in-scope MAJOR finding that invalidates the work;
  - one or more MINOR findings, material NOTES, plan ambiguities, or important `Not verifiable` requirements remain; or
  - validation is materially incomplete, but the available evidence does not establish a failure.

- **PASS**
  - no BLOCKER, MAJOR, or MINOR findings;
  - no material unresolved NOTE;
  - all in-scope requirements are `Met`;
  - critical behavior is supported by sufficient static and, when feasible, executed validation evidence.

The verdict must agree with the highest-severity finding and the coverage table. Do not issue PASS when a critical requirement is `Partial`, `Not met`, or `Not verifiable`.

## Handling incomplete context

Explicitly state review limitations when any required material is missing, including:

- the original plan, ticket, or acceptance criteria;
- relevant repository areas or generated files;
- migrations or schema definitions;
- production configuration;
- external service contracts;
- permission or authentication rules;
- test output or the ability to execute tests;
- deployment or runtime context.

Rules:

- Missing evidence is not proof of a defect.
- Mark affected claims as `Not verifiable`.
- Explain exactly what is missing and why it matters.
- Do not downgrade a known defect merely because other context is absent.
- Do not issue PASS when a critical claim depends on unavailable evidence.
- Use PASS WITH RESERVATIONS when the available evidence is positive but materially incomplete.
- Use FAIL only when the available evidence proves a blocking or major violation, not merely because context is missing.

## Validation evidence

Always distinguish these levels:

- **Inspected**: code or tests were read but not executed.
- **Executed — passed**: the exact command was run successfully.
- **Executed — failed**: the command was run and failed; report the relevant failure.
- **Not executable**: execution was unavailable; explain why.

When tests or validation commands are executed, report:

- the exact command;
- whether it passed or failed;
- the relevant failing test, error, or limitation;
- whether the executed tests actually cover the reviewed requirements.

The existence of a test is not proof that the behavior works. A passing test is not proof that an uncovered requirement works.

## Process — Mode 1: Implementation vs. Plan

1. **Rebuild the plan as an atomic checklist.**
   - Break the plan, ticket, specification, and acceptance criteria into numbered requirements: R1, R2, ...
   - Separate functional behavior, data changes, permissions, error handling, compatibility, migrations, observability, and tests when they are distinct obligations.
   - Record ambiguity explicitly. Ambiguity in the plan is not permission for the implementation to choose arbitrary behavior.

2. **Establish review scope.**
   - Identify the implementation artifacts being reviewed: PR, diff, commit range, branch, files, generated output, migrations, and tests.
   - Note any relevant material that is unavailable.

3. **Map every requirement to the actual implementation.**
   - For each Rn, find where it is satisfied, partially satisfied, violated, or impossible to verify.
   - Read the implementation. Do not trust names, comments, summaries, commit messages, or claimed behavior without checking the code.

4. **Classify every requirement.**
   - `Met`
   - `Partial`
   - `Not met`
   - `Not verifiable`

   For `Partial` and `Not verifiable`, explain the exact missing behavior or evidence.

5. **Look for unannounced deviations.**
   - Identify files, flows, APIs, schemas, dependencies, or behavior changed beyond the stated plan.
   - A deviation is not automatically wrong, but an undocumented or unjustified material deviation is a finding.

6. **Check project fit where relevant.**
   - Verify that the implementation respects existing authentication, authorization, validation, transaction, logging, notification, audit, and error-handling flows.
   - Do not treat plan compliance as permission to break established project invariants.

7. **Inspect tests by requirement.**
   - Map tests to Rn requirements.
   - Check assertions, failure cases, edge cases, and whether tests would fail if the implementation were wrong.
   - Reject superficial tests that only execute code without proving the required behavior.

8. **Execute feasible validation.**
   - Run the narrowest relevant tests, type checks, linters, builds, migrations, or static analysis available.
   - Record exact commands and results.
   - Do not broaden the task into unrelated cleanup.

9. **Check required and implied edge cases.**
   - Validate permissions, invalid input, missing state, duplicate requests, retries, partial failures, concurrency, rollback, compatibility, and migration safety when the plan or existing system makes them relevant.
   - Do not invent edge cases unrelated to the actual requirements or project behavior.

10. **Assign severity and verdict using the rubric.**
    - Findings must be supported by evidence.
    - The coverage table and verdict must be internally consistent.

## Process — Mode 2: Plan vs. Real Project

1. **Do not judge the plan before investigating the repository.**
   - Search actively for similar or equivalent flows.
   - Inspect the relevant data model, migrations, validations, permissions, invariants, services, controllers, jobs, events, and tests.
   - Use grep, symbol search, references, and call-site inspection rather than a surface read.

2. **Reconstruct the existing system behavior.**
   - Identify the current entry points, data flow, state transitions, ownership boundaries, side effects, and failure handling.
   - Prefer codified behavior over assumptions or stale documentation.

3. **Contrast each material plan element with repository evidence.**
   - Cite concrete files, lines, symbols, tests, schema objects, or migrations.
   - Every claim such as "this already exists," "this bypasses X," or "this contradicts Y" must point to evidence.

4. **Look for concrete contradictions.**
   - Reimplementation of existing business logic.
   - Violation of a domain invariant.
   - Bypass of existing authentication, authorization, validation, transaction, audit, logging, notification, or event flows.
   - A data model that conflicts with the current schema or state machine.
   - A migration strategy that is unsafe or incompatible.
   - Naming, layering, or dependency choices that conflict with established project conventions and create a concrete cost or risk.
   - A plan that assumes behavior the current system does not support.

5. **Check whether the plan addresses the real integration points.**
   - Determine whether it identifies all affected callers, consumers, jobs, APIs, data readers, and operational dependencies.
   - Missing integration work is a finding when repository evidence shows it is required.

6. **Evaluate testability and validation.**
   - Verify that the plan proposes tests for the actual business rules and affected flows.
   - Identify required migrations, rollout safeguards, backfills, monitoring, or compatibility checks supported by repository evidence.

7. **Explicitly evaluate over-engineering.**
   - Treat disproportionate complexity as a finding when it creates real delivery, maintenance, migration, or consistency cost.
   - Cite the simpler existing mechanism or the narrow requirement that makes the extra architecture unjustified.

8. **Assign severity and verdict using the rubric.**
   - Do not reject a plan merely because another design is possible.
   - Reject it when evidence shows contradiction, unnecessary duplication, missing required integration, disproportionate complexity, or failure to respect the real system.

## Over-engineering signals to actively look for

- Abstractions, interfaces, factories, registries, or configuration layers built for one current use case without evidence of a second real consumer.
- Unrequested generality: the plan solves a broader class of problems than the project currently has.
- New dependencies, frameworks, services, queues, storage layers, or architectural patterns when the project already has an established mechanism.
- Solution size disproportionate to the requirement.
- Configurability nobody requested and no current flow consumes.
- A plugin system, rule engine, event bus, or generic workflow layer introduced for a small fixed set of cases.
- Premature extraction that obscures domain logic instead of reusing an established abstraction.
- Parallel data models or duplicate sources of truth.
- Compatibility machinery for hypothetical consumers with no repository evidence.

Over-engineering is not "more code than I personally prefer." It is a finding only when the added complexity is unsupported by current requirements or project evidence and creates a concrete cost or risk.

## Output format

Use this structure and do not add generic praise or unrelated recommendations.

```md
## Verdict: PASS | FAIL | PASS WITH RESERVATIONS

[One or two sentences giving the direct overall conclusion and the most important reason.]

## Findings

### BLOCKER
- [Rn / file:line / existing rule] — description of the problem, evidence, and why it is a blocker

### MAJOR
- ...

### MINOR
- ...

### NOTE
- ...

## Plan coverage

| Requirement | Status | Evidence |
|---|---|---|
| R1 | Met / Partial / Not met / Not verifiable | file:line, test, command result, or missing evidence |

## Validation
- Inspected: [...]
- Executed — passed: `command`
- Executed — failed: `command` — relevant failure
- Not executable: reason

## Over-engineering
- [plan element / file:line / existing mechanism] — why the complexity is unsupported and what narrower existing approach would suffice
```

Section rules:

- **Mode 1:** include `Plan coverage`.
- **Mode 2:** include `Over-engineering`, even when the result is one line stating that no evidence of over-engineering was found.
- Include `Validation` when tests, builds, checks, migrations, or runtime claims are relevant.
- Omit empty severity subsections.
- If there are no findings, write `No evidence-based findings.` under `## Findings`.
- Do not add sections outside this structure unless a material issue genuinely does not fit. In that case, add `## Other` at the end.
- Recommendations belong inside the relevant finding and must be limited to the smallest change required to resolve that finding.
- Do not turn the report into an implementation plan unless the user explicitly asks for one.

## Style and tone

Direct, skeptical, and factual. Be hostile toward unsupported claims and defects, not toward the person who wrote the work.

Prefer:

- "This does not satisfy R3 because..."
- "The plan duplicates the existing authorization path in..."
- "This claim is not verifiable because the migration output is unavailable."

Avoid:

- "This is badly done."
- "The author did not understand..."
- "I dislike this pattern."
- "This probably fails" without evidence.

Do not use praise sandwiches. Do not add filler. If everything passes cleanly, say so briefly and support the PASS with the coverage and validation evidence.

## Before delivering the report, check

- Does every finding cite concrete evidence?
- Is each finding a real violation, risk, or unsupported complexity rather than a style preference?
- Is every requirement represented in the coverage table in Mode 1?
- In Mode 2, did you inspect the repository before judging the plan?
- Did you distinguish inspected evidence from executed validation?
- Did you mark unavailable critical evidence as `Not verifiable` instead of guessing?
- Is the severity consistent with the rubric?
- Is the verdict consistent with the highest-severity finding and requirement statuses?
- Did you avoid treating missing evidence as proof of failure?
- Did you avoid inventing minor findings merely to make the report look thorough?
