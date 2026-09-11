/**
 * Segmento de voz de la statusline: servidores (Voicebox, OmniVoice) y VRAM.
 *
 * Regresión que motiva el formato: el segmento mostraba la VRAM LIBRE sobre el
 * total («VRAM 22.7/24.0 GB libre») y el usuario leyó «22/24» como memoria
 * casi llena. Ahora es la usada, como en todos los HUD, con aviso arriba del
 * 85 %. Y se mide en vivo (caché de 3 s, como claude-hud) en vez de salir del
 * ciclo de 10 s del keeper.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');
const { armarLineaVoicebox, textoVram, vramEnVivo } = require('../mcp-server/statusline-voicebox.js');

const SCRIPT = path.join(__dirname, '..', 'mcp-server', 'fanout-statusline.js');
const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

function correr(cwd) {
  // HOME aislado: ni el delegado ni el estado de voz reales se cuelan.
  const env = { ...process.env, HOME: cwd, USERPROFILE: cwd };
  delete env.LAGRANGE_VOICEBOX_DIR;
  return execFileSync(process.execPath, [SCRIPT], { input: JSON.stringify({ cwd }), encoding: 'utf8', env });
}

const dirVoz = (cwd) => path.join(cwd, '.claude', 'lagrange-voicebox');

function escribir(cwd, nombre, datos) {
  fs.mkdirSync(dirVoz(cwd), { recursive: true });
  fs.writeFileSync(path.join(dirVoz(cwd), nombre), typeof datos === 'string' ? datos : JSON.stringify(datos));
}

const VRAM = { usadoMb: 5530, totalMb: 24576 }; // 5.4/24.0 GB

const fresco = (extra = {}) => ({
  actualizado: new Date().toISOString(),
  modo: 'propio',
  variante: 'cuda',
  cargados: [{ nombre: 'qwen-tts-1.7B', mb: 4333 }],
  pin: 'qwen-tts-1.7B',
  liberaEnMin: null,
  ...extra
});

const omniFresco = (extra = {}) => ({ actualizado: new Date().toISOString(), cargado: true, pin: false, variante: 'cuda', liberaEnMin: 4, ...extra });

async function main() {
  const ahora = Date.now();
  await group('formato: VRAM usada, no libre', () => {
    const linea = armarLineaVoicebox(fresco(), ahora, { vram: VRAM });
    check('usada/total', linea === '🎙️ voicebox cuda · qwen-tts-1.7B 📌 · VRAM 5.4/24.0 GB', linea);
    check('ya no dice «libre»', !/libre/.test(linea));
    check('arriba del 85 %: aviso', textoVram({ usadoMb: 22528, totalMb: 24576 }) === '⚠ VRAM 22.0/24.0 GB');
    check('85 % justo: sin aviso', !/⚠/.test(textoVram({ usadoMb: 0.85 * 24576, totalMb: 24576 })));
    check('sin medición: sin VRAM, sin romper', !/VRAM/.test(armarLineaVoicebox(fresco(), ahora, { vram: null })));
  });

  await group('estados de los servidores', () => {
    check('sin pin: cuenta regresiva', /libera en 7m$/.test(armarLineaVoicebox(fresco({ pin: null, liberaEnMin: 7 }), ahora, { vram: VRAM })));
    check('sin modelos', /sin modelo cargado/.test(armarLineaVoicebox(fresco({ cargados: [], pin: null }), ahora)));
    check('GUI', /voicebox modo GUI/.test(armarLineaVoicebox(fresco({ modo: 'gui' }), ahora)));
    check('CPU avisa', /voicebox ⚠ cpu/.test(armarLineaVoicebox(fresco({ variante: 'cpu' }), ahora)));
    const ambos = armarLineaVoicebox(fresco({ cargados: [], pin: null }), ahora, { omni: omniFresco(), vram: VRAM });
    check('Voicebox + OmniVoice en una línea', ambos === '🎙️ voicebox cuda · omnivoice · VRAM 5.4/24.0 GB · libera en 4m', ambos);
    const soloOmni = armarLineaVoicebox(null, ahora, { omni: omniFresco({ pin: true, liberaEnMin: null }), vram: VRAM });
    check('solo OmniVoice (Voicebox caído)', soloOmni === '🎙️ omnivoice cuda · cargado 📌 · VRAM 5.4/24.0 GB', soloOmni);
    check('los dos viejos → null', armarLineaVoicebox(fresco({ actualizado: new Date(ahora - 31000).toISOString() }), ahora, { omni: omniFresco({ actualizado: new Date(ahora - 60000).toISOString() }) }) === null);
    check('basura → null', armarLineaVoicebox({ actualizado: 'no' }, ahora) === null && armarLineaVoicebox(null, ahora) === null);
  });

  const tmpVram = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-vram-'));
  const previo = process.env.LAGRANGE_VOICEBOX_DIR;
  process.env.LAGRANGE_VOICEBOX_DIR = tmpVram;
  try {
    await group('VRAM en vivo con caché de 3 s (como claude-hud)', () => {
      let llamadas = 0;
      const ejecutar = () => { llamadas++; return '5530, 24576\n'; };
      const t0 = 1_000_000;
      const v1 = vramEnVivo({ ahora: t0, ejecutar });
      vramEnVivo({ ahora: t0 + 2000, ejecutar });
      check('dentro de los 3 s reusa la caché', llamadas === 1 && v1.usadoMb === 5530, String(llamadas));
      vramEnVivo({ ahora: t0 + 4000, ejecutar });
      check('pasados los 3 s vuelve a medir', llamadas === 2, String(llamadas));
      const falla = vramEnVivo({ ahora: t0 + 9000, ejecutar: () => { throw new Error('sin nvidia-smi'); } });
      check('sin nvidia-smi y caché vieja → null', falla === null);
    });
  } finally {
    if (previo === undefined) delete process.env.LAGRANGE_VOICEBOX_DIR;
    else process.env.LAGRANGE_VOICEBOX_DIR = previo;
    borrar(tmpVram);
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-vb-'));
  try {
    await group('script completo', () => {
      check('sin estado de voz: nada (y no corre nvidia-smi)', correr(cwd) === '');
      escribir(cwd, 'estado.json', fresco());
      escribir(cwd, 'vram-cache.json', { ts: Date.now(), ...VRAM });
      check('estado fresco: la línea de voz', correr(cwd).trim() === '🎙️ voicebox cuda · qwen-tts-1.7B 📌 · VRAM 5.4/24.0 GB');
      escribir(cwd, 'estado.json', fresco({ actualizado: new Date(Date.now() - 60000).toISOString() }));
      check('estado viejo: nada', correr(cwd) === '');
      escribir(cwd, 'estado.json', '{roto');
      check('JSON roto: nada, sin stack trace', correr(cwd) === '');

      escribir(cwd, 'estado.json', fresco());
      escribir(cwd, 'vram-cache.json', { ts: Date.now(), ...VRAM });
      fs.writeFileSync(path.join(cwd, '.claude', 'antigravity.json'), JSON.stringify({ statusline_voicebox: false }));
      check('statusline_voicebox:false lo apaga', correr(cwd) === '');
      fs.unlinkSync(path.join(cwd, '.claude', 'antigravity.json'));

      const wt = path.join(cwd, '.claude', 'worktrees');
      fs.mkdirSync(wt, { recursive: true });
      const ts = new Date().toISOString();
      fs.writeFileSync(path.join(wt, '.fanout-status-demo.json'), JSON.stringify({ slug: 'demo', iniciado: ts, actualizado: ts, tareas: { a: { estado: 'ok' }, b: { estado: 'corriendo' } } }));
      escribir(cwd, 'vram-cache.json', { ts: Date.now(), ...VRAM });
      const lineas = correr(cwd).split('\n');
      check('fanout y voz: dos líneas, fanout primero', lineas.length === 2 && /^🔀 fanout demo/.test(lineas[0]) && /^🎙️ voicebox/.test(lineas[1]), JSON.stringify(lineas));
    });
  } finally { borrar(cwd); }

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
