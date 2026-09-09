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
const { PassThrough } = require('stream');
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
  // Stream real, no un EventEmitter cualquiera: FEAT-009 lee stdout con
  // `readline.createInterface` (executeAgyStreaming), que exige un Readable
  // de verdad (`.resume`, `.pause`) — un EventEmitter que solo finge emitir
  // 'data' revienta con "input.resume is not a function". PassThrough emite
  // 'data' de verdad al escribirle, así que sirve para ambos consumidores
  // (executeAgy, que solo hace `.on('data', ...)`, y executeAgyStreaming).
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write() {}, end() {} };

  // Sin STUB_HOLD_MS, el comportamiento es idéntico al de antes de FEAT-012
  // (resuelve en el próximo tick). Con él, el "proceso" se queda vivo esos ms
  // — lo que permite a un test escribir el centinela de detención a mitad de
  // camino y comprobar que executeAgy lo mata antes de que termine solo,
  // en vez de tener que esperar el timeout real de 15+ minutos.
  let killed = false;
  child.kill = () => {
    if (killed) return;
    killed = true;
    fs.appendFileSync(CAPTURE_FILE, JSON.stringify({ event: 'kill', cwd: opts && opts.cwd }) + '\n');
  };

  // FEAT-009: agy_fanout ahora pide siempre --output-format stream-json (lo
  // fija executeAgyStreaming cuando no viene en los args). El resto de las
  // tools (agy_run, etc.) sigue pidiendo `json` explícito, así que ambos
  // formatos conviven acá según lo que la llamada real haya pedido.
  const esStreamJson = args.includes('stream-json');

  const holdMs = parseInt(process.env.STUB_HOLD_MS, 10) || 0;
  const emitirRespuesta = () => {
    if (killed) return; // ya lo mataron: no simular un cierre exitoso por detrás.
    if (esStreamJson) {
      const cid = 'stub-conversation-id';
      const eventos = [
        { event: 'init', conversation_id: cid, init: {} },
        { event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'STUBBED RESPONSE' } },
        { event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'STUBBED RESPONSE', duration_seconds: 1, usage: USAGE_STUB } }
      ];
      for (const ev of eventos) child.stdout.write(JSON.stringify(ev) + '\n');
    } else {
      child.stdout.write(JSON.stringify({
        response: 'STUBBED RESPONSE',
        conversation_id: 'stub-conversation-id',
        duration_seconds: 1,
        usage: USAGE_STUB
      }));
    }
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
  };

  if (holdMs > 0) setTimeout(emitirRespuesta, holdMs);
  else setImmediate(emitirRespuesta);

  return child;
};
