/**
 * Segmento Voicebox/VRAM de la statusline y la lista de segmentos.
 *
 * El segmento solo lee estado.json (lo escribe el keeper cada 10 s): un
 * archivo viejo significa que no hay keeper vivo y el segmento se oculta. Un
 * segmento roto no puede arrastrar al del fanout.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { armarLineaVoicebox } = require('../mcp-server/statusline-voicebox.js');

const SCRIPT = path.join(__dirname, '..', 'mcp-server', 'fanout-statusline.js');
const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

function correr(cwd) {
  // HOME aislado: ni el delegado ni el estado de Voicebox reales se cuelan.
  const env = { ...process.env, HOME: cwd, USERPROFILE: cwd };
  delete env.LAGRANGE_VOICEBOX_DIR;
  return execFileSync(process.execPath, [SCRIPT], { input: JSON.stringify({ cwd }), encoding: 'utf8', env });
}

function escribirEstado(cwd, estado) {
  const dir = path.join(cwd, '.claude', 'lagrange-voicebox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'estado.json'), typeof estado === 'string' ? estado : JSON.stringify(estado));
}

const fresco = (extra = {}) => ({
  actualizado: new Date().toISOString(),
  modo: 'propio',
  variante: 'cuda',
  cargados: [{ nombre: 'qwen-tts-1.7B', mb: 4333 }],
  pin: 'qwen-tts-1.7B',
  vram: { usadoMb: 5000, libreMb: 19866, totalMb: 24576 },
  liberaEnMin: null,
  ...extra
});

async function main() {
  await group('armarLineaVoicebox', () => {
    check('formato completo con pin', armarLineaVoicebox(fresco()) === '🎙️ voicebox cuda · qwen-tts-1.7B 📌 · VRAM 19.4/24.0 GB libre', armarLineaVoicebox(fresco()));
    check('sin pin: cuenta regresiva', /libera en 7m$/.test(armarLineaVoicebox(fresco({ pin: null, liberaEnMin: 7 }))));
    check('sin modelos', /sin modelo cargado/.test(armarLineaVoicebox(fresco({ cargados: [], pin: null }))));
    check('GUI', /voicebox modo GUI/.test(armarLineaVoicebox(fresco({ modo: 'gui' }))));
    check('CPU avisa', /voicebox ⚠ cpu/.test(armarLineaVoicebox(fresco({ variante: 'cpu' }))));
    check('sin nvidia-smi: sin VRAM, sin romper', !/VRAM/.test(armarLineaVoicebox(fresco({ vram: null }))));
    check('más de 30 s → null', armarLineaVoicebox(fresco({ actualizado: new Date(Date.now() - 31000).toISOString() })) === null);
    check('basura → null', armarLineaVoicebox({ actualizado: 'no' }) === null && armarLineaVoicebox(null) === null);
  });

  let cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-vb-'));
  try {
    await group('script completo', () => {
      check('sin estado.json: nada', correr(cwd) === '');
      escribirEstado(cwd, fresco());
      check('estado fresco: la línea de Voicebox', correr(cwd).trim() === '🎙️ voicebox cuda · qwen-tts-1.7B 📌 · VRAM 19.4/24.0 GB libre');
      escribirEstado(cwd, fresco({ actualizado: new Date(Date.now() - 60000).toISOString() }));
      check('estado viejo: nada', correr(cwd) === '');
      escribirEstado(cwd, '{roto');
      check('JSON roto: nada, sin stack trace', correr(cwd) === '');

      escribirEstado(cwd, fresco());
      fs.writeFileSync(path.join(cwd, '.claude', 'antigravity.json'), JSON.stringify({ statusline_voicebox: false }));
      check('statusline_voicebox:false lo apaga', correr(cwd) === '');
      fs.unlinkSync(path.join(cwd, '.claude', 'antigravity.json'));

      const wt = path.join(cwd, '.claude', 'worktrees');
      fs.mkdirSync(wt, { recursive: true });
      const ahora = new Date().toISOString();
      fs.writeFileSync(path.join(wt, '.fanout-status-demo.json'), JSON.stringify({ slug: 'demo', iniciado: ahora, actualizado: ahora, tareas: { a: { estado: 'ok' }, b: { estado: 'corriendo' } } }));
      const lineas = correr(cwd).split('\n');
      check('fanout y voicebox: dos líneas, fanout primero', lineas.length === 2 && /^🔀 fanout demo/.test(lineas[0]) && /^🎙️ voicebox/.test(lineas[1]), JSON.stringify(lineas));
    });
  } finally { borrar(cwd); }

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
