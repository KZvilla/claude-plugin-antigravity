/**
 * Voicebox sin GUI: autoarranque, modelo activo y estado compartido.
 *
 * Plan: docs/future-implementations/plan-voicebox-headless.md (v3, auditado).
 *
 * Hasta ahora la voz dependía de que el usuario abriera la app de escritorio.
 * La app es solo una cáscara Tauri: el backend es `voicebox-server(-cuda).exe`,
 * que acepta `--port --data-dir --parent-pid` y se puede lanzar solo. Este
 * módulo lo levanta cuando hace falta y administra qué modelo ocupa la VRAM.
 *
 * Hechos verificados en vivo que sostienen el diseño (2026-09-11):
 * - El binario de Program Files arranca en CPU; el de
 *   `%APPDATA%\sh.voicebox.app\backends\cuda\` arranca en CUDA.
 * - PyInstaller deja un proceso hijo: matar el PID lanzado no apaga el server.
 *   Se apaga con `POST /shutdown`.
 * - Qwen↔Qwen se reemplaza solo, pero Qwen y Kokoro conviven en VRAM: el
 *   «un solo TTS residente» lo tenemos que imponer nosotros.
 * - Voicebox no descarga por inactividad.
 *
 * Estado en `~/.claude/lagrange-voicebox/`. Cada archivo tiene un único
 * escritor lógico, o es un toque sin contenido: así Node (MCP) y Python
 * (voice-chat) no se pisan sin necesitar un lock compartido entre lenguajes.
 *
 * CommonJS y sin importar nada del bridge de Telegram, que es ESM.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const PUERTO_POR_DEFECTO = 17493;
// Lock de arranque: el que espera (80 s) nunca se rinde antes de que el lock
// de un arrancador colgado pueda declararse muerto (75 s).
const START_LOCK_STALE_MS = 75000;
const ESPERA_LOCK_AJENO_MS = 80000;
const ESPERA_ARRANQUE_MS = 60000;
const PIN_LOCK_STALE_MS = 5000;
// Un modelo tocado hace menos que esto se considera en uso: no se descarga
// para cambiar a otro. Las generaciones tocan cada INTERVALO_TOQUE_MS mientras
// esperan el .wav, así que una síntesis larga nunca parece inactiva.
const VENTANA_EN_USO_MS = 30000;
const INTERVALO_TOQUE_MS = 10000;
const MARGEN_VRAM = 1.2;
const ESTADO_FRESCO_MS = 30000;
// Una generación que figura «en curso» hace más que esto se considera colgada
// y no cuenta como uso presente: si no, una tarea muerta en Voicebox dejaba al
// keeper sin descargar ni apagar nunca. Las reales tardan 5-90 s.
const GENERACION_TTL_MS = 5 * 60 * 1000;
// Una fecha hasta 60 s en el futuro sigue siendo «fresca» (reloj desfasado);
// más allá, se descarta en vez de contar como en curso para siempre.
const DESFASE_RELOJ_MS = 60 * 1000;
const ESTADOS_FINALES = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled']);

const RUTA_KEEPER = path.join(__dirname, 'voicebox-keeper.js');

const CONFIG_POR_DEFECTO = {
  voiceboxAutostart: true,
  voiceboxServerExe: null,
  voiceboxIdleUnloadMinutes: 10,
  voiceboxIdleShutdownMinutes: 30,
  statuslineVoicebox: true
};

// ==============================================================================
// Rutas
// ==============================================================================

function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function dirEstado(env = process.env) {
  if (env.LAGRANGE_VOICEBOX_DIR) return path.resolve(env.LAGRANGE_VOICEBOX_DIR);
  return path.join(homeDir(env), '.claude', 'lagrange-voicebox');
}

function asegurarDirEstado(env = process.env) {
  const dir = dirEstado(env);
  fs.mkdirSync(path.join(dir, 'uso'), { recursive: true });
  return dir;
}

function rutasEstado(env = process.env) {
  const dir = dirEstado(env);
  return {
    dir,
    pin: path.join(dir, 'pin.json'),
    pinLock: path.join(dir, 'pin.lock'),
    startLock: path.join(dir, 'start.lock'),
    keeperPid: path.join(dir, 'keeper.pid'),
    estado: path.join(dir, 'estado.json'),
    keeperLog: path.join(dir, 'keeper.log'),
    serverLog: path.join(dir, 'server.log'),
    uso: path.join(dir, 'uso')
  };
}

/**
 * Directorio de datos de Voicebox. Misma regla que `resolveVoiceboxBaseDir`
 * del bridge (`telegram-bridge/notify.js`); un test fija la paridad, porque
 * aquí no se puede importar ese módulo ESM.
 */
