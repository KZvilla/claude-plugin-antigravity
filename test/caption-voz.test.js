/**
 * Caption de las notas de voz de Telegram (v0.22.1).
 *
 * Iba en Markdown sin escapar: un `_` o `*` suelto —habitual en el texto
 * hablado de una narración, que viaja como caption— hacía fallar la nota con
 * «can't parse entities», y el fallback a sendAudio fallaba igual. Ahora va en
 * HTML escapado y recortado midiendo el escapado (1024 de Telegram).
 *
 * Corre notify.js en un proceso hijo: el token se lee al importar el módulo,
 * así que hay que fijarlo antes. `fetch` está stubeado: nada sale a la red.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');
const NOTIFY = pathToFileURL(path.join(REPO_ROOT, 'telegram-bridge', 'notify.js')).href;

const HIJO = `
const { captionHtml, sendTelegramVoice } = await import(${JSON.stringify(NOTIFY)});
const envios = [];
globalThis.fetch = async (url, opts) => {
  const b = opts.body;
  const metodo = String(url).split('/').pop();
  envios.push({ metodo, parse_mode: b.get('parse_mode'), caption: b.get('caption') });
  // sendVoice falla a propósito para ejercitar el fallback a sendAudio.
  return { json: async () => (metodo === 'sendVoice' ? { ok: false, description: 'forzado' } : { ok: true, result: {} }) };
};
await sendTelegramVoice({ audioPath: process.env.AUDIO, caption: 'class_temperature 0.7 *prueba* <x> & y', targetChatId: '1' });
const densos = captionHtml('Hola & '.repeat(300));
const solo = captionHtml('&'.repeat(1000));
const emoji = captionHtml('a'.repeat(1022) + '\\u{1F399}\\u{FE0F}' + 'b'.repeat(50));
console.log('RESULTADO ' + JSON.stringify({
  envios,
  densos: { largo: densos.length, vacio: densos === '…' },
  solo: { largo: solo.length, cortada: /&[a-z]*…$/.test(solo) && !/&amp;…$/.test(solo) },
  emoji: { largo: emoji.length, huerfano: /[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])/.test(emoji) },
  corto: captionHtml('a & b')
}));
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-voz-'));
  try {
    const audio = path.join(dir, 'nota.wav');
    fs.writeFileSync(audio, Buffer.alloc(4096));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', HIJO], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        AUDIO: audio,
        TELEGRAM_BOT_TOKEN: '1234567890:AAFakeTokenForTestingOnly_DoNotUse',
        TELEGRAM_BRIDGE_STATE_FILE: path.join(dir, 'state.json')
      }
    });
    const linea = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULTADO '));
    const d = linea ? JSON.parse(linea.slice('RESULTADO '.length)) : null;

    await group('caption de notas de voz en HTML', () => {
      check('el hijo corrió', !!d, r.stderr);
      if (!d) return;
      const [voz, audioEnvio] = d.envios;
      check('sendVoice en HTML', voz && voz.metodo === 'sendVoice' && voz.parse_mode === 'HTML', JSON.stringify(voz));
      check('caption escapado (< y &), _ y * literales', voz && voz.caption === 'class_temperature 0.7 *prueba* &lt;x&gt; &amp; y', voz && voz.caption);
      check('el fallback sendAudio también va en HTML y escapado', audioEnvio && audioEnvio.metodo === 'sendAudio' && audioEnvio.parse_mode === 'HTML' && audioEnvio.caption === voz.caption, JSON.stringify(audioEnvio));
    });

    await group('captionHtml respeta 1024 sin vaciar ni cortar', () => {
      if (!d) return;
      check('& densos: cabe y no queda vacío (el bug de la v2 del plan)', d.densos.largo <= 1024 && d.densos.largo > 900 && !d.densos.vacio, JSON.stringify(d.densos));
      check('1000 &: cabe sin entidad cortada', d.solo.largo <= 1024 && !d.solo.cortada, JSON.stringify(d.solo));
      check('emoji en el borde: sin surrogate huérfano', d.emoji.largo <= 1024 && !d.emoji.huerfano, JSON.stringify(d.emoji));
      check('texto que cabe: solo escapado', d.corto === 'a &amp; b');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
