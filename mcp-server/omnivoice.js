/**
 * OmniVoice: segundo proveedor de voz, al lado de Voicebox.
 *
 * Plan: docs/future-implementations/plan-omnivoice.md (v3, auditado).
 *
 * El servidor (omnivoice-server/servidor.py) corre con el Python del venv que
 * instala `npm run omnivoice:install` y tiene su propio ciclo de vida. Este
 * módulo lo levanta, le pide audio, guarda la caché de voces y decide qué
 * proveedor usa cada narración.
 *
 * Voicebox sigue siendo la fuente de verdad de las voces: de ahí salen los
 * perfiles y las muestras que OmniVoice clona. La caché solo sirve para seguir
 * narrando con OmniVoice cuando Voicebox no levanta.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vb = require('./voicebox-server.js');

const PUERTO_OMNI = 17494;
// Dos oraciones a la vez (voice-chat) se serializan en el lock de la GPU: la
// segunda espera a la primera. 90 s, como waitForGenerationFile.
const TIMEOUT_GENERAR_MS = 90000;
const ESPERA_ARRANQUE_MS = 60000;
const MUESTRA_LARGA_S = 20;
const RUTA_SERVIDOR = path.join(__dirname, '..', 'omnivoice-server', 'servidor.py');

function baseOmni(env = process.env, config = {}) {
  if (env.OMNIVOICE_DIR) return path.resolve(env.OMNIVOICE_DIR);
  if (config.omnivoiceDir) return path.resolve(config.omnivoiceDir);
  const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || env.HOME || os.homedir(), 'AppData', 'Local');
  return path.join(local, 'lagrange-omnivoice');
}

function rutasOmni(env = process.env, config = {}) {
  const base = baseOmni(env, config);
  const estado = vb.rutasEstado(env);
  return {
    base,
    python: path.join(base, 'venv', 'Scripts', 'python.exe'),
    modelos: path.join(base, 'models', 'OmniVoice'),
    servidor: RUTA_SERVIDOR,
    log: path.join(estado.dir, 'omnivoice-server.log'),
    lock: path.join(estado.dir, 'omnivoice-start.lock'),
    estado: path.join(estado.dir, 'omnivoice-estado.json'),
    cacheVoces: path.join(estado.dir, 'voces-cache.json')
  };
}

function omniInstalado({ env = process.env, config = {}, platform = process.platform, existe = fs.existsSync } = {}) {
  if (platform !== 'win32') return false;
  const r = rutasOmni(env, config);
  return existe(r.python) && existe(path.join(r.modelos, 'config.json')) && existe(r.servidor);
}

function urlOmni(config = {}) {
  return `http://127.0.0.1:${Number(config.omnivoicePort) || PUERTO_OMNI}`;
}

/**
 * Levanta el servidor de OmniVoice si no responde. Mismo patrón que
 * ensureVoicebox (lock entre procesos, spawn desacoplado sin heredar el stdio
 * del MCP), pero **sin** --parent-pid: su padre sería el MCP y moriría al
 * cerrar Claude Code, cortando la descarga por inactividad.
 */
async function ensureOmniVoice(url, opts = {}) {
  const { config = {}, env = process.env, platform = process.platform, spawnFn = spawn, tiempos = {}, existe = fs.existsSync } = opts;
  const h = await vb.salud(url);
  if (h.ok) return { ok: true, info: h.info, started: false };

  if (!omniInstalado({ env, config, platform, existe })) {
    return { ok: false, error: 'OmniVoice no está instalado (npm run omnivoice:install).' };
  }
  const r = rutasOmni(env, config);
  vb.asegurarDirEstado(env);
  const lock = vb.tomarLock(r.lock, { staleMs: vb.START_LOCK_STALE_MS });
  if (!lock) {
    const h2 = await vb.esperarSalud(url, tiempos.lockAjeno ?? vb.ESPERA_LOCK_AJENO_MS);
    return h2.ok ? { ok: true, info: h2.info, started: false } : { ok: false, error: `Otro proceso está levantando OmniVoice y no respondió. Log: ${r.log}` };
  }
  try {
    const fd = fs.openSync(r.log, 'a');
    try {
      const puerto = String(new URL(url).port || PUERTO_OMNI);
      const hijo = spawnFn(r.python, [r.servidor, '--port', puerto, '--models-dir', r.modelos], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env
      });
      if (hijo && typeof hijo.unref === 'function') hijo.unref();
    } finally {
      fs.closeSync(fd);
    }
    const h2 = await vb.esperarSalud(url, tiempos.arranque ?? ESPERA_ARRANQUE_MS);
    return h2.ok
      ? { ok: true, info: h2.info, started: true }
      : { ok: false, error: `Se lanzó OmniVoice pero no respondió en ${Math.round((tiempos.arranque ?? ESPERA_ARRANQUE_MS) / 1000)} s. Revisá ${r.log}.` };
  } finally {
    vb.soltarLock(lock);
  }
}

async function sintetizarOmni(url, { texto, refAudio, refText = null, classTemperature = null }) {
  const body = { text: texto, ref_audio: refAudio, ref_text: refText };
  if (Number.isFinite(classTemperature)) body.class_temperature = classTemperature;
  const r = await vb.pedir(`${url}/generate`, { method: 'POST', timeout: TIMEOUT_GENERAR_MS, body });
  let d = {};
  try { d = JSON.parse(r.body); } catch {}
  if (r.status < 200 || r.status >= 300) throw new Error(`OmniVoice respondió HTTP ${r.status}: ${d.detail || r.body.slice(0, 200)}`);
  return { id: d.id, audioPath: d.audio_path, duracion: d.duration, segundos: d.seconds };
}

