/**
 * OmniVoice como segundo proveedor (plan docs/future-implementations/plan-omnivoice.md).
 *
 * Fija: la regla fija de proveedor del usuario (inmediato → OmniVoice,
 * diferido → Voicebox, voz fijada gana), la caché de voces que permite narrar
 * con Voicebox caído, el arranque del server sin --parent-pid (moriría al
 * cerrar Claude Code) y el ciclo de vida propio del server en modo FAKE
 * (sin torch ni pesos: corre con cualquier Python).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { check, group, report } = require('./lib/assert');
const { removeFixture, REPO_ROOT } = require('./lib/mcp-client');
const om = require('../mcp-server/omnivoice.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omni-'));
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

function puertoLibre() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function wav(ruta, segundos) {
  const byteRate = 48000;
  const cab = Buffer.alloc(44);
  cab.write('RIFF', 0, 'ascii');
  cab.writeUInt32LE(36 + byteRate * segundos, 4);
  cab.write('WAVEfmt ', 8, 'ascii');
  cab.writeUInt32LE(16, 16); cab.writeUInt16LE(1, 20); cab.writeUInt16LE(1, 22);
  cab.writeUInt32LE(24000, 24); cab.writeUInt32LE(byteRate, 28); cab.writeUInt16LE(2, 32); cab.writeUInt16LE(16, 34);
  cab.write('data', 36, 'ascii');
  cab.writeUInt32LE(byteRate * segundos, 40);
  fs.writeFileSync(ruta, Buffer.concat([cab, Buffer.alloc(byteRate * segundos)]));
}

function instalacionFalsa(base) {
  fs.mkdirSync(path.join(base, 'venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(base, 'venv', 'Scripts', 'python.exe'), '');
  fs.mkdirSync(path.join(base, 'models', 'OmniVoice'), { recursive: true });
  fs.writeFileSync(path.join(base, 'models', 'OmniVoice', 'config.json'), '{}');
}

function servidorJson(rutas) {
  const server = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const f = rutas[`${req.method} ${req.url.split('?')[0]}`];
      res.setHeader('Content-Type', 'application/json');
      if (!f) { res.statusCode = 404; return res.end('{}'); }
      const [codigo, datos] = f(cuerpo ? JSON.parse(cuerpo) : null);
      res.statusCode = codigo;
      res.end(JSON.stringify(datos));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function main() {
  await group('preferencia de proveedor: regla fija del usuario', () => {
    const p = (x) => om.preferenciaProveedor(x).proveedor;
    check('inmediato → OmniVoice', p({ modo: 'inmediato' }) === 'omnivoice');
    check('diferido → Voicebox', p({ modo: 'diferido' }) === 'voicebox');
    check('sin modo → inmediato', p({}) === 'omnivoice');
    check('voz fijada gana al modo', p({ modo: 'inmediato', perfil: { name: 'Priscilla' }, config: { vozPorPerfil: { Priscilla: 'voicebox' } } }) === 'voicebox');
    check('motor explícito gana a todo', p({ modo: 'diferido', motorPedido: 'omnivoice', perfil: { name: 'Priscilla' }, config: { vozPorPerfil: { Priscilla: 'voicebox' } } }) === 'omnivoice');
    check('motor inválido se ignora', p({ modo: 'diferido', motorPedido: 'kokoro' }) === 'voicebox');
    check('urlOmni con puerto de config', om.urlOmni({ omnivoicePort: 18000 }) === 'http://127.0.0.1:18000' && om.urlOmni({}) === 'http://127.0.0.1:17494');
  });

  let dir = tmp();
  try {
    await group('instalación, caché de voces y muestras', async () => {
      const base = path.join(dir, 'omni');
      const env = { ...process.env, OMNIVOICE_DIR: base, LAGRANGE_VOICEBOX_DIR: path.join(dir, 'estado'), VOICEBOX_DIR: path.join(dir, 'vbdata') };
      check('sin instalar → false', !om.omniInstalado({ env, platform: 'win32' }));
      instalacionFalsa(base);
      check('venv + pesos + servidor → instalado', om.omniInstalado({ env, platform: 'win32' }));
      check('fuera de Windows → false', !om.omniInstalado({ env, platform: 'linux' }));

      om.guardarCacheVoces({ perfiles: [{ id: 'p1', name: 'Alya' }] }, env);
      om.guardarCacheVoces({ muestra: { profileId: 'p1', audioPath: 'C:\\x.wav', refText: 'hola' } }, env);
      const c = om.leerCacheVoces(env);
      check('la caché guarda perfiles y muestras', c.perfiles[0].name === 'Alya' && c.muestras.p1.refText === 'hola');

      fs.mkdirSync(path.join(env.VOICEBOX_DIR, 'profiles', 'p2'), { recursive: true });
      const muestra = path.join(env.VOICEBOX_DIR, 'profiles', 'p2', 'a.wav');
      wav(muestra, 25);
      check('duracionWav lee la cabecera', Math.round(om.duracionWav(muestra)) === 25);
      const vbox = await servidorJson({
        'GET /profiles/p2/samples': () => [200, [{ audio_path: 'profiles\\p2\\a.wav', reference_text: 'hola p2' }]],
        'GET /profiles/p3/samples': () => [200, []]
      });
      try {
        const m = await om.muestraDePerfil(vbox.url, { id: 'p2', name: 'Bananero' }, { env });
        check('muestra de Voicebox con ruta absoluta', m && m.audioPath === muestra && m.refText === 'hola p2', JSON.stringify(m));
        check('perfil preset (sin muestras) → null', (await om.muestraDePerfil(vbox.url, { id: 'p3' }, { env })) === null);
      } finally { await new Promise(r => vbox.server.close(r)); }
      const desdeCache = await om.muestraDePerfil(null, { id: 'p2' }, { env });
      check('Voicebox caído → la muestra sale de la caché', desdeCache && desdeCache.audioPath === muestra);
      check('muestra de 25 s → aviso para acortarla', /25 s/.test(om.avisoMuestraLarga(desdeCache, { name: 'Bananero' }) || ''));
    });

    await group('arranque y cliente de OmniVoice', async () => {
      const base = path.join(dir, 'omni');
      const env = { ...process.env, OMNIVOICE_DIR: base, LAGRANGE_VOICEBOX_DIR: path.join(dir, 'estado') };
      const llamadas = [];
      let port = await puertoLibre();
      let fake = null;
      const r = await om.ensureOmniVoice(`http://127.0.0.1:${port}`, {
        env, platform: 'win32', tiempos: { arranque: 8000 },
        spawnFn: (cmd, args, opts) => {
          llamadas.push({ cmd, args, opts });
          servidorJson({ 'GET /health': () => [200, { status: 'healthy', backend: 'omnivoice' }] }).then(s => { fake = s; });
          return { unref() {} };
        }
      });
      // El fake escucha en otro puerto: se reintenta contra ese.
      if (fake) {
        port = Number(new URL(fake.url).port);
        await new Promise(res => fake.server.close(res));
      }
      const a = llamadas[0] || {};
      check('lanza el python del venv con servidor.py', a.cmd === path.join(base, 'venv', 'Scripts', 'python.exe') && a.args && a.args[0] === om.RUTA_SERVIDOR, JSON.stringify(a.args));
      check('sin --parent-pid (moriría con el MCP)', a.args && !a.args.includes('--parent-pid'));
      check('desacoplado, oculto y sin heredar stdio', a.opts && a.opts.detached && a.opts.windowsHide && a.opts.stdio[0] === 'ignore' && typeof a.opts.stdio[1] === 'number');
      check('el lock de arranque quedó libre', !fs.existsSync(path.join(dir, 'estado', 'omnivoice-start.lock')));
      check('resultado coherente (no respondió en el puerto pedido)', r.ok === false || r.started === true);

      const noInst = await om.ensureOmniVoice('http://127.0.0.1:1', { env: { ...env, OMNIVOICE_DIR: path.join(dir, 'nada') }, platform: 'win32' });
      check('no instalado → error que dice cómo instalar', !noInst.ok && /omnivoice:install/.test(noInst.error));

      let recibido = null;
      const omni = await servidorJson({
        'POST /generate': (b) => { recibido = b; return b.ref_audio === 'falta' ? [400, { detail: 'la muestra no existe: falta' }] : [200, { id: 'o1', audio_path: 'C:\\o1.wav', duration: 1.5, seconds: 0.4 }]; }
      });
      try {
        const s = await om.sintetizarOmni(omni.url, { texto: 'hola', refAudio: 'C:\\m.wav', refText: 'ref', classTemperature: 0.7 });
        check('sintetizarOmni devuelve la ruta del wav', s.audioPath === 'C:\\o1.wav' && s.segundos === 0.4);
        check('manda muestra, texto de referencia y temperatura', recibido.ref_audio === 'C:\\m.wav' && recibido.ref_text === 'ref' && recibido.class_temperature === 0.7);
        let error = null;
        try { await om.sintetizarOmni(omni.url, { texto: 'x', refAudio: 'falta' }); } catch (err) { error = err.message; }
        check('un 400 del server llega como error con su detalle', /la muestra no existe/.test(error || ''), error);
      } finally { await new Promise(r => omni.server.close(r)); }
    });
  } finally { removeFixture(dir); }

  // Servidor real en modo FAKE (sin torch): ciclo de vida propio.
  const py = spawnSync('python', ['--version'], { encoding: 'utf8' });
  if (py.error || py.status !== 0) {
    await group('servidor.py (FAKE)', () => { console.log('  (Python no disponible: se omite)'); check('omitido', true); });
  } else {
    dir = tmp();
    try {
      await group('servidor.py en modo FAKE: genera, descarga y se apaga solo', async () => {
        const home = path.join(dir, 'home');
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        // 0.02 min = 1.2 s para descargar; 0.06 min = 3.6 s para apagarse.
        fs.writeFileSync(path.join(home, '.claude', 'antigravity.json'), JSON.stringify({ voicebox_idle_unload_minutes: 0.02, voicebox_idle_shutdown_minutes: 0.06 }));
        const estado = path.join(dir, 'estado');
        const muestra = path.join(dir, 'm.wav');
        wav(muestra, 1);
        const port = await puertoLibre();
        const url = `http://127.0.0.1:${port}`;
        const hijo = spawn('python', [path.join(REPO_ROOT, 'omnivoice-server', 'servidor.py'), '--port', String(port)], {
          env: { ...process.env, OMNIVOICE_FAKE: '1', OMNIVOICE_CICLO_S: '0.3', OMNIVOICE_DIR: path.join(dir, 'omni'), LAGRANGE_VOICEBOX_DIR: estado, HOME: home, USERPROFILE: home },
          stdio: 'ignore'
        });
        let salio = false;
        hijo.on('exit', () => { salio = true; });
        const vb = require('../mcp-server/voicebox-server.js');
        const h = await vb.esperarSalud(url, 10000);
        check('responde /health', h.ok && h.info.backend === 'omnivoice', JSON.stringify(h));
        const s = await om.sintetizarOmni(url, { texto: 'hola', refAudio: muestra });
        check('/generate escribe un wav', s.audioPath && fs.existsSync(s.audioPath) && Math.abs(om.duracionWav(s.audioPath) - 0.5) < 0.05, JSON.stringify(s));
        let eo = await vb.estadoOmniServidor(url);
        check('modelo cargado y sin generación en curso', eo.models[0].loaded && eo.generando === false && eo.generando_desde === null);
        check('escribe su estado para la statusline', fs.existsSync(path.join(estado, 'omnivoice-estado.json')));
        const r400 = await vb.pedir(`${url}/generate`, { method: 'POST', body: { text: 'x', ref_audio: path.join(dir, 'no.wav') } });
        check('muestra inexistente → 400 claro, no 500', r400.status === 400 && /no existe/.test(r400.body));
        await dormir(2500);
        eo = await vb.estadoOmniServidor(url);
        check('sin uso → descarga el modelo', eo.models.length === 1 && eo.models[0].loaded === false, JSON.stringify(eo));
        for (let i = 0; i < 40 && !salio; i++) await dormir(250);
        check('sin modelo ni uso → se apaga solo', salio);
        check('y borra su estado', !fs.existsSync(path.join(estado, 'omnivoice-estado.json')));
        if (!salio) hijo.kill();
      });

      await group('servidor.py en modo FAKE: el pin de omnivoice lo mantiene', async () => {
        const home = path.join(dir, 'home');
        const estado = path.join(dir, 'estado');
        fs.mkdirSync(estado, { recursive: true });
        fs.writeFileSync(path.join(estado, 'pin.json'), JSON.stringify({ model: 'omnivoice' }));
        const muestra = path.join(dir, 'm.wav');
        const port = await puertoLibre();
        const url = `http://127.0.0.1:${port}`;
        const hijo = spawn('python', [path.join(REPO_ROOT, 'omnivoice-server', 'servidor.py'), '--port', String(port)], {
          env: { ...process.env, OMNIVOICE_FAKE: '1', OMNIVOICE_CICLO_S: '0.3', OMNIVOICE_DIR: path.join(dir, 'omni'), LAGRANGE_VOICEBOX_DIR: estado, HOME: home, USERPROFILE: home },
          stdio: 'ignore'
        });
        const vb = require('../mcp-server/voicebox-server.js');
        await vb.esperarSalud(url, 10000);
        await om.sintetizarOmni(url, { texto: 'hola', refAudio: muestra });
        await dormir(2500);
        const eo = await vb.estadoOmniServidor(url);
        check('fijado: sigue cargado pasada la inactividad', eo.models[0] && eo.models[0].loaded === true, JSON.stringify(eo));
        await vb.apagarServer(url);
        await dormir(500);
        hijo.kill();
      });
    } finally { removeFixture(dir); }
  }

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
