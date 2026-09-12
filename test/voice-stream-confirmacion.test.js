/**
 * Charla con freno (plan-charla-modo-agente): con `confirmacion`, la sesión
 * corre agy sin --dangerously-skip-permissions, junta lo que agy niega y, con
 * `confirm`, lo relanza con skip sobre la misma conversación; al cerrar ese
 * turno vuelve sin skip. Sin `confirmacion`, nada cambia.
 *
 * Con el stub de agy en modo interactivo (test/stub-spawn.js): los
 * lanzamientos quedan en CAPTURE_FILE y los turnos de stdin en
 * CAPTURE_STDIN_FILE.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const texto = (r) => (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || '';
const esError = (r) => !!(r.result && r.result.isError);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = (args) => args.includes('--dangerously-skip-permissions');
const valor = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-voz-'));
  const capture = path.join(dir, 'capture.jsonl');
  const stdinCap = path.join(dir, 'stdin.jsonl');
  fs.writeFileSync(capture, '');
  fs.writeFileSync(stdinCap, '');
  process.env.CAPTURE_STDIN_FILE = stdinCap; // startServer copia process.env

  const server = startServer({ cwd: dir, captureFile: capture });
  await server.initialize();

  const lineas = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spawns = () => lineas(capture).filter((l) => l.args);
  const kills = () => lineas(capture).filter((l) => l.event === 'kill').length;
  const ultimoTurno = () => lineas(stdinCap).slice(-1)[0] || { linea: '' };
  const llamar = (action, extra = {}) => server.callTool('agy_voice_stream', { action, cwd: dir, ...extra });
  const abrir = async (extra = {}) => {
    const r = await llamar('start', { prewarm_voicebox: false, ...extra });
    const m = /stream_id: `([^`]+)`/.exec(texto(r));
    if (!m) throw new Error(`start sin stream_id: ${texto(r)}`);
    return m[1];
  };
  const drenarTurno = async (id, ms = 5000) => {
    const limite = Date.now() + ms;
    const sentences = [];
    while (Date.now() < limite) {
      const d = JSON.parse(texto(await llamar('drain', { stream_id: id })));
      sentences.push(...d.sentences);
      if (d.turn_complete) return { ...d, sentences };
      await esperar(50);
    }
    throw new Error('el turno no cerró');
  };
  const esperarSpawn = async (n, ms = 5000) => {
    const limite = Date.now() + ms;
    while (Date.now() < limite) {
      const sp = spawns();
      if (sp.length > n) return sp[n].args;
      await esperar(50);
    }
    return null;
  };

  try {
    await group('sin confirmacion: lo de siempre', async () => {
      const n = spawns().length;
      const id = await abrir();
      const a = spawns()[n].args;
      check('--mode plan', valor(a, '--mode') === 'plan', JSON.stringify(a));
      check('con skip', skip(a));
      check('priming de siempre', /No escribas, edites ni planifiques/.test(ultimoTurno().linea));
      check('confirm: error', esError(await llamar('confirm', { stream_id: id })));
      check('stop_exec: no hace nada', /No hay ninguna ejecución/.test(texto(await llamar('stop_exec', { stream_id: id }))));
      await llamar('stop', { stream_id: id });

      // Sin cwd del llamador, el priming no nombra el process.cwd() de respaldo.
      const r = await server.callTool('agy_voice_stream', { action: 'start', prewarm_voicebox: false, confirmacion: true });
      const sinCwd = /stream_id: `([^`]+)`/.exec(texto(r))[1];
      check('sin cwd, el priming no nombra ningún directorio', !JSON.parse(ultimoTurno().linea).message.content.includes('El proyecto está en'));
      await llamar('stop', { stream_id: sinCwd });
    });

    await group('con confirmacion: niega, confirma, ejecuta y vuelve', async () => {
      const n = spawns().length;
      const id = await abrir({ confirmacion: true });
      const a = spawns()[n].args;
      check('accept-edits', valor(a, '--mode') === 'accept-edits', JSON.stringify(a));
      check('sin skip', !skip(a));
      check('priming con freno', /la charla me pregunta/.test(ultimoTurno().linea));
      check('el priming nombra el cwd que pasó el llamador', JSON.parse(ultimoTurno().linea).message.content.includes(`El proyecto está en ${dir}.`));
      check('confirm sin nada negado: error', esError(await llamar('confirm', { stream_id: id })));

      await llamar('send', { stream_id: id, text: 'commiteá NEGAR_COMANDO git status' });
      const t1 = await drenarTurno(id);
      check('el turno cierra con la negada', JSON.stringify(t1.negadas) === JSON.stringify([{ tipo: 'command', objetivo: 'git status' }]), JSON.stringify(t1.negadas));

      const n2 = spawns().length;
      const rc = await llamar('confirm', { stream_id: id });
      check('confirm responde', !esError(rc), texto(rc));
      const e = spawns()[n2] ? spawns()[n2].args : [];
      check('ejecución con skip', skip(e), JSON.stringify(e));
      check('sobre la misma conversación', valor(e, '--conversation') === 'stub-conversation-id');
      check('en accept-edits', valor(e, '--mode') === 'accept-edits');
      check('el turno autoriza lo negado', /^.*Autorizo por voz: command git status/.test(ultimoTurno().linea), ultimoTurno().linea);
      const st = JSON.parse(texto(await llamar('status', { stream_id: id })));
      check('mismo stream_id, ejecutando', st.stream_id === id && st.ejecutando === true, JSON.stringify(st));
      check('send durante la ejecución: error', esError(await llamar('send', { stream_id: id, text: 'otra cosa' })));
      check('confirm durante la ejecución: error', esError(await llamar('confirm', { stream_id: id })));

      await drenarTurno(id);
      const v = await esperarSpawn(n2 + 1);
      check('al cerrar vuelve sin skip', v && !skip(v), JSON.stringify(v));
      check('y retoma la conversación', v && valor(v, '--conversation') === 'stub-conversation-id');

      await llamar('send', { stream_id: id, text: 'hola' });
      const t2 = await drenarTurno(id);
      check('el turno siguiente anda: el close del hijo viejo no cerró la sesión', t2.sentences.includes('STUBBED RESPONSE'), JSON.stringify(t2.sentences));
      check('el turno siguiente descarta la pendiente', esError(await llamar('confirm', { stream_id: id })));
      await llamar('stop', { stream_id: id });
    });

    await group('stop_exec corta una ejecución colgada', async () => {
      const id = await abrir({ confirmacion: true });
      await llamar('send', { stream_id: id, text: 'NEGAR_COMANDO COLGAR' });
      await drenarTurno(id);
      const n = spawns().length;
      const k = kills();
      await llamar('confirm', { stream_id: id });
      const rs = await llamar('stop_exec', { stream_id: id });
      check('stop_exec responde', !esError(rs), texto(rs));
      check('mató al hijo colgado', kills() > k);
      const t = await drenarTurno(id);
      check('el turno cortado cierra', t.turn_complete === true && t.ejecutando === false);
      const sp = spawns().slice(n).map((s) => skip(s.args));
      check('ejecución con skip y vuelta sin skip', JSON.stringify(sp) === '[true,false]', JSON.stringify(sp));
      await llamar('send', { stream_id: id, text: 'hola' });
      check('la charla sigue', (await drenarTurno(id)).sentences.includes('STUBBED RESPONSE'));
      await llamar('stop', { stream_id: id });
    });
  } finally {
    await server.stop();
    removeFixture(dir);
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
