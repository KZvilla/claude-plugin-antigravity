/**
 * The ALLOW/DENY policy must actually reach the subagent.
 *
 * Regression context: agy_plan / agy_review / agy_audit / agy_session_summary
 * used to ignore config.permissions entirely. Their hardcoded `--mode plan`
 * masked it, because plan mode blocks file writes — but it does NOT stop the
 * subagent from reading .env, running `git push`, or hitting the network, and
 * it silently dropped `sandbox: true`.
 *
 * These tests assert on the exact CLI args the server builds, with the agy
 * binary stubbed out (see test/stub-spawn.js).
 *
 * Run against an older checkout to confirm the tests are load-bearing:
 *   git show <ref>:mcp-server/index.js > /tmp/old.js
 *   SERVER_JS=/tmp/old.js node test/permissions.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const RESTRICTIVE_POLICY = {
  permissions: {
    allow: ['read'],
    deny: ['commands', 'network'],
    deny_paths: ['.env*', '**/*.key'],
    deny_commands: ['git push*'],
    sandbox: true
  }
};

// Tools that delegate to agy and must honor the policy.
const READONLY_TOOLS = [
  ['agy_plan', { task: 'Add rate limiting to the login endpoint' }],
  ['agy_review', { review_target: 'git diff' }],
  ['agy_audit', { target: 'git diff' }]
];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-perms-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'antigravity.json'),
    JSON.stringify(RESTRICTIVE_POLICY, null, 2)
  );
  return dir;
}

function promptOf(call) {
  const i = call.args.indexOf('-p');
  return i >= 0 ? call.args[i + 1] : '';
}

async function main() {
  const fixture = makeFixture();
  const capture = path.join(fixture, 'capture.jsonl');
  fs.writeFileSync(capture, '');

  const server = startServer({ cwd: fixture, captureFile: capture });
  await server.initialize();

  for (const [tool, args] of READONLY_TOOLS) {
    await server.callTool(tool, { ...args, cwd: fixture });
  }

  // agy_run is the tool that always enforced the policy; it guards the refactor
  // that moved the logic into shared helpers.
  await server.callTool('agy_run', { prompt: 'Do the thing', cwd: fixture });

  server.stop();

  const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const names = [...READONLY_TOOLS.map(t => t[0]), 'agy_run'];

  await group('Persisted DENY policy reaches the subagent prompt', () => {
    check('one agy invocation per tool call', calls.length === names.length,
      `expected ${names.length}, got ${calls.length}`);

    calls.forEach((call, i) => {
      const tool = names[i] || `call#${i}`;
      const prompt = promptOf(call);

      check(`${tool}: guardrail block injected`, prompt.includes('SECURITY & PERMISSION GUARDRAILS'));
      check(`${tool}: command execution denied`, prompt.includes('COMMAND EXECUTION DENIED'));
      check(`${tool}: network access denied`, prompt.includes('NETWORK ACCESS DENIED'));
      check(`${tool}: deny_paths propagated`, prompt.includes('.env*'));
      check(`${tool}: deny_commands propagated`, prompt.includes('git push*'));
      check(`${tool}: --sandbox flag passed`, call.args.includes('--sandbox'));
      check(`${tool}: read-only (--mode plan)`,
        call.args[call.args.indexOf('--mode') + 1] === 'plan',
        'deny:["edit"] is implied by allow:["read"], so agy_run must drop to plan mode too');
    });
  });

  fs.rmSync(fixture, { recursive: true, force: true });
  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