function voiceboxDataDir(env = process.env, platform = process.platform) {
  const explicito = (env.VOICEBOX_DIR || '').trim();
  if (explicito) return path.resolve(explicito);
  if (platform === 'win32') {
    const home = env.USERPROFILE || env.HOME || '';
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'sh.voicebox.app');
  }
  return null;
}

/**
 * Orden: override explícito → backend CUDA → backend CPU de Program Files.
 * Un override que no existe no cae a los otros: si el usuario lo fijó, quiere
 * ese y un error claro, no otro binario en silencio.
 */
function resolverEjecutable({ env = process.env, config = {}, dataDir, platform = process.platform, existe = fs.existsSync } = {}) {
  const explicito = String(env.VOICEBOX_SERVER_EXE || config.voiceboxServerExe || '').trim();
  if (explicito) {
    return existe(explicito)
      ? { exe: explicito, variante: 'explicito', buscado: [explicito] }
      : { exe: null, variante: null, buscado: [explicito] };
  }
  if (platform !== 'win32') return { exe: null, variante: null, buscado: [] };

  const candidatos = [];
  if (dataDir) candidatos.push({ exe: path.join(dataDir, 'backends', 'cuda', 'voicebox-server-cuda.exe'), variante: 'cuda' });
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  candidatos.push({ exe: path.join(programFiles, 'Voicebox', 'voicebox-server.exe'), variante: 'cpu' });

  for (const c of candidatos) {
    if (existe(c.exe)) return { ...c, buscado: candidatos.map(x => x.exe) };
  }
  return { exe: null, variante: null, buscado: candidatos.map(x => x.exe) };
}

// ==============================================================================
// Config (lo que leen el keeper y la statusline, que no cargan index.js)
// ==============================================================================

function aplicarClavesVoicebox(destino, parsed) {
  if (parsed.voicebox_autostart !== undefined) destino.voiceboxAutostart = parsed.voicebox_autostart !== false;
  if (parsed.voicebox_server_exe !== undefined) destino.voiceboxServerExe = parsed.voicebox_server_exe || null;
  if (Number.isFinite(parsed.voicebox_idle_unload_minutes)) destino.voiceboxIdleUnloadMinutes = parsed.voicebox_idle_unload_minutes;
  if (Number.isFinite(parsed.voicebox_idle_shutdown_minutes)) destino.voiceboxIdleShutdownMinutes = parsed.voicebox_idle_shutdown_minutes;
  if (parsed.statusline_voicebox !== undefined) destino.statuslineVoicebox = parsed.statusline_voicebox !== false;
  return destino;
}

/** Global primero y proyecto encima, como `loadConfig` en index.js. */
function leerConfigVoicebox(cwd = null, env = process.env) {
  const cfg = { ...CONFIG_POR_DEFECTO };
  const rutas = [path.join(homeDir(env), '.claude', 'antigravity.json')];
  if (cwd) rutas.push(path.join(cwd, '.claude', 'antigravity.json'));
  for (const ruta of rutas) {
    try {
      aplicarClavesVoicebox(cfg, JSON.parse(fs.readFileSync(ruta, 'utf8')));
    } catch {}
  }
  return cfg;
}

// ==============================================================================
// Locks entre procesos
// ==============================================================================

function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: existe pero es de otro usuario. Sigue vivo.
    return err.code === 'EPERM';
  }
}

/**
 * Crea `ruta` en exclusiva (`wx`). Si ya existe, se la roba solo si su dueño
 * murió o si es más vieja que `staleMs`. Devuelve el lock o null.
 */
