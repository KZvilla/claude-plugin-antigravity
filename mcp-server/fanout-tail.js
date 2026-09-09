#!/usr/bin/env node
/**
 * Contenido de cada pane de `wt` (FEAT-010): sigue el log NDJSON de un
 * subagente (FEAT-009, mcp-server/fanout-estado.js `rutaProgreso`) y lo
 * formatea línea por línea a medida que se escribe. No depende del servidor
 * MCP — se invoca como proceso aparte, uno por pane.
 *
 * Uso: node fanout-tail.js <rutaLog> <nombre>
 *
 * Imprime el nombre como primera línea de su propia salida porque `--title`
 * de `wt` no rotula el pane individual, solo la pestaña entera (ver
 * fanout-window.js). Tolera JSON corrupto o el log todavía inexistente
 * (el subagente puede no haber arrancado a escribir) sin tirar excepción —
 * un pane roto es peor que un pane mudo.
 */
'use strict';
const fs = require('node:fs');

const INTERVALO_MS = 300;
const MAX_LARGO_DELTA = 300;
const MAX_LARGO_CRUDO = 200;

function formatearHora(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

/**
 * Traduce una línea NDJSON cruda (el esquema de agy_stream.js:
 * init/step_update/result) a una línea legible para un pane angosto.
 * `null` significa "no hay nada que mostrar" (p. ej. el eco del prompt del
 * propio usuario, que step_type distingue de la respuesta del agente).
 */
function formatearLinea(cruda) {
  const hora = formatearHora();

  let ev;
  try {
    ev = JSON.parse(cruda);
  } catch {
    return `${hora} ？ ${cruda.slice(0, MAX_LARGO_CRUDO)}`;
  }

  switch (ev.event) {
    case 'init': {
      const cid = ev.conversation_id || (ev.init && ev.init.conversation_id);
      return `${hora} ▶ iniciado${cid ? ` (${String(cid).slice(0, 8)})` : ''}`;
    }

    case 'step_update': {
      const su = ev.step_update || {};
      if (su.step_type && su.step_type !== 'agent_response') return null;
      const delta = su.text_delta || su.delta || su.text;
      if (!delta || !String(delta).trim()) return null;
      return `${hora} · ${String(delta).replace(/\s+/g, ' ').trim().slice(0, MAX_LARGO_DELTA)}`;
    }

    case 'result': {
      const r = ev.result || {};
      const ok = r.status === 'SUCCESS' && !r.error;
      const marca = ok ? '✔' : '✘';
      const dur = typeof r.duration_seconds === 'number' ? ` ${r.duration_seconds.toFixed(1)}s` : '';
      return `${hora} ${marca} terminado${dur}${r.error ? ` — ${String(r.error).slice(0, MAX_LARGO_DELTA)}` : ''}`;
    }

    default:
      return `${hora} ？ evento: ${ev.event || '(sin campo event)'}`;
  }
}

/**
 * Lector incremental de un archivo que crece por apéndice — pensado para
 * probarse sin timers reales: `leerNuevas()` es una función pura de
 * "qué hay de nuevo desde la última vez", no un loop.
 */
function crearSeguidor(rutaLog) {
  let offset = 0;
  let restante = '';

  return {
    leerNuevas() {
      let stat;
      try {
        stat = fs.statSync(rutaLog);
      } catch {
        return []; // el log todavía no existe: el subagente no arrancó a escribir.
      }
      if (stat.size < offset) {
        // El archivo se achicó o es otro (p. ej. lo limpió una corrida nueva
        // con el mismo slug/taskId) — reempezar desde el principio.
        offset = 0;
        restante = '';
      }
      if (stat.size <= offset) return [];

      let fd;
      try {
        fd = fs.openSync(rutaLog, 'r');
      } catch {
        return [];
      }
      const buf = Buffer.alloc(stat.size - offset);
      let leidos = 0;
      try {
        leidos = fs.readSync(fd, buf, 0, buf.length, offset);
      } catch {
        leidos = 0;
      } finally {
        fs.closeSync(fd);
      }
      offset += leidos;

      const texto = restante + buf.slice(0, leidos).toString('utf8');
      const lineas = texto.split('\n');
      restante = lineas.pop() || '';
      return lineas.filter(l => l.trim());
    }
  };
}

function seguir(rutaLog, nombre, { intervaloMs = INTERVALO_MS, escribir = console.log } = {}) {
  escribir(`SUBAGENTE: ${nombre}`);
  escribir(`Log: ${rutaLog}`);
  escribir('—'.repeat(40));

  const seguidor = crearSeguidor(rutaLog);
  function tick() {
    for (const linea of seguidor.leerNuevas()) {
      const formateada = formatearLinea(linea);
      if (formateada !== null) escribir(formateada);
    }
  }
  tick();
  const timer = setInterval(tick, intervaloMs);
  timer.unref?.();
  return timer;
}

function main() {
  const [rutaLog, nombre] = process.argv.slice(2);
  if (!rutaLog || !nombre) {
    process.stderr.write('Uso: node fanout-tail.js <rutaLog> <nombre>\n');
    process.exitCode = 1;
    return;
  }
  seguir(rutaLog, nombre);
}

if (require.main === module) main();

module.exports = { formatearLinea, crearSeguidor, seguir };
