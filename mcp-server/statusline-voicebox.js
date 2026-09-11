/**
 * Segmento de statusline: servidores de voz (Voicebox, OmniVoice) y VRAM.
 *
 * Los modelos cargados salen de los estados que escriben sus dueños: el keeper
 * de Voicebox (`estado.json`) y el server de OmniVoice
 * (`omnivoice-estado.json`), cada 10 s. Si ninguno está fresco (más de 30 s),
 * no hay nada de voz corriendo y el segmento desaparece.
 *
 * La VRAM se mide en vivo, al estilo de claude-hud (que calcula en cada
 * ejecución de la statusline con una caché de 3 s): `nvidia-smi` tarda ~45 ms
 * y se cachea 3 s en `vram-cache.json`. Antes salía del ciclo de 10 s del
 * keeper (retraso de hasta ~15 s) y mostraba la memoria LIBRE sobre el total:
 * «22/24» se leía como memoria casi llena cuando era al revés.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { dirEstado, leerConfigVoicebox, ESTADO_FRESCO_MS, escribirAtomico } = require('./voicebox-server.js');

const VRAM_CACHE_MS = 3000;
const UMBRAL_ALERTA = 0.85;

function gb(mb) {
  return (mb / 1024).toFixed(1);
}

function leerJson(ruta) {
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch {
    return null;
  }
}

function fresco(estado, ahora) {
  if (!estado || typeof estado !== 'object') return false;
  const edad = ahora - Date.parse(estado.actualizado);
  return Number.isFinite(edad) && edad <= ESTADO_FRESCO_MS;
}

/** `{ usadoMb, totalMb }` de la GPU, con caché de 3 s entre ejecuciones. */
function vramEnVivo({ ahora = Date.now(), ejecutar = execFileSync } = {}) {
  const ruta = path.join(dirEstado(), 'vram-cache.json');
  const c = leerJson(ruta);
  if (c && Number.isFinite(c.ts) && ahora - c.ts >= 0 && ahora - c.ts < VRAM_CACHE_MS && Number.isFinite(c.usadoMb) && Number.isFinite(c.totalMb)) {
    return c;
  }
  try {
    const salida = ejecutar('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    const [usadoMb, totalMb] = String(salida).split(/\r?\n/)[0].split(',').map(s => Number(s.trim()));
    if (!Number.isFinite(usadoMb) || !Number.isFinite(totalMb) || totalMb <= 0) return null;
    const v = { ts: ahora, usadoMb, totalMb };
    try { escribirAtomico(ruta, JSON.stringify(v)); } catch {}
    return v;
  } catch {
    return null;
  }
}

/** `VRAM usada/total GB`, con aviso arriba del 85 % (la convención de todos los HUD). */
function textoVram(v) {
  if (!v || !Number.isFinite(v.usadoMb) || !Number.isFinite(v.totalMb) || v.totalMb <= 0) return null;
  const alerta = v.usadoMb / v.totalMb > UMBRAL_ALERTA ? '⚠ ' : '';
  return `${alerta}VRAM ${gb(v.usadoMb)}/${gb(v.totalMb)} GB`;
}

function armarLineaVoicebox(estado, ahora = Date.now(), { omni = null, vram = null } = {}) {
  const hayVb = fresco(estado, ahora);
  const hayOmni = fresco(omni, ahora);
  if (!hayVb && !hayOmni) return null;

  const partes = [];
  let cabecera;
  if (hayVb) {
    let modo;
    if (estado.modo === 'gui') modo = 'modo GUI';
    else if (estado.variante === 'cpu') modo = '⚠ cpu';
    else modo = estado.variante || '?';
    cabecera = `🎙️ voicebox ${modo}`;
    const cargados = Array.isArray(estado.cargados) ? estado.cargados : [];
    if (cargados.length) partes.push(cargados.map(m => `${m.nombre}${m.nombre === estado.pin ? ' 📌' : ''}`).join(', '));
    else if (!hayOmni || !omni.cargado) partes.push('sin modelo cargado');
    if (hayOmni && omni.cargado) partes.push(`omnivoice${omni.pin ? ' 📌' : ''}`);
  } else {
    cabecera = `🎙️ omnivoice ${omni.variante || ''}`.trimEnd();
    partes.push(omni.cargado ? `cargado${omni.pin ? ' 📌' : ''}` : 'sin modelo cargado');
  }

  const tv = textoVram(vram);
  if (tv) partes.push(tv);

  const liberan = [];
  if (hayVb && !estado.pin && (estado.cargados || []).length && Number.isFinite(estado.liberaEnMin)) liberan.push(estado.liberaEnMin);
  if (hayOmni && omni.cargado && Number.isFinite(omni.liberaEnMin)) liberan.push(omni.liberaEnMin);
  if (liberan.length) partes.push(`libera en ${Math.min(...liberan)}m`);

  return `${cabecera} · ${partes.join(' · ')}`;
}

function segmentoVoicebox(ctx = {}) {
  const cfg = leerConfigVoicebox(ctx.cwd || null);
  if (cfg.statuslineVoicebox === false) return null;
  const dir = dirEstado();
  const estado = leerJson(path.join(dir, 'estado.json'));
  const omni = leerJson(path.join(dir, 'omnivoice-estado.json'));
  const ahora = Date.now();
  // Sin ningún server de voz vivo no se corre nvidia-smi.
  if (!fresco(estado, ahora) && !fresco(omni, ahora)) return null;
  return armarLineaVoicebox(estado, ahora, { omni, vram: vramEnVivo({ ahora }) });
}

module.exports = { segmentoVoicebox, armarLineaVoicebox, textoVram, vramEnVivo, VRAM_CACHE_MS };