function tomarLock(ruta, { staleMs = Infinity, ahora = Date.now, extra = {} } = {}) {
  for (let intento = 0; intento < 3; intento++) {
    try {
      const fd = fs.openSync(ruta, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: ahora(), ...extra }));
      } finally {
        fs.closeSync(fd);
      }
      return { ruta, pid: process.pid };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    let duenio = null;
    let mtime;
    try { duenio = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch {}
    try { mtime = fs.statSync(ruta).mtimeMs; } catch { continue; }

    const ts = (duenio && Number(duenio.ts)) || mtime;
    const muerto = Boolean(duenio && duenio.pid) && !pidVivo(duenio.pid);
    const viejo = ahora() - ts > staleMs;
    if (!muerto && !viejo) return null;
    try { fs.unlinkSync(ruta); } catch {}
  }
  return null;
}

function soltarLock(lock) {
  if (!lock) return;
  try {
    const d = JSON.parse(fs.readFileSync(lock.ruta, 'utf8'));
    if (d.pid === lock.pid) fs.unlinkSync(lock.ruta);
  } catch {}
}

function escribirAtomico(ruta, contenido) {
  const tmp = `${ruta}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenido, 'utf8');
  fs.renameSync(tmp, ruta);
}

// ==============================================================================
// Uso por modelo: toques sin contenido
// ==============================================================================

function archivoUso(modelo, env) {
  return path.join(rutasEstado(env).uso, String(modelo).replace(/[^\w.-]/g, '_'));
}

function tocarUso(modelo, env = process.env) {
  if (!modelo) return;
  try {
    asegurarDirEstado(env);
    const ruta = archivoUso(modelo, env);
    const t = new Date();
    try {
      fs.utimesSync(ruta, t, t);
    } catch {
      fs.closeSync(fs.openSync(ruta, 'a'));
      fs.utimesSync(ruta, t, t);
    }
  } catch {}
}

/** Toca `modelo` cada 10 s hasta que se llame a la función devuelta. */
function iniciarToquesPeriodicos(modelo, env = process.env) {
  if (!modelo) return () => {};
  const t = setInterval(() => tocarUso(modelo, env), INTERVALO_TOQUE_MS);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

function leerUsos(env = process.env) {
  const usos = {};
  let nombres = [];
  try { nombres = fs.readdirSync(rutasEstado(env).uso); } catch { return usos; }
  for (const n of nombres) {
    try { usos[n] = fs.statSync(path.join(rutasEstado(env).uso, n)).mtimeMs; } catch {}
  }
  return usos;
}

// ==============================================================================
// Pin
// ==============================================================================

function leerPin(env = process.env) {
  try {
    const p = JSON.parse(fs.readFileSync(rutasEstado(env).pin, 'utf8'));
    return p && p.model ? p : null;
  } catch {
    return null;
  }
}

/** Solo lo llama el MCP. `null` borra el pin. */
function escribirPin(pin, env = process.env) {
  asegurarDirEstado(env);
  const rutas = rutasEstado(env);
  let lock = null;
  const limite = Date.now() + 2000;
  while (!(lock = tomarLock(rutas.pinLock, { staleMs: PIN_LOCK_STALE_MS }))) {
    if (Date.now() > limite) throw new Error(`No se pudo tomar ${rutas.pinLock}: otro proceso está cambiando el pin.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    if (pin) escribirAtomico(rutas.pin, JSON.stringify(pin, null, 2));
    else {
      try { fs.unlinkSync(rutas.pin); } catch {}
    }
  } finally {
    soltarLock(lock);
  }
}

// ==============================================================================
// Modelos
// ==============================================================================

/** Puerto de `tts_model_name` (voice-chat/common.py). */
function ttsModelName(engine, modelSize) {
  if (engine === 'qwen') return `qwen-tts-${modelSize || '1.7B'}`;
  if (engine === 'qwen_custom_voice') return `qwen-custom-voice-${modelSize || '1.7B'}`;
  if (engine === 'chatterbox') return 'chatterbox-tts';
  if (engine === 'chatterbox_turbo') return 'chatterbox-turbo';
  return engine;
}

/** Whisper (STT) y el LLM de personalidad (qwen3-*) no son TTS. */
function esModeloTts(nombre) {
  return !/^whisper-/.test(nombre) && !/^qwen3-\d/.test(nombre);
}

