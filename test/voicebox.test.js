/**
 * Voicebox sin GUI (plan docs/future-implementations/plan-voicebox-headless.md).
 *
 * Fija las decisiones que el plan tomó por incidentes o auditorías:
 * - el backend CUDA va antes que el de Program Files (que corre en CPU);
 * - un modelo usado hace menos de 30 s no se descarga para cambiar a otro
 *   (auditoría 1, MAJOR 2: se cortaba una síntesis de otro proceso);
 * - el lock de arranque se roba si su dueño murió o es viejo, y se suelta
 *   siempre (auditoría 1, MAJOR 3);
 * - el keeper nunca toca un Voicebox que abrió la GUI;
 * - el spawn del keeper no hereda el stdio del MCP (auditoría 1, MAJOR 5).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');
const { startServer, removeFixture, REPO_ROOT } = require('./lib/mcp-client');
const vb = require('../mcp-server/voicebox-server.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
const MIN = 60000;

function puertoLibre() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function fakeVoicebox(port) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'healthy', backend_variant: 'cuda' }));
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  await group('resolverEjecutable: CUDA antes que CPU, override sin caída silenciosa', () => {
    const dataDir = path.join('D:', 'vb');
    const cuda = path.join(dataDir, 'backends', 'cuda', 'voicebox-server-cuda.exe');
    const cpu = path.join('C:', 'PF', 'Voicebox', 'voicebox-server.exe');
    const env = { ProgramFiles: path.join('C:', 'PF') };
    const r = (existe, extra = {}) => vb.resolverEjecutable({ env: { ...env, ...(extra.env || {}) }, config: extra.config || {}, dataDir, platform: extra.platform || 'win32', existe });

    const ambos = r(p => p === cuda || p === cpu);
    check('con los dos, elige CUDA', ambos.exe === cuda && ambos.variante === 'cuda', JSON.stringify(ambos));
    const soloCpu = r(p => p === cpu);
    check('sin CUDA, cae al CPU', soloCpu.exe === cpu && soloCpu.variante === 'cpu');
    const explicito = r(() => true, { env: { VOICEBOX_SERVER_EXE: 'X:\\a.exe' } });
    check('VOICEBOX_SERVER_EXE gana', explicito.exe === 'X:\\a.exe' && explicito.variante === 'explicito');
    const porConfig = r(() => true, { config: { voiceboxServerExe: 'Y:\\b.exe' } });
    check('voicebox_server_exe de la config', porConfig.exe === 'Y:\\b.exe');
    const inexistente = r(p => p === cuda, { env: { VOICEBOX_SERVER_EXE: 'X:\\no.exe' } });
    check('un override que no existe no cae a CUDA', inexistente.exe === null && inexistente.buscado[0] === 'X:\\no.exe');
    const nada = r(() => false);
    check('sin binarios: null y lo buscado', nada.exe === null && nada.buscado.length === 2);
    check('fuera de Windows: null', r(() => true, { platform: 'linux' }).exe === null);
  });

  await group('paridad del data dir con el bridge (notify.js es ESM, no se puede require)', async () => {
    const { resolveVoiceboxBaseDir } = await import(pathToFileURL(path.join(REPO_ROOT, 'telegram-bridge', 'notify.js')).href);
    const esperado = resolveVoiceboxBaseDir().base;
    check('misma ruta que resolveVoiceboxBaseDir', vb.voiceboxDataDir() === esperado, `${vb.voiceboxDataDir()} vs ${esperado}`);
    check('VOICEBOX_DIR manda', vb.voiceboxDataDir({ VOICEBOX_DIR: 'Z:\\vb' }, 'win32') === path.resolve('Z:\\vb'));
  });

  await group('motor del perfil y nombres de modelo (perfiles reales)', () => {
    const estado = { 'qwen-tts-1.7B': { downloaded: true }, 'qwen-custom-voice-1.7B': { downloaded: true } };
    const dora = vb.resolverMotor({ name: 'Dora', default_engine: 'kokoro' }, estado);
    check('Dora → kokoro sin tamaño', dora.engine === 'kokoro' && dora.modelSize === null);
    const diego = vb.resolverMotor({ name: 'Diego Alvarez', default_engine: '' }, estado);
    check('Diego (sin default_engine) → qwen 1.7B', diego.engine === 'qwen' && diego.modelSize === '1.7B');
    const ono = vb.resolverMotor({ name: 'Ono Anna', default_engine: 'qwen_custom_voice' }, estado);
    check('Ono Anna → qwen_custom_voice 1.7B', ono.engine === 'qwen_custom_voice' && ono.modelSize === '1.7B');
    const soloChico = vb.resolverMotor({ default_engine: 'qwen' }, { 'qwen-tts-0.6B': { downloaded: true } });
    check('solo 0.6B descargado → 0.6B', soloChico.modelSize === '0.6B');
    check('override de motor gana', vb.resolverMotor({ default_engine: 'qwen' }, estado, 'kokoro').engine === 'kokoro');

    check('ttsModelName qwen', vb.ttsModelName('qwen', '0.6B') === 'qwen-tts-0.6B');
    check('ttsModelName chatterbox', vb.ttsModelName('chatterbox', null) === 'chatterbox-tts');
    check('ttsModelName kokoro', vb.ttsModelName('kokoro', null) === 'kokoro');
    check('whisper no es TTS', !vb.esModeloTts('whisper-turbo'));
    check('el LLM de personalidad no es TTS', !vb.esModeloTts('qwen3-4b') && !vb.esModeloTts('qwen3-0.6b'));
    check('qwen-tts y kokoro son TTS', vb.esModeloTts('qwen-tts-1.7B') && vb.esModeloTts('kokoro'));
  });

  await group('modelosADescargar: nunca corta una síntesis en curso', () => {
    const ahora = 1_000_000;
    const base = { objetivo: 'kokoro', ahora };
    check('mismo modelo → nada', vb.modelosADescargar({ ...base, cargados: ['kokoro'] }).length === 0);
    check('ajeno sin uso → se descarga', JSON.stringify(vb.modelosADescargar({ ...base, cargados: ['qwen-tts-1.7B'], usos: { 'qwen-tts-1.7B': ahora - 60000 } })) === '["qwen-tts-1.7B"]');
    check('ajeno usado hace 10 s → se posterga', vb.modelosADescargar({ ...base, cargados: ['qwen-tts-1.7B'], usos: { 'qwen-tts-1.7B': ahora - 10000 } }).length === 0);
    check('Whisper nunca', vb.modelosADescargar({ ...base, cargados: ['whisper-turbo'] }).length === 0);
    check('el fijado nunca', vb.modelosADescargar({ ...base, cargados: ['qwen-tts-1.7B'], protegido: 'qwen-tts-1.7B' }).length === 0);
  });

  await group('keeper: decisión y usos efectivos', () => {
    const ahora = 100 * MIN;
    const cfg = { ahora, idleUnloadMs: 10 * MIN, idleShutdownMs: 30 * MIN };
    const d = (x) => vb.decidirAccionKeeper({ ...cfg, ...x });
    check('Voicebox de la GUI → nada, aunque esté inactivo', d({ ownsServer: false, cargados: ['kokoro'], usos: { kokoro: 0 } }).accion === 'nada');
    check('inactivo → descargar', d({ ownsServer: true, cargados: ['kokoro'], usos: { kokoro: ahora - 11 * MIN } }).accion === 'descargar');
    check('fijado inactivo → se queda', d({ ownsServer: true, pinModel: 'kokoro', cargados: ['kokoro'], usos: { kokoro: 0 } }).accion === 'nada');
    check('sin modelos y sin uso 31 min → apagar', d({ ownsServer: true, cargados: [], ultimoUso: ahora - 31 * MIN }).accion === 'apagar');
    check('con pin no se apaga', d({ ownsServer: true, pinModel: 'kokoro', cargados: [], ultimoUso: 0 }).accion === 'nada');
    check('idle_shutdown 0 → nunca apaga', d({ ownsServer: true, cargados: [], ultimoUso: 0, idleShutdownMs: 0 }).accion === 'nada');
    check('3 fallos seguidos → salir', d({ ownsServer: true, fallosSeguidos: 3 }).accion === 'salir');

    const efectivos = vb.usosEfectivos({
      cargados: ['qwen-tts-1.7B', 'qwen3-0.6b', 'kokoro'],
      usos: { 'qwen-tts-1.7B': 500 },
      vistoDesde: { 'qwen3-0.6b': 100, kokoro: 200 }
    });
    check('el LLM cuenta como usado cuando se usa cualquier cosa', efectivos['qwen3-0.6b'] === 500);
    check('un TTS sin archivo cuenta desde que se lo vio', efectivos.kokoro === 200);
    check('minutosParaLiberar', vb.minutosParaLiberar({ cargados: ['kokoro'], usos: { kokoro: ahora - 3 * MIN }, ahora, idleUnloadMs: 10 * MIN }) === 7);
  });

  let dir = tmp();
  try {
    await group('locks entre procesos', () => {
      const ruta = path.join(dir, 'x.lock');
      const a = vb.tomarLock(ruta);
      check('se toma libre', !!a);
      check('ocupado por un PID vivo y reciente → null', vb.tomarLock(ruta, { staleMs: 60000 }) === null);
      vb.soltarLock(a);
      check('soltarLock lo borra', !fs.existsSync(ruta));

      fs.writeFileSync(ruta, JSON.stringify({ pid: 2147483000, ts: Date.now() }));
      check('dueño muerto → se roba', !!vb.tomarLock(ruta, { staleMs: 60000 }));
      fs.writeFileSync(ruta, JSON.stringify({ pid: process.pid, ts: Date.now() - 80000 }));
      check('viejo (> stale) → se roba aunque el PID viva', !!vb.tomarLock(ruta, { staleMs: vb.START_LOCK_STALE_MS }));
    });

    await group('pin y usos en el directorio de estado', () => {
      const env = { ...process.env, LAGRANGE_VOICEBOX_DIR: dir };
      vb.escribirPin({ model: 'qwen-tts-1.7B', voice: 'Alya' }, env);
      check('se lee lo escrito', vb.leerPin(env).model === 'qwen-tts-1.7B');
      fs.writeFileSync(path.join(dir, 'pin.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() - 10000 }));
      vb.escribirPin({ model: 'kokoro' }, env);
      check('un pin.lock de hace 10 s no bloquea (stale 5 s)', vb.leerPin(env).model === 'kokoro');
      vb.escribirPin(null, env);
      check('null borra el pin', vb.leerPin(env) === null);

      vb.tocarUso('kokoro', env);
      const u = vb.leerUsos(env);
      check('tocarUso crea el archivo con mtime actual', Date.now() - u.kokoro < 5000);
    });
  } finally { removeFixture(dir); }

  dir = tmp();
  try {
    await group('aplicarModeloActivo: pin, swap y guarda de VRAM', async () => {
      const env = { ...process.env, LAGRANGE_VOICEBOX_DIR: dir };
      const descargados = [];
      const cargas = [];
      const deps = (modelos, libreMb = 20000) => ({
        env,
        estadoModelos: async () => modelos,
        descargarModelo: async (_u, n) => { descargados.push(n); },
        cargarQwen: async (_u, s) => { cargas.push(s); },
        vram: () => ({ usadoMb: 0, libreMb, totalMb: 24576 })
      });
      const qwenCargado = [
        { model_name: 'qwen-tts-1.7B', loaded: true, size_mb: 4333 },
        { model_name: 'kokoro', loaded: false, size_mb: 312 }
      ];

      let r = await vb.aplicarModeloActivo('http://x', { engine: 'kokoro', voz: 'Dora' }, deps(qwenCargado));
      check('cambiar a kokoro descarga el Qwen inactivo', r.ok && JSON.stringify(descargados) === '["qwen-tts-1.7B"]', JSON.stringify(r));

      descargados.length = 0;
      vb.tocarUso('qwen-tts-1.7B', env);
      r = await vb.aplicarModeloActivo('http://x', { engine: 'kokoro' }, deps(qwenCargado));
      check('con el Qwen recién usado, se posterga', r.ok && descargados.length === 0 && r.postergados[0] === 'qwen-tts-1.7B');

      r = await vb.aplicarModeloActivo('http://x', { engine: 'qwen', modelSize: '0.6B' }, deps([{ model_name: 'qwen-tts-0.6B', loaded: false, size_mb: 2399 }], 100));
      check('sin VRAM no se carga y se dice', !r.ok && /VRAM insuficiente/.test(r.error), r.error);

      r = await vb.aplicarModeloActivo('http://x', { engine: 'qwen', modelSize: '1.7B', voz: 'Alya', fijar: true }, deps([{ model_name: 'qwen-tts-1.7B', loaded: false, size_mb: 4333 }]));
      check('pin: se registra y se precarga Qwen', r.ok && r.fijado && vb.leerPin(env).voice === 'Alya' && cargas[0] === '1.7B');

      r = await vb.aplicarModeloActivo('http://x', { engine: 'kokoro', voz: 'Dora' }, deps(qwenCargado));
      check('con pin de otro modelo: rechazo que nombra ambos', !r.ok && r.conflicto && /qwen-tts-1\.7B/.test(r.error) && /kokoro/.test(r.error) && /Alya/.test(r.error), r.error);

      descargados.length = 0;
      r = await vb.aplicarModeloActivo('http://x', { engine: 'kokoro', fijar: true }, deps(qwenCargado));
      check('cambiar el pin explícitamente sí hace el swap', r.ok && vb.leerPin(env).model === 'kokoro');
    });
  } finally { removeFixture(dir); }

  dir = tmp();
  try {
    await group('ensureVoicebox', async () => {
      const env = { ...process.env, LAGRANGE_VOICEBOX_DIR: dir, VOICEBOX_SERVER_EXE: process.execPath };
      const llamadas = [];
      const spawnStub = (fn) => (cmd, args, opts) => { llamadas.push({ cmd, args, opts }); if (fn) fn(); return { unref() {} }; };

      // Ya corriendo: no lanza server; con Windows sí lanza un keeper de solo lectura.
      let port = await puertoLibre();
      let fake = await fakeVoicebox(port);
      let r = await vb.ensureVoicebox(`http://127.0.0.1:${port}`, { env, platform: 'win32', spawnFn: spawnStub() });
      check('ya corriendo → ok sin arrancar', r.ok && r.started === false);
      check('lanza un keeper sin --exe (solo lectura)', llamadas.length === 1 && !llamadas[0].args.includes('--exe'));
      await new Promise(res => fake.close(res));

      // Caído: lanza keeper con --exe, sin heredar stdio, y suelta el lock.
      llamadas.length = 0;
      port = await puertoLibre();
      let fakeTardio = null;
      r = await vb.ensureVoicebox(`http://127.0.0.1:${port}`, {
        env, platform: 'win32', tiempos: { arranque: 8000 },
        spawnFn: spawnStub(() => { fakeVoicebox(port).then(s => { fakeTardio = s; }); })
      });
      check('caído → lo levanta', r.ok && r.started === true, JSON.stringify(r));
      check('un solo spawn, con --exe', llamadas.length === 1 && llamadas[0].args.includes('--exe'));
      const stdio = llamadas[0] && llamadas[0].opts.stdio;
      check('stdio no heredado: ignore + archivo de log', Array.isArray(stdio) && stdio[0] === 'ignore' && typeof stdio[1] === 'number');
      check('detached y oculto', llamadas[0] && llamadas[0].opts.detached === true && llamadas[0].opts.windowsHide === true);
      check('start.lock liberado', !fs.existsSync(path.join(dir, 'start.lock')));
      if (fakeTardio) await new Promise(res => fakeTardio.close(res));

      // Lock tomado por otro proceso vivo: no lanza, espera y se rinde.
      llamadas.length = 0;
      port = await puertoLibre();
      fs.writeFileSync(path.join(dir, 'start.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      r = await vb.ensureVoicebox(`http://127.0.0.1:${port}`, { env, platform: 'win32', spawnFn: spawnStub(), tiempos: { lockAjeno: 1000 } });
      check('lock ajeno → no lanza', llamadas.length === 0);
      check('y dice que otro lo está levantando', !r.ok && /Otro proceso/.test(r.error), r.error);
      fs.unlinkSync(path.join(dir, 'start.lock'));

      r = await vb.ensureVoicebox('http://voicebox.invalid:17493', { env, platform: 'win32', spawnFn: spawnStub() });
      check('URL remota → no lanza', !r.ok && /no es local/.test(r.error) && llamadas.length === 0);
      r = await vb.ensureVoicebox(`http://127.0.0.1:${port}`, { env, platform: 'win32', config: { voiceboxAutostart: false }, spawnFn: spawnStub() });
      check('autostart desactivado → no lanza', !r.ok && /desactivado/.test(r.error) && llamadas.length === 0);
      r = await vb.ensureVoicebox(`http://127.0.0.1:${port}`, { env, platform: 'linux', spawnFn: spawnStub() });
      check('fuera de Windows → no lanza', !r.ok && /Windows/.test(r.error) && llamadas.length === 0);
    });
  } finally { removeFixture(dir); }

  const server = startServer({ cwd: REPO_ROOT });
  try {
    await server.initialize();
    const tools = (await server.listTools()).result.tools;
    await group('superficie de herramientas', async () => {
      const vm = tools.find(t => t.name === 'agy_voice_model');
      check('agy_voice_model está en tools/list', !!vm);
      check('acciones completas', vm && JSON.stringify(vm.inputSchema.properties.action.enum) === '["status","start","activate","pin","release","unload"]');
      for (const n of ['agy_say', 'agy_narrate']) {
        const t = tools.find(x => x.name === n);
        check(`${n} acepta keep_model`, !!(t && t.inputSchema.properties.keep_model));
      }
      const sc = tools.find(t => t.name === 'agy_set_config');
      for (const k of ['voicebox_url', 'voicebox_port', 'voicebox_autostart', 'voicebox_server_exe', 'voicebox_idle_unload_minutes', 'voicebox_idle_shutdown_minutes', 'statusline_voicebox']) {
        check(`agy_set_config declara ${k}`, !!(sc && sc.inputSchema.properties[k]));
      }

      // status nunca arranca nada: contra un puerto muerto informa "apagado".
      const port = await puertoLibre();
      const res = await server.callTool('agy_voice_model', { action: 'status', voicebox_url: `http://127.0.0.1:${port}` });
      const texto = res.result && res.result.content[0].text;
      check('status contra Voicebox caído: informa apagado, sin error', !(res.result && res.result.isError) && /apagado/.test(texto || ''), texto);
    });
  } finally {
    await server.stop();
  }

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
