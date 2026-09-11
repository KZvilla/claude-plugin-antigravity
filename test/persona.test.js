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
const { getPersonaPrompt, getPolishPrompt } = require(path.join(REPO_ROOT, 'mcp-server', 'spoken-text.js'));
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