// ==============================================================================
// Caché de voces (un solo escritor lógico: el MCP)
// ==============================================================================

function leerCacheVoces(env = process.env) {
  try {
    const c = JSON.parse(fs.readFileSync(rutasOmni(env).cacheVoces, 'utf8'));
    return c && typeof c === 'object' ? c : null;
  } catch {
    return null;
  }
}

function guardarCacheVoces({ perfiles = null, muestra = null }, env = process.env) {
  try {
    vb.asegurarDirEstado(env);
    const actual = leerCacheVoces(env) || { perfiles: [], muestras: {} };
    if (Array.isArray(perfiles)) actual.perfiles = perfiles;
    if (muestra && muestra.profileId) {
      actual.muestras = actual.muestras || {};
      actual.muestras[muestra.profileId] = { audioPath: muestra.audioPath, refText: muestra.refText };
    }
    actual.actualizado = new Date().toISOString();
    vb.escribirAtomico(rutasOmni(env).cacheVoces, JSON.stringify(actual));
  } catch {}
}

/** Duración de un .wav PCM leyendo su cabecera, o null si no se puede. */
function duracionWav(ruta) {
  try {
    const fd = fs.openSync(ruta, 'r');
    try {
      const cab = Buffer.alloc(44);
      fs.readSync(fd, cab, 0, 44, 0);
      if (cab.toString('ascii', 0, 4) !== 'RIFF') return null;
      const byteRate = cab.readUInt32LE(28);
      return byteRate ? (fs.statSync(ruta).size - 44) / byteRate : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Muestra de voz de un perfil: de la API de Voicebox (y se guarda en la
 * caché) o, si Voicebox no responde, de la caché. `{ audioPath, refText }`
 * con ruta absoluta, o null si el perfil no tiene muestra (preset).
 */
async function muestraDePerfil(voiceboxUrl, perfil, { env = process.env } = {}) {
  if (!perfil || !perfil.id) return null;
  if (voiceboxUrl) {
    try {
      const r = await vb.pedir(`${voiceboxUrl}/profiles/${encodeURIComponent(perfil.id)}/samples`, { timeout: 5000 });
      if (r.status >= 200 && r.status < 300) {
        const lista = JSON.parse(r.body);
        const s = (Array.isArray(lista) ? lista : []).find(x => x && x.reference_text) || (Array.isArray(lista) ? lista[0] : null);
        if (!s || !s.audio_path) return null;
        const dataDir = vb.voiceboxDataDir(env);
        const audioPath = path.isAbsolute(s.audio_path) || !dataDir ? s.audio_path : path.join(dataDir, s.audio_path);
        const muestra = { profileId: perfil.id, audioPath, refText: s.reference_text || null };
        guardarCacheVoces({ muestra }, env);
        return muestra;
      }
    } catch {}
  }
  const c = leerCacheVoces(env);
  const m = c && c.muestras && c.muestras[perfil.id];
  return m ? { profileId: perfil.id, audioPath: m.audioPath, refText: m.refText || null } : null;
}

// ==============================================================================
// Elección de proveedor (regla fija del usuario)
// ==============================================================================

/**
 * Preferencia antes de mirar disponibilidad: motor explícito → voz fijada en
 * config (`voz_por_perfil`) → modo (inmediato → OmniVoice, diferido →
 * Voicebox). La regla por modo es fija: el usuario la decidió así.
 */
function preferenciaProveedor({ motorPedido = null, modo = 'inmediato', perfil = null, config = {} }) {
  if (motorPedido === 'omnivoice' || motorPedido === 'voicebox') {
    return { proveedor: motorPedido, motivo: 'pedido explícito' };
  }
  const porVoz = perfil && config.vozPorPerfil && config.vozPorPerfil[perfil.name];
  if (porVoz === 'omnivoice' || porVoz === 'voicebox') {
    return { proveedor: porVoz, motivo: `fijado para ${perfil.name} en voz_por_perfil` };
  }
  return modo === 'diferido'
    ? { proveedor: 'voicebox', motivo: 'modo diferido' }
    : { proveedor: 'omnivoice', motivo: 'modo inmediato' };
}

function avisoMuestraLarga(muestra, perfil) {
  if (!muestra) return null;
  const s = duracionWav(muestra.audioPath);
  if (!Number.isFinite(s) || s <= MUESTRA_LARGA_S) return null;
  return `La muestra de ${perfil ? perfil.name : 'esta voz'} dura ${Math.round(s)} s: OmniVoice clona mejor con 3 a 10 s. Acortala en Voicebox.`;
}

module.exports = {
  PUERTO_OMNI,
  TIMEOUT_GENERAR_MS,
  MUESTRA_LARGA_S,
  RUTA_SERVIDOR,
  baseOmni,
  rutasOmni,
  omniInstalado,
  urlOmni,
  ensureOmniVoice,
  sintetizarOmni,
  leerCacheVoces,
  guardarCacheVoces,
  duracionWav,
  muestraDePerfil,
  preferenciaProveedor,
  avisoMuestraLarga
};
