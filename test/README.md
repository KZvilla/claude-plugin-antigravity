# Tests

```bash
npm test                      # everything
node test/run.js              # the same, directly
node test/permissions.test.js # one suite
VERBOSE=1 node test/run.js    # include the server's stderr
```

Zero dependencies, matching the MCP server itself. Node 18+.

## How they work

Each suite starts `mcp-server/index.js` as a real child process and talks JSON-RPC
over stdio, exactly as Claude Code does. `agy.exe` is never launched: `stub-spawn.js`
is preloaded via `NODE_OPTIONS=--require` and intercepts `child_process.spawn`,
appending the full argv of each intercepted call to a capture file and returning a
canned JSON response.

So the assertions run against the server's real code path — config discovery,
permission resolution, prompt assembly, CLI arg construction — and inspect the exact
command that *would* have been executed. No tokens spent, no network, no Gemini quota.

Each suite builds its own throwaway project directory with a `.claude/antigravity.json`
in it, so the policy under test is a real config file discovered the normal way,
not an injected object.

## Suites

| File | Covers |
|------|--------|
| `permissions.test.js` | The ALLOW/DENY policy reaches `agy_plan`, `agy_review`, `agy_audit` and `agy_run` — guardrail prompt, `deny_paths`, `deny_commands`, network, `--sandbox`, `--mode plan` |
| `research.test.js` | `agy_research` exists as a tool, runs read-only when network is allowed, and returns an error (without launching agy) when it is denied |
| `command-names.test.js` | Slash-command names stay consistent repo-wide: nothing references a pre-0.5.0 name, every `/antigravity:<name>` resolves to a real command or skill, and each command carries a description |

## Confirming a test is load-bearing

A test that never fails proves nothing. Both suites were written against bugs that
existed at `3932d6f`, so point them at that checkout and they should go red:

```bash
git show 3932d6f:mcp-server/index.js > /tmp/old-index.js
cp mcp-server/lib/sentence-chunker.js /tmp/lib/   # server requires ./lib/
SERVER_JS=/tmp/old-index.js node test/permissions.test.js   # expect failures
```

At `3932d6f`, `permissions.test.js` fails 7 of 8 checks for each read-only tool
(the policy was ignored entirely) and `research.test.js` fails at the first check
(no `agy_research` tool existed).

## What these tests do *not* cover

- **The installed plugin.** Claude Code serves the plugin from its marketplace
  cache — `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, a separate
  copy pinned to a released `sha`, not this working directory. Editing files here
  changes nothing about the running plugin until a release is cut and installed.
  Anything involving the plugin's real tool namespace
  (`mcp__plugin_antigravity_antigravity__*`) or the subagent's tool allowlist has
  to be verified there, in a live session.
- **Whether Claude Code loads what we wrote.** `command-names.test.js` reads the
  files on disk; it cannot tell you the slash menu renders them. v0.5.0 shipped a
  rename whose last stale reference was found by running a command, not by a test.
- **agy itself.** The binary is stubbed. These tests verify what we ask it to do,
  never what it does in response.
