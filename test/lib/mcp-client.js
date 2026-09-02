/**
 * Minimal JSON-RPC-over-stdio client for driving mcp-server/index.js in tests.
 * No dependencies, matching the server itself.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * Start the MCP server as a child process.
 *
 * @param {object}  opts
 * @param {string}  opts.serverJs   Server entry point. Defaults to this repo's.
 *                                  Override (SERVER_JS) to run a test against an
 *                                  older checkout and confirm it fails there.
 * @param {string}  opts.cwd        Working directory, which decides which
 *                                  .claude/antigravity.json the server picks up.
 * @param {string}  opts.captureFile Path for the spawn stub's capture log. When
 *                                  set, the agy binary is stubbed out.
 */
function startServer({ serverJs, cwd, captureFile } = {}) {
  const entry = serverJs || process.env.SERVER_JS || path.join(REPO_ROOT, 'mcp-server', 'index.js');
  const env = { ...process.env };

  if (captureFile) {
    env.CAPTURE_FILE = captureFile;
    // Forward slashes: NODE_OPTIONS is re-parsed as a shell-ish string and
    // backslashes get eaten on Windows.
    env.NODE_OPTIONS = `--require "${path.join(__dirname, '..', 'stub-spawn.js').replace(/\\/g, '/')}"`;
  }

  const child = spawn(process.execPath, [entry], {
    cwd: cwd || REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });

  const pending = new Map();
  let buf = '';

  child.stdout.on('data', chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });

  // The server logs to stderr by design; stay quiet unless a test asks for it.
  child.stderr.on('data', d => {
    if (process.env.VERBOSE) process.stderr.write('[server] ' + d);
  });

  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 20000);
  });

  return {
    child,
    request,
    initialize: () => request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'antigravity-tests', version: '1.0' }
    }),
    listTools: () => request('tools/list', {}),
    callTool: (name, args) => request('tools/call', { name, arguments: args }),
    // Awaits the real exit. `child.kill()` only sends the signal, and on
    // Windows the process keeps a handle on its cwd until it is actually gone
    // — which is the fixture directory the caller is about to delete.
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const done = () => resolve();
      child.once('exit', done);
      child.kill();
      setTimeout(() => { child.removeListener('exit', done); resolve(); }, 2000).unref();
    })
  };
}

/**
 * Deletes a fixture directory, tolerating Windows handle-release lag.
 *
 * Regression context: research.test.js failed roughly one run in three with
 * `EBUSY: resource busy or locked, rmdir` — every assertion green, only the
 * cleanup throwing, so the suite exited non-zero for no real reason. Awaiting
 * the server's exit fixes the common case; the retries cover the rest, since
 * the OS can hold a directory handle briefly after the process is gone.
 */
function removeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

module.exports = { startServer, removeFixture, REPO_ROOT };
