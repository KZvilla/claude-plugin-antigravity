/**
 * BE-015 — Compatibilidad de modelos y el flag --effort en el servidor MCP.
 *
 * El incidente del 2026-09-11: agy empezó a abortar con "--effort is not
 * supported for the current model" cuando recibía `--effort` sin `--model` y
 * su settings.json resolvía Claude Opus. Estos tests fijan la regla:
 *
 *  - un esfuerzo POR DEFECTO (config/entorno) solo viaja con un modelo Gemini
 *    base conocido; sin modelo, o con Claude/GPT-OSS/sufijado, no se manda;
 *  - un esfuerzo PEDIDO explícitamente nunca se descarta en silencio: si el
 *    modelo no lo admite, la llamada se rechaza antes del spawn con un mensaje.
 *
 * El HOME se falsea para que el antigravity.json global de quien corre los
 * tests no contamine la configuración.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

function escribirConfig(dir, config) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'antigravity.json'), JSON.stringify(config));
}

function valorDe(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-effort-test-'));
  const capture = path.join(fixture, 'capture.jsonl');
  fs.writeFileSync(capture, '');

  const home = path.join(fixture, 'home');
  const sinModelo = path.join(fixture, 'proyecto-sin-modelo');
  const conGemini = path.join(fixture, 'proyecto-con-gemini');
  fs.mkdirSync(home, { recursive: true });
  escribirConfig(sinModelo, { effort: 'high' });
  escribirConfig(conGemini, { model: 'gemini-3.8-flash', effort: 'high' });

  // Log de sesión mínimo para agy_session_summary (se encuentra por el nombre
  // de la carpeta del proyecto, estrategia fuzzy de getProjectLogDir).
  const logDir = path.join(home, '.claude', 'projects', path.basename(sinModelo));
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'sess-effort.jsonl'), [
    { type: 'user', cwd: sinModelo, timestamp: '2026-09-11T04:00:00Z', message: { role: 'user', content: 'Arreglá el flag effort.' } },
    { type: 'assistant', timestamp: '2026-09-11T04:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Listo, quedó arreglado.' }] } }
  ].map(l => JSON.stringify(l)).join('\n') + '\n');

  const envPrevio = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, AGY_EFFORT: process.env.AGY_EFFORT, AGY_MODEL: process.env.AGY_MODEL };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.AGY_EFFORT;
  delete process.env.AGY_MODEL;
  const server = startServer({ cwd: fixture, captureFile: capture });
  for (const [k, v] of Object.entries(envPrevio)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await server.initialize();

  // Devuelve la respuesta y los spawns de agy que produjo esta llamada.
  let vistos = 0;
  const llamar = async (tool, args, timeoutMs) => {
    const res = await server.callTool(tool, args, timeoutMs);
    const lineas = fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      .filter(l => Array.isArray(l.args));
    const nuevos = lineas.slice(vistos);
    vistos = lineas.length;
    const texto = (res.result && res.result.content && res.result.content.map(c => c.text).join('\n')) || '';
    return { res, texto, spawns: nuevos };
  };

  try {
    await group('un esfuerzo por defecto no viaja sin un modelo que lo admita (el incidente)', async () => {
      let r = await llamar('agy_run', { prompt: 'x', cwd: sinModelo });
      check('agy_run: config con effort y sin modelo no manda --effort', r.spawns.length === 1 && !r.spawns[0].args.includes('--effort'), JSON.stringify(r.spawns.map(s => s.args)));

      r = await llamar('agy_plan', { task: 'x', cwd: sinModelo });
      check('agy_plan: tampoco', r.spawns.length === 1 && !r.spawns[0].args.includes('--effort'));

      r = await llamar('agy_session_summary', { session_id: 'sess-effort', cwd: sinModelo }, 60000);
      check('agy_session_summary: el resumen corrió', r.spawns.length >= 1, r.texto.slice(0, 300));
      check('agy_session_summary: sin modelo no manda --effort (antes: high fijo)', r.spawns.length >= 1 && !r.spawns[0].args.includes('--effort'));

      r = await llamar('agy_run', { prompt: 'x', model: 'claude-opus-4-6-thinking', cwd: sinModelo });
      check('agy_run: defecto con Claude no manda --effort', r.spawns.length === 1 && !r.spawns[0].args.includes('--effort'));
      check('agy_run: pero sí --model', r.spawns.length === 1 && valorDe(r.spawns[0].args, '--model') === 'claude-opus-4-6-thinking');

      r = await llamar('agy_run', { prompt: 'x', model: 'gemini-3.8-flash-high', cwd: sinModelo });
      check('agy_run: defecto con Gemini sufijado no manda --effort', r.spawns.length === 1 && !r.spawns[0].args.includes('--effort'));

      r = await llamar('agy_run', { prompt: 'x', cwd: conGemini });
      check('agy_run: defecto con Gemini base sí manda --effort high', r.spawns.length === 1 && valorDe(r.spawns[0].args, '--effort') === 'high');
    });

    await group('un esfuerzo pedido explícitamente se rechaza con mensaje, no se descarta', async () => {
      let r = await llamar('agy_run', { prompt: 'x', model: 'claude-opus-4-6-thinking', effort: 'high', cwd: sinModelo });
      check('Claude + effort: no llega a lanzar agy', r.spawns.length === 0);
      check('Claude + effort: explica el motivo', /no admite effort/.test(r.texto), r.texto.slice(0, 300));

      r = await llamar('agy_run', { prompt: 'x', model: 'gpt-oss-120b-medium', effort: 'low', cwd: sinModelo });
      check('GPT-OSS + effort: rechazado antes del spawn', r.spawns.length === 0 && /no admite effort/.test(r.texto));

      r = await llamar('agy_run', { prompt: 'x', model: 'gemini-3.8-flash-high', effort: 'low', cwd: sinModelo });
      check('sufijado + effort: rechazado antes del spawn', r.spawns.length === 0 && /ya fija el esfuerzo/.test(r.texto), r.texto.slice(0, 300));

      r = await llamar('agy_run', { prompt: 'x', model: 'gemini-3.8-flash', effort: 'medium', cwd: sinModelo });
      check('Gemini base + effort explícito: pasa tal cual', r.spawns.length === 1 && valorDe(r.spawns[0].args, '--effort') === 'medium');
    });
  } finally {
    await server.stop();
    removeFixture(fixture);
  }
  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
