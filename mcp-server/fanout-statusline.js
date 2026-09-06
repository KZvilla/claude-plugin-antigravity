#!/usr/bin/env node
/**
 * Script standalone para `statusLine.command` (FEAT-005 V1).
 *
 * No depende del servidor MCP: se invoca como proceso aparte, cada
 * `refreshInterval` segundos, con el JSON de estado de Claude Code por stdin
 * (mismo contrato que usa claude-hud — ver
 * plugins/cache/claude-hud/<version>/dist/stdin.js e index.js:97, que leen
 * `stdin.cwd`). Lee el archivo que `fanout-estado.js` escribe durante un
 * `agy_fanout` en curso y agrega una línea de progreso a lo que ya hubiera en
 * la statusline, sin reemplazarlo.
 *
 * Nunca debe tirar una excepción sin capturar ni colgarse: una statusline
 * rota es peor que una statusline muda.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const TTL_TERMINADO_MIN = 10;
const PRIMER_BYTE_TIMEOUT_MS = 250;
const INACTIVIDAD_TIMEOUT_MS = 30;
const MAX_BYTES_STDIN = 256 * 1024;

/** Devuelve { json, raw }: el JSON parseado (o null) y el texto crudo recibido. */
function leerStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({ json: null, raw: '' });

    let crudo = '';
    let asentado = false;
    let timerPrimerByte;
    let timerInactividad;

    const terminar = () => {
      if (asentado) return;
      asentado = true;
      clearTimeout(timerPrimerByte);
      clearTimeout(timerInactividad);
      process.stdin.pause();
      const texto = crudo.trim();
      let json = null;
      if (texto) {
        try { json = JSON.parse(texto); } catch { json = null; }
      }
      resolve({ json, raw: crudo });
    };

    const reprogramarInactividad = () => {
      clearTimeout(timerInactividad);
      timerInactividad = setTimeout(terminar, INACTIVIDAD_TIMEOUT_MS);
    };

    timerPrimerByte = setTimeout(terminar, PRIMER_BYTE_TIMEOUT_MS);

    try {
      process.stdin.setEncoding('utf8');
    } catch {
      return terminar();
    }

    process.stdin.on('data', (chunk) => {
      clearTimeout(timerPrimerByte);
      crudo += chunk;
      if (crudo.length > MAX_BYTES_STDIN) return terminar();
      reprogramarInactividad();
    });
    process.stdin.on('end', terminar);
    process.stdin.on('error', terminar);
  });
}

function archivosDeEstado(cwd) {
  const dir = path.join(cwd, '.claude', 'worktrees');
  let nombres = [];
  try {
    nombres = fs.readdirSync(dir).filter(n => n.startsWith('.fanout-status-') && n.endsWith('.json'));
  } catch {
    return [];
  }
  return nombres.map(n => path.join(dir, n));
}

function corridaMasReciente(cwd) {
  let mejor = null;
  for (const ruta of archivosDeEstado(cwd)) {
    let datos;
    try {
      datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch {
      continue;
    }
    if (!mejor || String(datos.actualizado || '') > String(mejor.actualizado || '')) {
      mejor = datos;
    }
  }
  return mejor;
}

function estaExpirada(datos) {
  if (!datos.terminado) return false;
  const edadMs = Date.now() - new Date(datos.terminado).getTime();
  return Number.isFinite(edadMs) && edadMs > TTL_TERMINADO_MIN * 60 * 1000;
}

function formatearDuracion(desdeIso) {
  const ms = Date.now() - new Date(desdeIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeg = Math.floor(ms / 1000);
  const m = Math.floor(totalSeg / 60);
  const s = totalSeg % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

function armarLinea(datos) {
  const tareas = Object.values(datos.tareas || {});
  if (tareas.length === 0) return null;

  const contar = estado => tareas.filter(t => t.estado === estado).length;
  const ok = contar('ok');
  const error = contar('error');
  const reintentando = tareas.filter(t => t.estado === 'reintentando');
  const corriendo = contar('corriendo');
  const total = tareas.length;

  const partes = [`${ok + error}/${total}`];
  if (ok) partes.push(`${ok} ok`);
  if (error) partes.push(`${error} error`);
  if (reintentando.length) {
    const porCuota = reintentando.some(t => t.porCuota);
    partes.push(`${reintentando.length} reintentando${porCuota ? '(429)' : ''}`);
  }
  if (corriendo) partes.push(`${corriendo} corriendo`);

  const duracion = formatearDuracion(datos.terminado || datos.iniciado);
  const sufijo = datos.terminado ? ` (terminado, ${duracion})` : ` (${duracion})`;

  return `🔀 fanout ${datos.slug}: ${partes.join(' · ')}${sufijo}`;
}

function leerDelegado(cwd) {
  // Mismo orden de resolución que loadConfig en index.js: global primero,
  // luego project pisa. Acá solo interesa un campo, no vale duplicar todo
  // el módulo de config del servidor MCP en un script standalone.
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const rutas = [
    path.join(homeDir, '.claude', 'antigravity.json'),
    path.join(cwd, '.claude', 'antigravity.json')
  ];
  let delegado = null;
  for (const ruta of rutas) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      if (parsed.fanout_statusline_delegate !== undefined) delegado = parsed.fanout_statusline_delegate;
    } catch {}
  }
  return delegado;
}

function ejecutarDelegado(comando, stdinCrudo) {
  if (!comando) return '';
  try {
    // Verificado en vivo el 2026-09-05: el delegado que guarda el setup (p. ej.
    // el propio comando de claude-hud) usa sintaxis POSIX (`case`, `${var:-x}`,
    // `$( )`) porque así es como Claude Code invoca `statusLine.command` — pero
    // el default de `execSync` en Windows es `cmd.exe` (ComSpec), que no
    // entiende nada de eso y falla con "cols no se reconoce como...". Pedirle
    // `bash` explícitamente reproduce el shell real que usa Claude Code, no el
    // default de Node. Si `bash` no está en PATH, execSync tira y cae al
    // catch: se pierde ese segmento, no se rompe nada.
    return execSync(comando, { input: stdinCrudo || '', encoding: 'utf8', timeout: 5000, shell: 'bash' }).trimEnd();
  } catch {
    return '';
  }
}

async function main() {
  // El texto crudo de stdin se necesita dos veces: para nuestro propio parseo
  // y para pasárselo intacto al comando delegado (que espera el mismo
  // contrato de Claude Code).
  const { json: datosStdin, raw: crudo } = await leerStdin();

  const cwd = (datosStdin && typeof datosStdin.cwd === 'string' && datosStdin.cwd) || process.cwd();

  const base = ejecutarDelegado(leerDelegado(cwd), crudo);

  let lineaFanout = '';
  try {
    const corrida = corridaMasReciente(cwd);
    if (corrida && !estaExpirada(corrida)) {
      lineaFanout = armarLinea(corrida) || '';
    }
  } catch {
    lineaFanout = '';
  }

  const salida = [base, lineaFanout].filter(Boolean).join('\n');
  process.stdout.write(salida);
}

main().catch(() => {
  // Nunca dejar un stack trace en la statusline.
  process.stdout.write('');
});
