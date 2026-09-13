/**
 * La personalidad la aplica agy, no el LLM de Voicebox (v0.22.1).
 *
 * Antes, `personality: true` viajaba a Voicebox, que reescribía el texto con
 * Qwen3 0.6B; en agy_narrate y en agy_say con polish, además, Gemini ya había
 * escrito en persona: doble reescritura, y lo que se oía no era lo que la
 * herramienta mostraba. Ahora la persona la pone agy una sola vez y Voicebox
 * recibe siempre `personality: false`.
 *
 * La integración usa un Voicebox falso (HTTP) y agy stubeado: se ve qué recibe
 * /generate y cuántas veces se llamó a agy.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startServer, removeFixture, REPO_ROOT } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const { getPersonaPrompt, getPolishPrompt, getNarrationPrompt } = require(path.join(REPO_ROOT, 'mcp-server', 'spoken-text.js'));
const { getSummaryPrompt } = require(path.join(REPO_ROOT, 'mcp-server', 'summary-doc.js'));

const ALYA = { id: 'p-alya', name: 'Alya', language: 'es', default_engine: 'qwen', description: 'Estudiante reservada', personality: 'Orgullosa y tsundere' };

function fakeVoicebox() {
  const generados = [];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url.split('?')[0];
    if (url === '/health') return res.end(JSON.stringify({ status: 'healthy', backend_variant: 'cuda' }));
    if (url === '/profiles') return res.end(JSON.stringify([ALYA]));
    if (url === '/models/status') return res.end(JSON.stringify({ models: [{ model_name: 'qwen-tts-1.7B', loaded: true, downloaded: true, size_mb: 4333 }] }));
    if (url === '/tasks/active') return res.end(JSON.stringify({ downloads: [], generations: [] }));
    if (url === '/generate' && req.method === 'POST') {
      let cuerpo = '';
      req.on('data', c => { cuerpo += c; });
      req.on('end', () => {
        generados.push(JSON.parse(cuerpo));
        res.end(JSON.stringify({ id: `g${generados.length}`, status: 'generating' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, generados, url: `http://127.0.0.1:${server.address().port}` })));
}

async function main() {
  await group('prompts de persona', () => {
    const p = getPersonaPrompt('Terminé la tarea y los tests pasaron.', 'es', ALYA);
    check('nombra la persona', /Alya/.test(p) && /Orgullosa y tsundere/.test(p) && /Estudiante reservada/.test(p));
    check('REWRITE ONLY', /REWRITE ONLY/.test(p));
    check('conserva todo el contenido, sin condensar', /Keep ALL of the content/.test(p) && !/at most 3 sentences/.test(p));
    check('el polish sí condensa (por eso no se reusa)', /at most 3 sentences/.test(getPolishPrompt('x', 'es', ALYA, true)));

    const sin = getSummaryPrompt('full', true);
    const con = getSummaryPrompt('full', true, ALYA);
    check('resumen con persona: la incluye en el digest', /Orgullosa y tsundere/.test(con) && /ONLY the spoken digest/.test(con));
    check('resumen sin persona: idéntico al de siempre', !/Personality:/.test(sin) && con.startsWith(sin));
    check('handoff también recibe la persona', /Orgullosa y tsundere/.test(getSummaryPrompt('handoff', true, ALYA)));
    check('sin digest, la persona no aparece', !/Orgullosa/.test(getSummaryPrompt('full', false, ALYA)));
  });

  await group('prompts con alma (almas, fase 1)', () => {
    const ALMA = 'Sos Alya, del ALMA DE PRUEBA.';
    const p = getPersonaPrompt('Terminé la tarea.', 'es', ALYA, ALMA);
    check('persona: trae el alma', p.includes(ALMA) && /soul file alma\.md of Alya/.test(p));
    check('persona: no usa los campos del perfil', !/Orgullosa y tsundere/.test(p) && !/Derived from Voicebox Profile/.test(p));
    check('persona: REWRITE ONLY intacto', /REWRITE ONLY/.test(p) && /Keep ALL of the content/.test(p) && /Never invent a status/.test(p));
    check('persona: el alma va antes de las reglas', p.indexOf(ALMA) < p.indexOf('REWRITE ONLY'));
    check('persona: el alma no es fuente de hechos', /never take facts, names or events from it/.test(p));
    check('persona sin alma: la del perfil', /Derived from Voicebox Profile/.test(getPersonaPrompt('x', 'es', ALYA)));

    const pol = getPolishPrompt('x', 'es', ALYA, true, ALMA);
    check('polish: trae el alma y sigue condensando', pol.includes(ALMA) && /at most 3 sentences/.test(pol) && !/Orgullosa/.test(pol));
    check('polish sin personality: ni alma ni persona', !getPolishPrompt('x', 'es', ALYA, false, ALMA).includes(ALMA));

    const cp = {
      userGoal: 'arreglar el chunker',
      filesModified: ['C:/repo/mcp-server/lib/sentence-chunker.js'],
      testExecutions: [{}],
      overallTestStatus: 'PASSED',
      assistantNotes: ''
    };
    const n = getNarrationPrompt(cp, 'es', ALYA, true, ALMA);
    check('narración: trae el alma, no el perfil', n.includes(ALMA) && !/Orgullosa/.test(n));
    check('narración: exactitud del checkpoint', /remain strictly accurate/.test(n));
    check('narración: path.basename en su nuevo módulo', n.includes('sentence-chunker.js') && !n.includes('C:/repo'));
    check('narración sin personality: sin persona', !/Speaker Persona/.test(getNarrationPrompt(cp, 'es', ALYA, false, ALMA)));

    const d = getSummaryPrompt('full', true, { ...ALYA, alma: ALMA });
    check('digest: trae el alma', d.includes(ALMA) && !/Orgullosa/.test(d));
    check('digest: solo el digest, nunca el documento', /Write ONLY the spoken digest \(not the document\)/.test(d));
    check('digest sin digest pedido: sin alma', !getSummaryPrompt('full', false, { ...ALYA, alma: ALMA }).includes(ALMA));
  });

  const vbox = await fakeVoicebox();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-cwd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-home-'));
  const captura = path.join(cwd, 'captura.jsonl');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  // Sin keeper: el Voicebox falso "ya corre" y no hay nada que levantar.
  fs.writeFileSync(path.join(cwd, '.claude', 'antigravity.json'), JSON.stringify({ voicebox_autostart: false }));
  const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LAGRANGE_VOICEBOX_DIR: process.env.LAGRANGE_VOICEBOX_DIR };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LAGRANGE_VOICEBOX_DIR = path.join(home, 'vb');
  fs.writeFileSync(captura, '');

  const server = startServer({ cwd, captureFile: captura });
  const spawnsDeAgy = () => fs.readFileSync(captura, 'utf8').split('\n').filter(l => l.includes('"cmd"')).length;
  try {
    await server.initialize();
    await group('agy_say con personality: la persona la pone agy', async () => {
      const base = { voice: 'Alya', send_telegram: false, local_playback: false, voicebox_url: vbox.url };
      let res = await server.callTool('agy_say', { ...base, text: 'Hola, terminé la tarea.', personality: true }, 60000);
      let texto = res.result && res.result.content[0].text;
      check('no es error', !(res.result && res.result.isError), texto);
      check('se llamó a agy una vez', spawnsDeAgy() === 1, String(spawnsDeAgy()));
      const g1 = vbox.generados[0] || {};
      check('Voicebox recibe personality: false', g1.personality === false, JSON.stringify(g1));
      check('y el texto reescrito por agy', g1.text === 'STUBBED RESPONSE', g1.text);
      check('la salida dice que lo reescribió agy', /Reescrito en personaje por agy/.test(texto || ''));
      check('y que está en personaje', /En personaje, escrito por agy/.test(texto || ''));

      res = await server.callTool('agy_say', { ...base, text: 'Hola sin persona.' }, 60000);
      texto = res.result && res.result.content[0].text;
      check('sin personality: no se llama a agy', spawnsDeAgy() === 1, String(spawnsDeAgy()));
      const g2 = vbox.generados[1] || {};
      check('sin personality: texto original y personality: false', g2.text === 'Hola sin persona.' && g2.personality === false, JSON.stringify(g2));
      check('sin personality: modo neutral', /Neutral/.test(texto || ''));
    });

    // Almas, fase 1: las narraciones con personality hablan desde alma.md.
    const spawns = () => fs.readFileSync(captura, 'utf8').split('\n').filter(l => l.includes('"cmd"')).map(l => JSON.parse(l));
    const ultimo = () => spawns()[spawns().length - 1];
    const promptDe = s => (s && s.args[s.args.indexOf('-p') + 1]) || '';
    const agenteDe = s => (s && s.args.includes('--agent') ? s.args[s.args.indexOf('--agent') + 1] : null);
    const almaMd = path.join(home, '.claude', 'lagrange-almas', 'alya', 'alma.md');
    const diario = () => {
      const ruta = path.join(home, '.claude', 'lagrange-almas', 'alya', 'diario.jsonl');
      return fs.existsSync(ruta) ? fs.readFileSync(ruta, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    };
    const base = { voice: 'Alya', send_telegram: false, local_playback: false, voicebox_url: vbox.url };

    await group('agy_say con alma: lagrange-alma sin skip, semilla y diario', async () => {
      const primero = spawns()[0];
      check('corrió como lagrange-alma', agenteDe(primero) === 'lagrange-alma', JSON.stringify(primero && primero.args));
      check('sin skip ni --mode plan', !primero.args.includes('--dangerously-skip-permissions') && !primero.args.includes('--mode'));
      check('sembró alma.md desde el perfil', fs.existsSync(almaMd) && fs.readFileSync(almaMd, 'utf8').includes('Orgullosa y tsundere'));
      check('el prompt trae el alma', /soul file alma\.md/.test(promptDe(primero)) && promptDe(primero).includes('Orgullosa y tsundere'));
      check('instaló el agent.md en el HOME', fs.existsSync(path.join(home, '.gemini', 'config', 'agents', 'lagrange-alma', 'agent.md')));
      const d = diario();
      check('diario: la semilla y la narración', d.some(e => e.tipo === 'semilla') && d.some(e => e.superficie === 'narracion' && e.herramienta === 'agy_say'));

      fs.writeFileSync(almaMd, '# Alya\n\nSos una voz EDITADA A MANO.\n');
      const res = await server.callTool('agy_say', { ...base, text: 'Otra vez.', personality: true }, 60000);
      const texto = (res.result && res.result.content[0].text) || '';
      check('la edición llega al prompt', promptDe(ultimo()).includes('EDITADA A MANO') && !promptDe(ultimo()).includes('Orgullosa y tsundere'));
      check('la salida nombra el alma', /desde el alma `alya`/.test(texto), texto);
      check('ya no dice que la sembró', !/sembrada ahora/.test(texto));

      await server.callTool('agy_say', { ...base, text: 'Pulido.', personality: true, polish: true }, 60000);
      check('polish con alma: lagrange-alma y el alma editada', agenteDe(ultimo()) === 'lagrange-alma' && promptDe(ultimo()).includes('EDITADA A MANO'));

      await server.callTool('agy_narrate', { ...base, personality: true, cwd }, 60000);
      check('agy_narrate con alma: lagrange-alma y el alma editada', agenteDe(ultimo()) === 'lagrange-alma' && promptDe(ultimo()).includes('EDITADA A MANO'), JSON.stringify(ultimo() && ultimo().args).slice(0, 300));

      const narraciones = diario().filter(e => e.superficie === 'narracion' && e.herramienta);
      check('diario: cuatro narraciones, ninguna sin personality', narraciones.length === 4, String(narraciones.length));
    });

    await group('sin el agente: el régimen de siempre, y lo dice', async () => {
      const previoAgentes = process.env.STUB_AGENTS;
      process.env.STUB_AGENTS = '';
      const sinAgente = startServer({ cwd, captureFile: captura });
      if (previoAgentes === undefined) delete process.env.STUB_AGENTS;
      else process.env.STUB_AGENTS = previoAgentes;
      try {
        await sinAgente.initialize();
        const res = await sinAgente.callTool('agy_say', { ...base, text: 'Sin agente.', personality: true }, 60000);
        const texto = (res.result && res.result.content[0].text) || '';
        check('no es error', !(res.result && res.result.isError), texto);
        check('vuelve a skip + plan', ultimo().args.includes('--dangerously-skip-permissions') && agenteDe(ultimo()) === null);
        check('pero con el alma', promptDe(ultimo()).includes('EDITADA A MANO'));
        check('y lo explica', /sin el agente lagrange-alma/.test(texto), texto);
      } finally {
        await sinAgente.stop();
      }
    });
  } finally {
    await server.stop();
    await new Promise(r => vbox.server.close(r));
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    removeFixture(cwd);
    removeFixture(home);
  }

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
