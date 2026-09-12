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

/**
 * `--input-format stream-json` (la charla y executeAgyStdin): el proceso queda
 * vivo y responde un turno por cada línea de stdin, y se cierra cuando stdin
 * termina y no queda nada por responder, o al matarlo. Antes stdin se tragaba
 * todo y el proceso cerraba solo, así que no había forma de probar una sesión
 * de varios turnos ni un relanzamiento.
 *
 * Turnos especiales (plan-charla-modo-agente):
 *   - "NEGAR_COMANDO <cmd>" sin --dangerously-skip-permissions: la negación
 *     real de agy (sondas A/C): run_command ACTIVE, ERROR de permiso y un
 *     result con respuesta vacía y denied_actions.
 *   - una autorización ("Autorizo por voz…") que nombra COLGAR no responde
 *     nunca, para probar stop_exec.
 * Con CAPTURE_STDIN_FILE, cada línea de stdin se anota ahí (no en
 * CAPTURE_FILE: hay suites que cuentan sus líneas como lanzamientos).
 */
function procesoInteractivo(child, args, opts) {
  const i = args.indexOf('--conversation');
  const cid = i >= 0 ? args[i + 1] : 'stub-conversation-id';
  const holdMs = parseInt(process.env.STUB_HOLD_MS, 10) || 0;
  let cerrado = false;
  let pendientes = 0;
  let finPedido = false;
  let paso = 0;

  const emitir = (ev) => { if (!cerrado) child.stdout.write(JSON.stringify(ev) + '\n'); };
  const cerrar = (code) => {
    if (cerrado) return;
    cerrado = true;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code));
  };
  const quizasCerrar = () => { if (finPedido && pendientes === 0) cerrar(0); };

  const responder = (contenido) => {
    const base = paso;
    paso += 10;
    if (/Autorizo por voz/.test(contenido) && /COLGAR/.test(contenido)) return;
    const m = /NEGAR_COMANDO (.+)$/.exec(contenido);
    if (m && !args.includes('--dangerously-skip-permissions')) {
      const p = { CommandLine: m[1] };
      const pasoTool = (state, extra = {}) => ({ event: 'step_update', step_update: {
        conversation_id: cid, step_index: base + 1, state, step_type: 'tool', tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: p, ...extra }
      } });
      emitir(pasoTool('ACTIVE'));
      emitir(pasoTool('ERROR', { error: { type: 'TOOL_ERROR', message: `permission check failed for command "${m[1]}": user denied permission to run command:\n${m[1]}` } }));
      emitir({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
      return;
    }
    emitir({ event: 'step_update', step_update: { conversation_id: cid, step_index: base + 1, state: 'DONE', step_type: 'agent_response', text_delta: 'STUBBED RESPONSE' } });
    emitir({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'STUBBED RESPONSE', duration_seconds: 1, usage: USAGE_STUB } });
  };

  child.stdin = {
    write(linea) {
      if (process.env.CAPTURE_STDIN_FILE) {
        fs.appendFileSync(process.env.CAPTURE_STDIN_FILE, JSON.stringify({ args, linea: String(linea).trim() }) + '\n');
      }
      let contenido = '';
      try { contenido = JSON.parse(linea).message.content || ''; } catch {}
      pendientes++;
      const tarea = () => { responder(contenido); pendientes--; quizasCerrar(); };
      if (holdMs > 0) setTimeout(tarea, holdMs);
      else setImmediate(tarea);
      return true;
    },
    end() { finPedido = true; setImmediate(quizasCerrar); }
  };

  let killed = false;
  child.kill = () => {
    if (killed) return;
    killed = true;
    fs.appendFileSync(CAPTURE_FILE, JSON.stringify({ event: 'kill', cwd: opts && opts.cwd }) + '\n');
    cerrar(1);
  };

  setImmediate(() => emitir({ event: 'init', conversation_id: cid, init: {} }));
  return child;
}

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
  if (args.includes('--input-format')) return procesoInteractivo(child, args, opts);
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