const PRIORIDAD_TAMANO_QWEN = ['1.7B', '0.6B'];

/**
 * Puerto de `resolve_engine_and_model` (voice-chat/common.py): override →
 * `default_engine` del perfil → qwen; para Qwen, el tamaño descargado de
 * mayor prioridad. Antes la narración mandaba siempre qwen 1.7B.
 */
function resolverMotor(perfil, estadoModelos = {}, engineOverride = null, sizeOverride = null) {
  const engine = engineOverride || (perfil && perfil.default_engine) || 'qwen';
  if (engine !== 'qwen' && engine !== 'qwen_custom_voice') {
    return { engine, modelSize: sizeOverride || null };
  }
  if (sizeOverride) return { engine, modelSize: sizeOverride };
  const prefijo = engine === 'qwen' ? 'qwen-tts-' : 'qwen-custom-voice-';
  for (const size of PRIORIDAD_TAMANO_QWEN) {
    const m = estadoModelos[`${prefijo}${size}`];
    if (m && m.downloaded) return { engine, modelSize: size };
  }
  return { engine, modelSize: '1.7B' };
}

/**
 * Qué TTS cargados descargar antes de generar con `objetivo`. Nunca el
 * objetivo, nunca el protegido (pin), nunca uno usado hace menos de 30 s: si
 * otro proceso está generando con él, se posterga y lo descarga el keeper.
 */
function modelosADescargar({ cargados, objetivo, usos = {}, ahora = Date.now(), protegido = null }) {
  return cargados.filter(n =>
    esModeloTts(n) &&
    n !== objetivo &&
    n !== protegido &&
    !(ahora - (usos[n] || 0) < VENTANA_EN_USO_MS)
  );
}

/**
 * Uso efectivo para el keeper. Un modelo sin archivo de uso (cargado por la
 * GUI, o el LLM de personalidad, que no pasa por nosotros) cuenta desde que
 * el keeper lo vio cargado. Los que no son TTS, además, se consideran usados
 * cada vez que se usa cualquier cosa: el LLM de personalidad trabaja dentro
 * de un /generate que solo registra el TTS.
 */
function usosEfectivos({ cargados, usos = {}, vistoDesde = {} }) {
  // Un solo NaN en Math.max contamina todo y el keeper deja de descargar.
  const finito = (v) => (Number.isFinite(v) ? v : 0);
  const global = Math.max(0, ...Object.values(usos).filter(Number.isFinite));
  const efectivos = {};
  for (const n of cargados) {
    const propio = Math.max(finito(usos[n]), finito(vistoDesde[n]));
    efectivos[n] = esModeloTts(n) ? propio : Math.max(propio, global);
  }
  return efectivos;
}

/**
 * Fechas de Voicebox: ISO sin zona horaria, en UTC. Sin la `Z`, Node las
 * interpreta como hora local (con UTC−3, tres horas en el futuro). Devuelve
 * null si no es una fecha válida: nunca NaN.
 */
