/**
 * agy_research is a real MCP tool, and it refuses to fake research.
 *
 * Regression context: /agy-research (old-name-ok) used to be a slash command that
 * prompt on top of agy_run. It never appeared in the tool list, and a
 * deny: ["network"] policy degraded it silently — agy would answer the research
 * question from memory, citations included, with nothing having been fetched.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

function makeFixture(permissions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-research-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'antigravity.json'), JSON.stringify({ permissions }, null, 2));
  return dir;
}

async function main() {
  // --- Tool surface -------------------------------------------------------
  const listFixture = makeFixture({ allow: ['read', 'network'], deny: [] });
  const capture = path.join(listFixture, 'capture.jsonl');
  fs.writeFileSync(capture, '');

  const server = startServer({ cwd: listFixture, captureFile: capture });
  await server.initialize();
  const list = await server.listTools();
  const tools = list.result.tools;
  const research = tools.find(t => t.name === 'agy_research');

  await group('agy_research is exposed as a tool', () => {
    check('present in tools/list', !!research);
    check('requires only `topic`', research && JSON.stringify(research.inputSchema.required) === '["topic"]');
    check('accepts per-call permissions', !!(research && research.inputSchema.properties.permissions));
    check('documents the network requirement', !!(research && /network/i.test(research.description)));
  });

  // --- Happy path ---------------------------------------------------------
  const ok = await server.callTool('agy_research', {
    topic: 'Claude Code plugin manifest schema changes',
    recency: 'past 6 months',
    cwd: listFixture
  });

  const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const prompt = calls.length ? calls[0].args[calls[0].args.indexOf('-p') + 1] : '';

  await group('Research runs when network is permitted', () => {
    check('agy was invoked', calls.length === 1);
    check('not an error', !ok.result.isError);
    check('read-only mode', calls.length > 0 && calls[0].args[calls[0].args.indexOf('--mode') + 1] === 'plan');
    check('recency constraint reaches the prompt', prompt.includes('past 6 months'));
    check('prompt forbids answering from memory', /not rely on memory|never actually/i.test(prompt));
    check('prompt requests a Sources section', prompt.includes('## Sources'));
  });

  server.stop();

  // --- Denied network -----------------------------------------------------
  const deniedFixture = makeFixture({ allow: ['read'], deny: ['network'] });
  const deniedCapture = path.join(deniedFixture, 'capture.jsonl');
  fs.writeFileSync(deniedCapture, '');

  const denied = startServer({ cwd: deniedFixture, captureFile: deniedCapture });
  await denied.initialize();
  const res = await denied.callTool('agy_research', { topic: 'anything', cwd: deniedFixture });
  const deniedCalls = fs.readFileSync(deniedCapture, 'utf8').trim().split('\n').filter(Boolean);
  denied.stop();

  const text = res.result.content[0].text;

  await group('Research fails loudly when network is denied', () => {
    check('returns isError', res.result.isError === true);
    check('never launched agy', deniedCalls.length === 0,
      `agy was invoked ${deniedCalls.length} time(s) despite the deny`);
    check('names the offending policy', /deny=\[network\]/.test(text));
    check('explains how to re-enable', /agy_set_config/.test(text));
    check('refuses to answer from memory', /memory/i.test(text));
  });

  // A per-call override must still be able to re-enable it deliberately.
  const overrideCapture = path.join(deniedFixture, 'override.jsonl');
  fs.writeFileSync(overrideCapture, '');
  const override = startServer({ cwd: deniedFixture, captureFile: overrideCapture });
  await override.initialize();
  const overridden = await override.callTool('agy_research', {
    topic: 'anything',
    cwd: deniedFixture,
    permissions: { allow: ['read', 'network'], deny: [] }
  });
  const overrideCalls = fs.readFileSync(overrideCapture, 'utf8').trim().split('\n').filter(Boolean);
  override.stop();

  await group('Per-call override can re-enable network', () => {
    check('not an error', !overridden.result.isError);
    check('agy was invoked', overrideCalls.length === 1);
  });

  fs.rmSync(listFixture, { recursive: true, force: true });
  fs.rmSync(deniedFixture, { recursive: true, force: true });
  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
