/**
 * Preload module that replaces child_process.spawn for `agy` invocations.
 *
 * Loaded via NODE_OPTIONS=--require, so the MCP server under test runs its real
 * code path — config loading, permission resolution, prompt building, CLI arg
 * assembly — but the binary is never launched. Every intercepted call is appended
 * to CAPTURE_FILE as one JSON line, which is what the assertions inspect.
 *
 * Non-agy spawns (if any) fall through to the real implementation.
 */
const cp = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');

const CAPTURE_FILE = process.env.CAPTURE_FILE;
const realSpawn = cp.spawn;

cp.spawn = function (cmd, args, opts) {
  if (!/agy/i.test(String(cmd))) {
    return realSpawn.apply(this, arguments);
  }

  fs.appendFileSync(CAPTURE_FILE, JSON.stringify({ cmd, args, cwd: opts && opts.cwd }) + '\n');

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};

  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({
      response: 'STUBBED RESPONSE',
      conversation_id: 'stub-conversation-id',
      duration_seconds: 1
    })));
    child.emit('close', 0);
  });

  return child;
};
