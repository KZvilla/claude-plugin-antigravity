/**
 * FEAT-045 — El servidor MCP debe llevar la autoría del alma hasta el stdin de
 * notify.js. El preload captura ese proceso: no sale nada a Telegram ni se
 * espera un .wav real.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const semilla = require('../mcp-server/almas/semilla.js');

const ALYA = {
  id: 'p-alya', name: 'Alya', language: 'es', default_engine: 'qwen',
  description: 'Estudiante', personality: 'Tsundere'
};

function fakeVoicebox() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url.split('?')[0];
    if (url === '/health') return res.end(JSON.stringify({ status: 'healthy', backend_variant: 'cuda' }));
    if (url === '/profiles') return res.end(JSON.stringify([ALYA]));
    if (url === '/models/status') return res.end(JSON.stringify({ models: [{ model_name: 'qwen-tts-1.7B', loaded: true, downloaded: true }] }));
    if (url === '/tasks/active') return res.end(JSON.stringify({ downloads: [], generations: [] }));
    if (url === '/generate' && req.method === 'POST') {
      req.resume();
      return req.on('end', () => res.end(JSON.stringify({ id: `g-${Date.now()}`, status: 'generating' })));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}`
  })));
}

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'reacciones-mcp-'));
  const cwd = path.join(fixture, 'proyecto');
  const home = path.join(fixture, 'home');
  const almasDir = path.join(fixture, 'almas');
  const capturaAgy = path.join(fixture, 'agy.jsonl');
  const capturaTelegram = path.join(fixture, 'telegram.jsonl');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'antigravity.json'), JSON.stringify({ voicebox_autostart: false }));
  fs.writeFileSync(capturaAgy, '');
  fs.writeFileSync(capturaTelegram, '');
  semilla.sembrar('alya', ALYA, { env: { LAGRANGE_ALMAS_DIR: almasDir } });

  // Log mínimo para agy_narrate y agy_session_summary.
  const logDir = path.join(home, '.claude', 'projects', path.basename(cwd));
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'sess-reaccion.jsonl'), [
    { type: 'user', cwd, timestamp: '2026-09-13T10:00:00Z', message: { role: 'user', content: 'Implementá la fase cuatro.' } },
    { type: 'assistant', timestamp: '2026-09-13T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'La fase quedó lista.' }] } }
  ].map(JSON.stringify).join('\n') + '\n');

  const vbox = await fakeVoicebox();
  const previo = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LAGRANGE_ALMAS_DIR: process.env.LAGRANGE_ALMAS_DIR,
    CAPTURE_TELEGRAM_FILE: process.env.CAPTURE_TELEGRAM_FILE,
    STUB_RESPONSE: process.env.STUB_RESPONSE
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LAGRANGE_ALMAS_DIR = almasDir;
  process.env.CAPTURE_TELEGRAM_FILE = capturaTelegram;
  process.env.STUB_RESPONSE = '# Resumen\n\n'
    + 'Detalle verificable de la implementación y sus pruebas. '.repeat(12)
    + '\n\n## DIGEST HABLADO\nDigest breve de la fase cuatro.';

  const server = startServer({ cwd, captureFile: capturaAgy });
  const envios = () => fs.readFileSync(capturaTelegram, 'utf8')
    .split(/\r?\n/).filter(Boolean).map(JSON.parse).map((x) => x.payload);

  try {
    await server.initialize();
    const tools = (await server.listTools()).result.tools;

    await group('telegram_send_voice: esquema y validación opt-in', async () => {
      const tool = tools.find((t) => t.name === 'telegram_send_voice');
      const schema = tool?.inputSchema?.properties?.reaccionable;
      check('expone objeto opcional cerrado', schema?.type === 'object' && schema.additionalProperties === false);
      check('exige alma y extracto no vacíos',
        JSON.stringify(schema?.required) === '["alma","extracto"]'
          && schema?.properties?.alma?.minLength === 1
          && schema?.properties?.extracto?.minLength === 1);

      let res = await server.callTool('telegram_send_voice', { audio_path: 'C:/falsa.wav', caption: 'neutra' });
      check('sin metadato conserva el camino genérico', !res.result?.isError && envios().length === 1 && !envios()[0].reaccionable);

      res = await server.callTool('telegram_send_voice', {
        audio_path: 'C:/falsa.wav', caption: 'con alma',
        reaccionable: { alma: ' alya ', extracto: ' texto citado ' }
      });
      check('metadato válido se recorta y propaga',
        !res.result?.isError
          && envios()[1]?.reaccionable?.alma === 'alya'
          && envios()[1]?.reaccionable?.extracto === 'texto citado',
        JSON.stringify(envios()[1]));

      const antes = envios().length;
      for (const reaccionable of [
        { alma: '../alya', extracto: 'x' },
        { alma: 'alya', extracto: '   ' },
        { alma: 'fantasma', extracto: 'x' }
      ]) {
        res = await server.callTool('telegram_send_voice', { audio_path: 'C:/falsa.wav', reaccionable });
        check(`rechaza antes de notify: ${JSON.stringify(reaccionable)}`, res.result?.isError === true && envios().length === antes);
      }
    });

    const base = {
      voice: 'Alya', soul: 'alya', local_playback: false, send_telegram: true, voicebox_url: vbox.url
    };
    await group('narraciones: solo las emitidas con alma son reaccionables', async () => {
      const inicio = envios().length;
      let res = await server.callTool('agy_say', { ...base, text: 'Texto con alma.', personality: true }, 60000);
      check('agy_say con personality termina', !res.result?.isError, res.result?.content?.[0]?.text);
      check('agy_say propaga la clave escalar y el texto emitido',
        envios()[inicio]?.reaccionable?.alma === 'alya'
          && typeof envios()[inicio]?.reaccionable?.extracto === 'string'
          && envios()[inicio].reaccionable.extracto.length > 0,
        JSON.stringify(envios()[inicio]));

      res = await server.callTool('agy_say', { ...base, soul: undefined, text: 'Texto neutral.' }, 60000);
      check('agy_say neutral no inventa autoría', !res.result?.isError && !envios()[inicio + 1]?.reaccionable, JSON.stringify(envios()[inicio + 1]));

      res = await server.callTool('agy_narrate', { ...base, personality: true, cwd }, 60000);
      check('agy_narrate con alma propaga reaccionable',
        !res.result?.isError && envios()[inicio + 2]?.reaccionable?.alma === 'alya',
        JSON.stringify(envios()[inicio + 2]));

      res = await server.callTool('agy_session_summary', {
        session_id: 'sess-reaccion', cwd, output_path: path.join(cwd, 'resumen.md'),
        narrate: true, personality: true, soul: 'alya',
        voice: 'Alya', voicebox_url: vbox.url, send_telegram: true, local_playback: false
      }, 60000);
      check('el digest con alma propaga reaccionable',
        !res.result?.isError
          && envios()[inicio + 3]?.reaccionable?.alma === 'alya'
          && /Digest breve/.test(envios()[inicio + 3]?.reaccionable?.extracto || ''),
        JSON.stringify({ envio: envios()[inicio + 3], todos: envios(), resultado: res.result?.content?.[0]?.text }));
    });
  } finally {
    await server.stop();
    await new Promise((resolve) => vbox.server.close(resolve));
    for (const [clave, valor] of Object.entries(previo)) {
      if (valor === undefined) delete process.env[clave];
      else process.env[clave] = valor;
    }
    removeFixture(fixture);
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
