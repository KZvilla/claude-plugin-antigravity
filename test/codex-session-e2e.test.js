/**
 * Opt-in acceptance test for FEAT-048. It drives a real installed Codex plugin
 * and a disposable agy process-tree probe; ordinary unit/gate runs skip it.
 *
 * Windows example:
 *   $env:LAGRANGE_CODEX_E2E='1'
 *   $env:LAGRANGE_CODEX_E2E_AGY_DIR='C:\path\to\directory-containing-agy.exe'
 *   node test/codex-session-e2e.test.js
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const { readCodexMeta } = require('../mcp-server/codex-session');

if (process.env.LAGRANGE_CODEX_E2E !== '1') {
  console.log('SKIP codex-session-e2e (set LAGRANGE_CODEX_E2E=1 to run)');
  process.exit(0);
}

const probeDir = process.env.LAGRANGE_CODEX_E2E_AGY_DIR;
if (!probeDir || !path.isAbsolute(probeDir)) {
  throw new Error('LAGRANGE_CODEX_E2E_AGY_DIR must be an absolute directory containing the disposable agy probe.');
}

const probeName = process.platform === 'win32' ? 'agy.exe' : 'agy';
if (!fs.existsSync(path.join(probeDir, probeName))) {
  throw new Error(`Disposable agy probe not found: ${path.join(probeDir, probeName)}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return !processAlive(pid);
}

function parseEvents(stdout) {
  return stdout.split(/\r?\n/).flatMap(line => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

async function main() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-codex-session-e2e-with-spaces-'));
  const env = {
    ...process.env,
    PATH: probeDir + path.delimiter + process.env.PATH
  };
  const approval = 'plugins.lagrange@kzvilla-lagrange-codex.mcp_servers.lagrange.tools.agy_session_summary.approval_mode="approve"';
  const prompt = `Call the lagrange agy_session_summary tool exactly once with cwd "${runDir}", focus "full", and timeout_minutes -0.99. Do not call any other tool. Report the tool result verbatim.`;
  const result = spawnSync('codex', [
    'exec', '--dangerously-bypass-hook-trust', '--sandbox', 'read-only',
    '--skip-git-repo-check', '-C', runDir, '-c', approval, '--json', prompt
  ], { cwd: runDir, env, encoding: 'utf8', timeout: 120000 });
  const events = parseEvents(result.stdout || '');
  const threadId = events.find(event => event.type === 'thread.started')?.thread_id;
  const toolEvents = events.filter(event =>
    event.item?.type === 'mcp_tool_call' && event.item?.tool === 'agy_session_summary'
  );
  const toolCall = events.find(event =>
    event.type === 'item.completed' &&
    event.item?.type === 'mcp_tool_call' &&
    event.item?.tool === 'agy_session_summary'
  );

  await group('Codex real resuelve la sesión activa mediante el hook', () => {
    check('codex exec termina correctamente', result.status === 0, result.stderr || result.error?.message);
    check('la sesión entrega thread_id', Boolean(threadId), result.stdout);
    check('Codex llama agy_session_summary una sola vez',
      toolEvents.length === 2 && new Set(toolEvents.map(event => event.item.id)).size === 1,
      JSON.stringify(toolEvents));
    check('el handler supera la resolución y alcanza el watchdog',
      /watchdog timed out/.test(toolCall?.item?.result?.content?.[0]?.text || ''),
      JSON.stringify(toolCall));
  });

  if (threadId) {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const pointerFile = path.join(codexHome, 'plugins', 'data', 'lagrange-kzvilla-lagrange-codex', 'session-sources', `${threadId}.json`);
    const pointer = fs.existsSync(pointerFile) ? JSON.parse(fs.readFileSync(pointerFile, 'utf8')) : null;
    const meta = pointer?.transcript_path ? readCodexMeta(pointer.transcript_path) : null;
    await group('el puntero persistido conserva identidad y cierre', () => {
      check('SessionStart creó el puntero exacto', Boolean(pointer), pointerFile);
      check('el puntero conserva host e identidad', pointer?.host === 'codex' && pointer?.session_id === threadId, JSON.stringify(pointer));
      check('SessionEnd lo marcó inactivo', pointer?.active === false, JSON.stringify(pointer));
      check('cwd con espacios se conserva', path.resolve(pointer?.cwd || '') === path.resolve(runDir), JSON.stringify(pointer));
      check('el transcript existe y coincide con el thread_id', meta?.sessionId === threadId, JSON.stringify(meta));
    });
  }

  const pidFiles = ['parent.pid', 'spawned-grandchild.pid', 'grandchild.pid'];
  await group('el watchdog no deja procesos huérfanos', () => {
    for (const name of pidFiles) {
      const file = path.join(runDir, name);
      const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) : NaN;
      check(`${name} fue registrado`, Number.isInteger(pid) && pid > 0, String(pid));
      check(`${name} ya no está vivo`, Number.isInteger(pid) && waitForExit(pid), String(pid));
    }
  });

  if (report()) fs.rmSync(runDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}

main().catch(error => { console.error(error); process.exit(1); });