function fechaVoicebox(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const t = s.trim();
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(t) ? t : `${t}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function esFresca(ts, ahora) {
  if (!Number.isFinite(ts)) return false;
  const delta = ahora - ts;
  return delta > -DESFASE_RELOJ_MS && delta < GENERACION_TTL_MS;
}

/** ¿Hay en Voicebox alguna generación en curso que no esté colgada? */
function hayGeneracionFresca(activas, ahora = Date.now()) {
  return (activas || []).some(g => esFresca(fechaVoicebox(g && g.started_at), ahora));
}

/**
 * Uso de Voicebox por clientes que no pasan por el plugin (la GUI, scripts):
 * sale de /history (motor y tamaño de cada generación) y de /tasks/active.
 * Sin esto, el keeper descargó un modelo a mitad de una generación ajena.
 */
function usosDesdeVoicebox({ historial = [], activas = [], cargados = [], ahora = Date.now() }) {
  const usos = {};
  const marcar = (modelo, ms) => {
    if (modelo && Number.isFinite(ms) && ms > (usos[modelo] || 0)) usos[modelo] = ms;
  };
  for (const item of historial || []) {
    if (!item || !item.engine) continue;
    const creada = fechaVoicebox(item.created_at);
    if (creada === null) continue;
    // Una generación que sigue en curso cuenta como uso ahora; una huérfana (más
    // vieja que el TTL) cuenta solo desde que se creó. «En curso» es cualquier
    // estado no final: Voicebox también reporta `loading_model` (visto en vivo),
    // no solo `generating`.
    const enCurso = !ESTADOS_FINALES.has(String(item.status || '').toLowerCase()) && esFresca(creada, ahora);
    marcar(ttsModelName(item.engine, item.model_size), enCurso ? ahora : Math.min(creada, ahora));
  }
  // Una generación en curso no dice con qué modelo trabaja: se protegen todos.
  if (hayGeneracionFresca(activas, ahora)) for (const n of cargados) marcar(n, ahora);
  return usos;
}

function decidirAccionKeeper({ pinModel = null, cargados = [], usos = {}, ahora = Date.now(), idleUnloadMs, idleShutdownMs, ownsServer, ultimoUso = 0, fallosSeguidos = 0 }) {
  if (fallosSeguidos >= 3) return { accion: 'salir' };
  // Un Voicebox que abrió el usuario desde la GUI es suyo: solo se observa.
  if (!ownsServer) return { accion: 'nada' };
  const descargar = cargados.filter(n => n !== pinModel && ahora - (usos[n] || 0) > idleUnloadMs);
  if (descargar.length) return { accion: 'descargar', modelos: descargar };
  if (!pinModel && cargados.length === 0 && idleShutdownMs > 0 && ahora - ultimoUso > idleShutdownMs) {
    return { accion: 'apagar' };
  }
  return { accion: 'nada' };
}

/** Minutos hasta la próxima descarga por inactividad, o null si no aplica. */
function minutosParaLiberar({ pinModel, cargados, usos, ahora, idleUnloadMs }) {
  const libres = cargados.filter(n => n !== pinModel);
  if (!libres.length) return null;
  const restante = Math.min(...libres.map(n => idleUnloadMs - (ahora - (usos[n] || 0))));
  return Math.max(0, Math.ceil(restante / 60000));
}

// ==============================================================================
// HTTP con Voicebox
// ==============================================================================

function pedir(url, { method = 'GET', timeout = 3000, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const datos = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      timeout,
      headers: datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {}
    }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', c => { texto += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: texto }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout de ${timeout} ms`)));
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}

async function salud(baseUrl, timeout = 3000) {
  try {
    const r = await pedir(`${baseUrl}/health`, { timeout });
    if (r.status >= 200 && r.status < 300) {
      let info = {};
      try { info = JSON.parse(r.body); } catch {}
      return { ok: true, info };
    }
    return { ok: false, error: `Voicebox respondió HTTP ${r.status} en /health` };
  } catch (err) {
    return { ok: false, error: `No se pudo contactar Voicebox en ${baseUrl} (${err.message})` };
  }
}

async function esperarSalud(baseUrl, totalMs, sondeoMs = 500) {
  const limite = Date.now() + totalMs;
  let ultimo;
  do {
    ultimo = await salud(baseUrl, 2000);
    if (ultimo.ok) return ultimo;
    await new Promise(r => setTimeout(r, sondeoMs));
  } while (Date.now() < limite);
  return ultimo;
}

async function estadoModelos(baseUrl) {
  const r = await pedir(`${baseUrl}/models/status`, { timeout: 5000 });
  if (r.status < 200 || r.status >= 300) throw new Error(`/models/status devolvió HTTP ${r.status}`);
  const datos = JSON.parse(r.body);
  return Array.isArray(datos.models) ? datos.models : [];
}

/** Generaciones en curso de cualquier cliente; [] si Voicebox no responde. */
async function generacionesActivas(baseUrl) {
  try {
    const r = await pedir(`${baseUrl}/tasks/active`, { timeout: 3000 });
    if (r.status < 200 || r.status >= 300) return [];
    const d = JSON.parse(r.body);
    return Array.isArray(d.generations) ? d.generations : [];
  } catch {
    return [];
  }
}

