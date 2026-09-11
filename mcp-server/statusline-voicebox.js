/**
 * Segmento de statusline: Voicebox y VRAM libre.
 *
 * Solo lee `~/.claude/lagrange-voicebox/estado.json`, que el keeper reescribe
 * cada 10 s. No hace HTTP ni lanza nvidia-smi: la statusline se ejecuta cada
 * pocos segundos y bloquearla es peor que mostrar un dato de 10 s atrás.
 *
 * Sin archivo, o con uno de más de 30 s, no hay keeper vivo: el segmento
 * desaparece.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { dirEstado, leerConfigVoicebox, ESTADO_FRESCO_MS } = require('./voicebox-server.js');

function gb(mb) {
  return (mb / 1024).toFixed(1);
}

function armarLineaVoicebox(estado, ahora = Date.now()) {
  if (!estado || typeof estado !== 'object') return null;
  const edad = ahora - Date.parse(estado.actualizado);
  if (!Number.isFinite(edad) || edad > ESTADO_FRESCO_MS) return null;

  let modo;
  if (estado.modo === 'gui') modo = 'modo GUI';
  else if (estado.variante === 'cpu') modo = '⚠ cpu';
  else modo = estado.variante || '?';

  const partes = [];
  const cargados = Array.isArray(estado.cargados) ? estado.cargados : [];
  partes.push(cargados.length
    ? cargados.map(m => `${m.nombre}${m.nombre === estado.pin ? ' 📌' : ''}`).join(', ')
    : 'sin modelo cargado');

  const v = estado.vram;
  if (v && Number.isFinite(v.libreMb) && Number.isFinite(v.totalMb)) {
    partes.push(`VRAM ${gb(v.libreMb)}/${gb(v.totalMb)} GB libre`);
  }
  if (!estado.pin && cargados.length && Number.isFinite(estado.liberaEnMin)) {
    partes.push(`libera en ${estado.liberaEnMin}m`);
  }

  return `🎙️ voicebox ${modo} · ${partes.join(' · ')}`;
}

function segmentoVoicebox(ctx = {}) {
  const cfg = leerConfigVoicebox(ctx.cwd || null);
  if (cfg.statuslineVoicebox === false) return null;
  let estado;
  try {
    estado = JSON.parse(fs.readFileSync(path.join(dirEstado(), 'estado.json'), 'utf8'));
  } catch {
    return null;
  }
  return armarLineaVoicebox(estado);
}

module.exports = { segmentoVoicebox, armarLineaVoicebox };
