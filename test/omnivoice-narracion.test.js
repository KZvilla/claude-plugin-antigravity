/**
 * Narración por proveedor (plan de OmniVoice): `agy_say` contra un Voicebox
 * falso y un OmniVoice falso, sin GPU ni agy.
 *
 * Regla del usuario: inmediato → OmniVoice, diferido → Voicebox; los presets
 * (sin muestra) siempre por Voicebox; con Voicebox caído, OmniVoice sigue con
 * la caché de voces. Con OmniVoice el audio llega directo (no se espera en
 * generations/ de Voicebox).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

function servidor(manejar) {
  const server = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      const r = manejar(req.method, req.url.split('?')[0], cuerpo ? JSON.parse(cuerpo) : null);
      if (!r) { res.statusCode = 404; return res.end('{}'); }
      res.statusCode = r[0];
      res.end(JSON.stringify(r[1]));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function puertoLibre() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-narr-'));
  const muestra = path.join(dir, 'alya.wav');
  fs.writeFileSync(muestra, Buffer.alloc(2048));

  const vbGenerados = [];
  const vbox = await servidor((m, url, body) => {
    if (url === '/health') return [200, { status: 'healthy', backend_variant: 'cuda' }];
    if (url === '/profiles') return [200, [
      { id: 'p-alya', name: 'Alya', language: 'es', default_engine: 'qwen' },
      { id: 'p-dora', name: 'Dora', language: 'es', default_engine: 'kokoro' }
    ]];
    if (url === '/profiles/p-alya/samples') return [200, [{ audio_path: muestra, reference_text: 'hola, soy Alya' }]];
    if (url === '/profiles/p-dora/samples') return [200, []];
    if (url === '/models/status') return [200, { models: [] }];
    if (url === '/tasks/active') return [200, { downloads: [], generations: [] }];
    if (url === '/generate' && m === 'POST') { vbGenerados.push(body); return [200, { id: `vb${vbGenerados.length}` }]; }
    return null;
  });
  const omniGenerados = [];
  const omni = await servidor((m, url, body) => {
    if (url === '/health') return [200, { status: 'healthy', backend: 'omnivoice', variant: 'fake' }];
    if (url === '/models/status') return [200, { models: [{ model_name: 'omnivoice', loaded: false, size_mb: 2400 }], generando: false, generando_desde: null }];
    if (url === '/generate' && m === 'POST') {
      omniGenerados.push(body);
      const wav = path.join(dir, `o${omniGenerados.length}.wav`);
      fs.writeFileSync(wav, Buffer.alloc(1024));
      return [200, { id: `o${omniGenerados.length}`, audio_path: wav, duration: 1, seconds: 0.3 }];
    }
    return null;
  });

  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'cwd');
  const base = path.join(dir, 'omni');
  fs.mkdirSync(path.join(base, 'venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(base, 'venv', 'Scripts', 'python.exe'), '');
  fs.mkdirSync(path.join(base, 'models', 'OmniVoice'), { recursive: true });
  fs.writeFileSync(path.join(base, 'models', 'OmniVoice', 'config.json'), '{}');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // Sin keeper ni autoarranque: los dos servers falsos "ya corren".
  fs.writeFileSync(path.join(cwd, '.claude', 'antigravity.json'), JSON.stringify({ voicebox_autostart: false, omnivoice_port: omni.port }));

  const previo = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LAGRANGE_VOICEBOX_DIR: process.env.LAGRANGE_VOICEBOX_DIR, OMNIVOICE_DIR: process.env.OMNIVOICE_DIR };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LAGRANGE_VOICEBOX_DIR: path.join(home, 'vb'), OMNIVOICE_DIR: base });
  const server = startServer({ cwd });
  const say = async (args) => {
    const res = await server.callTool('agy_say', { send_telegram: false, local_playback: false, voicebox_url: `http://127.0.0.1:${vbox.port}`, ...args }, 60000);
    return { texto: res.result && res.result.content[0].text, error: res.result && res.result.isError };
  };

  try {
    await server.initialize();
    const esperado = process.platform === 'win32';
    await group('narración por proveedor', async () => {
      if (!esperado) {
        console.log('  (OmniVoice solo se detecta en Windows: se omite)');
        check('omitido fuera de Windows', true);
        return;
      }
      let r = await say({ text: 'Hola, modo inmediato.', voice: 'Alya' });
      check('inmediato (por defecto) → OmniVoice', omniGenerados.length === 1 && vbGenerados.length === 0, r.texto);
      check('OmniVoice recibe la muestra de Voicebox y su texto', omniGenerados[0] && omniGenerados[0].ref_audio === muestra && omniGenerados[0].ref_text === 'hola, soy Alya');
      check('la salida lo dice', /Motor\*\*: OmniVoice \(modo inmediato/.test(r.texto || ''), r.texto);

      r = await say({ text: 'Hola, modo diferido.', voice: 'Alya', modo: 'diferido' });
      check('diferido → Voicebox', vbGenerados.length === 1 && omniGenerados.length === 1, r.texto);
      check('la salida lo dice', /Motor\*\*: Voicebox \(modo diferido/.test(r.texto || ''));

      r = await say({ text: 'Hola, soy Dora.', voice: 'Dora' });
      check('preset (sin muestra) → Voicebox con motivo', vbGenerados.length === 2 && /no se usó OmniVoice: .*no tiene muestra/.test(r.texto || ''), r.texto);

      r = await say({ text: 'Forzado.', voice: 'Alya', motor: 'voicebox' });
      check('motor explícito → Voicebox', vbGenerados.length === 3 && omniGenerados.length === 1);

      const muerto = await puertoLibre();
      r = await say({ text: 'Voicebox caído.', voice: 'Alya', voicebox_url: `http://127.0.0.1:${muerto}` });
      check('Voicebox caído + caché → OmniVoice igual', !r.error && omniGenerados.length === 2, r.texto);
      check('y lo dice', /voz desde la caché/.test(r.texto || ''), r.texto);

      r = await say({ text: 'Voicebox caído y diferido.', voice: 'Alya', voicebox_url: `http://127.0.0.1:${muerto}`, modo: 'diferido' });
      check('Voicebox caído y diferido → error claro (no hay a quién pedirle)', /Voicebox no está disponible/.test(r.texto || ''), r.texto);
    });
  } finally {
    await server.stop();
    await new Promise(r => vbox.server.close(r));
    await new Promise(r => omni.server.close(r));
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    removeFixture(dir);
  }
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