/** Últimas generaciones (terminadas o en curso) de cualquier cliente; [] si falla. */
async function historialReciente(baseUrl, limit = 20) {
  try {
    const r = await pedir(`${baseUrl}/history?limit=${limit}`, { timeout: 3000 });
    if (r.status < 200 || r.status >= 300) return [];
    const d = JSON.parse(r.body);
    return Array.isArray(d.items) ? d.items : [];
  } catch {
    return [];
  }
}

async function descargarModelo(baseUrl, nombre) {
  const r = await pedir(`${baseUrl}/models/${encodeURIComponent(nombre)}/unload`, { method: 'POST', timeout: 15000, body: {} });
  if (r.status < 200 || r.status >= 300) throw new Error(`unload de ${nombre} devolvió HTTP ${r.status}`);
}

async function cargarQwen(baseUrl, modelSize) {
  const r = await pedir(`${baseUrl}/models/load?model_size=${encodeURIComponent(modelSize || '1.7B')}`, { method: 'POST', timeout: 60000 });
  if (r.status < 200 || r.status >= 300) throw new Error(`/models/load devolvió HTTP ${r.status}`);
}

async function apagarServer(baseUrl) {
  try {
    await pedir(`${baseUrl}/shutdown`, { method: 'POST', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function esUrlLocal(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

function puertoDeUrl(baseUrl) {
  try {
    return Number(new URL(baseUrl).port) || PUERTO_POR_DEFECTO;
  } catch {
    return PUERTO_POR_DEFECTO;
  }
}

/** `{ usadoMb, libreMb, totalMb }` de la primera GPU NVIDIA, o null. */
function vramNvidia(ejecutar = execFileSync) {
  try {
    const salida = ejecutar('nvidia-smi', ['--query-gpu=memory.used,memory.free,memory.total', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    const [usadoMb, libreMb, totalMb] = String(salida).split(/\r?\n/)[0].split(',').map(s => Number(s.trim()));
    if (![usadoMb, libreMb, totalMb].every(Number.isFinite)) return null;
    return { usadoMb, libreMb, totalMb };
  } catch {
    return null;
  }
}

function avisoCpu(info) {
  if (!info || info.backend_variant !== 'cpu') return null;
  if (!vramNvidia()) return null;
  return 'Voicebox corre en CPU aunque hay una GPU NVIDIA: falta el backend CUDA. Abrí la app de Voicebox una vez para que lo descargue.';
}

// ==============================================================================
// Keeper
// ==============================================================================

function leerKeeper(env = process.env) {
  try {
    const k = JSON.parse(fs.readFileSync(rutasEstado(env).keeperPid, 'utf8'));
    return { ...k, vivo: pidVivo(k.pid) };
  } catch {
    return null;
  }
}

/**
 * Lanza el keeper desacoplado. Nunca hereda el stdio del MCP: ese es el canal
 * JSON-RPC con Claude Code y cualquier byte del hijo lo corrompería.
 */
function lanzarKeeper({ baseUrl, exe = null, dataDir = null, env = process.env, spawnFn = spawn }) {
  const rutas = rutasEstado(env);
  asegurarDirEstado(env);
  const args = [RUTA_KEEPER, '--url', baseUrl, '--port', String(puertoDeUrl(baseUrl))];
  if (exe) args.push('--exe', exe, '--data-dir', dataDir);
  const fd = fs.openSync(rutas.keeperLog, 'a');
  try {
    const hijo = spawnFn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env
    });
    if (hijo && typeof hijo.unref === 'function') hijo.unref();
    return hijo;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Garantiza que Voicebox responde, levantándolo sin GUI si hace falta.
 * No toca un Voicebox que ya corre: con la GUI abierta solo lanza un keeper de
 * solo lectura, para que la statusline muestre el estado.
 */
async function ensureVoicebox(baseUrl, opts = {}) {
  const {
    config = {},
    env = process.env,
    platform = process.platform,
    spawnFn = spawn,
    tiempos = {}
  } = opts;
  const esperaArranque = tiempos.arranque ?? ESPERA_ARRANQUE_MS;
  const esperaAjeno = tiempos.lockAjeno ?? ESPERA_LOCK_AJENO_MS;
  const rutas = rutasEstado(env);

  const h = await salud(baseUrl);
  if (h.ok) {
    if (esUrlLocal(baseUrl) && platform === 'win32' && config.voiceboxAutostart !== false) {
      const k = leerKeeper(env);
      if (!k || !k.vivo) {
        try { lanzarKeeper({ baseUrl, env, spawnFn }); } catch {}
      }
    }
    return { ok: true, info: h.info, started: false, aviso: avisoCpu(h.info) };
  }

  if (!esUrlLocal(baseUrl)) {
    return { ok: false, error: `${h.error}. La URL no es local: el autoarranque solo levanta Voicebox en esta máquina.` };
  }
  if (config.voiceboxAutostart === false) {
    return { ok: false, error: `${h.error}. El autoarranque está desactivado (\`voicebox_autostart: false\`): abrí la app de Voicebox.` };
  }
  if (platform !== 'win32') {
    return { ok: false, error: `${h.error}. El autoarranque sin GUI solo está implementado en Windows: abrí Voicebox a mano.` };
  }

  const dataDir = voiceboxDataDir(env, platform);
  const { exe, variante, buscado } = resolverEjecutable({ env, config, dataDir, platform });
  if (!exe) {
    return {
      ok: false,
      error: `${h.error}. No se encontró el servidor de Voicebox (buscado: ${buscado.join(', ') || 'nada'}). ` +
        'Instalá Voicebox y abrilo una vez (descarga el backend CUDA), o fijá VOICEBOX_SERVER_EXE.'
    };
  }

  asegurarDirEstado(env);
  const lock = tomarLock(rutas.startLock, { staleMs: START_LOCK_STALE_MS });
  if (!lock) {
    const h2 = await esperarSalud(baseUrl, esperaAjeno);
    return h2.ok
      ? { ok: true, info: h2.info, started: false, esperoAOtro: true, aviso: avisoCpu(h2.info) }
      : { ok: false, error: `Otro proceso está levantando Voicebox y no respondió en ${Math.round(esperaAjeno / 1000)} s. Logs: ${rutas.serverLog}, ${rutas.keeperLog}` };
  }

  try {
    lanzarKeeper({ baseUrl, exe, dataDir, env, spawnFn });
    const h2 = await esperarSalud(baseUrl, esperaArranque);
    if (!h2.ok) {
      return { ok: false, error: `Se lanzó Voicebox (${exe}) pero no respondió en ${Math.round(esperaArranque / 1000)} s. Revisá ${rutas.serverLog} y ${rutas.keeperLog}.` };
    }
    return { ok: true, info: h2.info, started: true, exe, variante, aviso: avisoCpu(h2.info) };
  } finally {
    soltarLock(lock);
  }
}

function mensajeConflictoPin(pin, objetivo, voz) {
  const quien = pin.voice ? `, por ${pin.voice}` : '';
  const pedido = voz ? `${voz} usa ${objetivo}` : `se pidió ${objetivo}`;
  return `Hay un modelo fijado (${pin.model}${quien}); ${pedido}. ` +
    'Soltalo con `agy_voice_model` action `release`, o fijá el nuevo con action `pin`.';
}

/**
 * Deja la VRAM lista para generar con (engine, modelSize): respeta el pin,
 * aplica la guarda de VRAM y descarga los TTS ajenos que no estén en uso.
 * Con `fijar`, además registra el pin (y precarga si es Qwen).
 */
async function aplicarModeloActivo(baseUrl, { engine, modelSize = null, voz = null, fijar = false }, deps = {}) {
  const env = deps.env || process.env;
  const ahora = (deps.ahora || Date.now)();
  const obtenerModelos = deps.estadoModelos || estadoModelos;
  const descargar = deps.descargarModelo || descargarModelo;
  const medirVram = deps.vram || vramNvidia;
  const objetivo = ttsModelName(engine, modelSize);

  const pin = leerPin(env);
  if (pin && pin.model !== objetivo && !fijar) {
    return { ok: false, conflicto: true, objetivo, error: mensajeConflictoPin(pin, objetivo, voz) };
  }

  const modelos = await obtenerModelos(baseUrl);
  const porNombre = Object.fromEntries(modelos.map(m => [m.model_name, m]));
  const cargados = modelos.filter(m => m.loaded).map(m => m.model_name);
  const protegido = fijar ? null : (pin && pin.model);
  const candidatos = modelosADescargar({ cargados, objetivo, usos: leerUsos(env), ahora, protegido });
  // Con una generación en curso en Voicebox (de cualquier cliente, incluso
  // otra sesión del plugin) no se descarga nada: podría ser el modelo que usa.
  const enCurso = hayGeneracionFresca(await (deps.generacionesActivas || generacionesActivas)(baseUrl), ahora);
  const aDescargar = enCurso ? [] : candidatos;
  const postergados = cargados.filter(n => esModeloTts(n) && n !== objetivo && !aDescargar.includes(n));

  const yaCargado = cargados.includes(objetivo);
  let guarda = yaCargado ? 'ya-cargado' : 'omitida';
  if (!yaCargado) {
    const vram = medirVram();
    const tam = porNombre[objetivo] && porNombre[objetivo].size_mb;
    if (vram && tam) {
      const libera = aDescargar.reduce((s, n) => s + ((porNombre[n] && porNombre[n].size_mb) || 0), 0);
      const necesita = tam * MARGEN_VRAM;
      if (vram.libreMb + libera < necesita) {
        if (enCurso && candidatos.length) {
          return {
            ok: false,
            objetivo,
            error: `Hay una generación en curso en Voicebox (otro cliente); no se puede liberar VRAM para ${objetivo} ahora. Reintentá en unos segundos.`
          };
        }
        return {
          ok: false,
          objetivo,
          error: `VRAM insuficiente para ${objetivo}: necesita ~${Math.round(necesita)} MB y hay ${Math.round(vram.libreMb)} MB libres` +
            (libera ? ` (+${Math.round(libera)} MB al descargar ${aDescargar.join(', ')})` : '') + '. No se cargó nada.'
        };
      }
      guarda = 'ok';
    }
  }

  const descargados = [];
  for (const n of aDescargar) {
    try {
      await descargar(baseUrl, n);
      descargados.push(n);
    } catch (err) {
      process.stderr.write(`[voicebox] No se pudo descargar ${n}: ${err.message}\n`);
    }
  }

  if (fijar) {
    escribirPin({ model: objetivo, engine, modelSize: modelSize || null, voice: voz || null, since: new Date(ahora).toISOString() }, env);
    if (engine === 'qwen' && !yaCargado) {
      try {
        await (deps.cargarQwen || cargarQwen)(baseUrl, modelSize);
      } catch (err) {
        process.stderr.write(`[voicebox] Precarga de ${objetivo} falló (se cargará al primer uso): ${err.message}\n`);
      }
    }
  }

  tocarUso(objetivo, env);
  return { ok: true, objetivo, descargados, postergados, guarda, fijado: Boolean(fijar) };
}

module.exports = {
  PUERTO_POR_DEFECTO,
  START_LOCK_STALE_MS,
  ESPERA_LOCK_AJENO_MS,
  VENTANA_EN_USO_MS,
  INTERVALO_TOQUE_MS,
  ESTADO_FRESCO_MS,
  CONFIG_POR_DEFECTO,
  RUTA_KEEPER,
  dirEstado,
  asegurarDirEstado,
  rutasEstado,
  voiceboxDataDir,
  resolverEjecutable,
  aplicarClavesVoicebox,
  leerConfigVoicebox,
  pidVivo,
  tomarLock,
  soltarLock,
  escribirAtomico,
  tocarUso,
  iniciarToquesPeriodicos,
  leerUsos,
  leerPin,
  escribirPin,
  ttsModelName,
  esModeloTts,
  resolverMotor,
  modelosADescargar,
  usosEfectivos,
  decidirAccionKeeper,
  minutosParaLiberar,
  pedir,
  salud,
  esperarSalud,
  estadoModelos,
  descargarModelo,
  cargarQwen,
  apagarServer,
  esUrlLocal,
  puertoDeUrl,
  vramNvidia,
  avisoCpu,
  leerKeeper,
  lanzarKeeper,
  ensureVoicebox,
  aplicarModeloActivo,
  mensajeConflictoPin,
  GENERACION_TTL_MS,
  fechaVoicebox,
  esFresca,
  hayGeneracionFresca,
  usosDesdeVoicebox,
  generacionesActivas,
  historialReciente
};
