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

// El servidor solo llama a recordUsage cuando la respuesta de agy trae `usage`,
// así que sin este bloque el camino de telemetría queda inalcanzable desde los
// tests. Va detrás de una bandera de entorno a propósito: emitirlo siempre haría
// que las demás suites, que no lo esperan, escribieran en el fichero de uso real
// de quien corra los tests.
const USAGE_STUB = process.env.STUB_USAGE === '1'
  ? { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 1, total_tokens: 15 }
  : undefined;

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
      duration_seconds: 1,
      usage: USAGE_STUB
    })));
    child.emit('close', 0);
  });

  return child;
};
