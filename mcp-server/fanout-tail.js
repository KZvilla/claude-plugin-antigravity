#!/usr/bin/env node
/**
 * `tail -f` formateado sobre el log NDJSON de UN subagente (FEAT-009,
 * mcp-server/fanout-estado.js `rutaProgreso`). No depende del servidor MCP:
 * se corre a mano, en la terminal que uno ya tenga abierta.
 *
 * Uso: node fanout-tail.js <rutaLog> <nombre>
 *
 * Para ver TODOS los subagentes a la vez, con estado y botón de detener,
 * está `fanout-watch.js` (`/lagrange:watch`), que reutiliza el
 * `formatearLinea` de este módulo para que las dos vistas digan lo mismo.
 *
 * Tolera JSON corrupto o el log todavía inexistente (el subagente puede no
 * haber arrancado a escribir) sin tirar excepción — una vista rota es peor
 * que una vista muda.
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
 * init/step_update/result) a una línea legible.
 * `null` significa "no hay nada que mostrar" (p. ej. el eco del prompt del
 * propio usuario, que step_type distingue de la respuesta del agente).
 *
 * `opciones.conHora: false` omite el reloj. Importa para quien REPRODUZCA
 * historial en vez de seguir el log en vivo (el visor de `/lagrange:watch`
 * al abrir una pestaña): los eventos de agy no traen timestamp propio, así
 * que la hora sale de `new Date()` en el momento de formatear. En un tail
 * en vivo eso es aproximadamente cierto; replicando historial es inventar
 * un dato — se veían veinte líneas viejas todas selladas con la hora en que
 * se abrió la página, contradiciendo su propio contenido.
 */
function formatearLinea(cruda, opciones = {}) {
  // Prefijo con la hora solo si corresponde; sin él, nada de espacios sueltos
  // al principio de la línea.
  const p = opciones.conHora === false ? '' : `${formatearHora()} `;

  let ev;
  try {
    ev = JSON.parse(cruda);
  } catch {
    return `${p}？ ${cruda.slice(0, MAX_LARGO_CRUDO)}`;
  }

  switch (ev.event) {
    case 'init': {
      const cid = ev.conversation_id || (ev.init && ev.init.conversation_id);
      return `${p}▶ iniciado${cid ? ` (${String(cid).slice(0, 8)})` : ''}`;
    }

    case 'step_update': {
      const su = ev.step_update || {};
      if (su.step_type && su.step_type !== 'agent_response') return null;
      const delta = su.text_delta || su.delta || su.text;
      if (!delta || !String(delta).trim()) return null;
      return `${p}· ${String(delta).replace(/\s+/g, ' ').trim().slice(0, MAX_LARGO_DELTA)}`;
    }

    case 'result': {
      const r = ev.result || {};
      const ok = r.status === 'SUCCESS' && !r.error;
      const marca = ok ? '✔' : '✘';
      const dur = typeof r.duration_seconds === 'number' ? ` ${r.duration_seconds.toFixed(1)}s` : '';
      return `${p}${marca} terminado${dur}${r.error ? ` — ${String(r.error).slice(0, MAX_LARGO_DELTA)}` : ''}`;
    }

    default:
      return `${p}？ evento: ${ev.event || '(sin campo event)'}`;
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
  // A propósito SIN `.unref()`: este proceso existe para seguir el log, así
  // que el intervalo es lo único que lo mantiene vivo. Con unref, Node se
  // quedaba sin nada pendiente después del primer tick y el proceso salía
  // de inmediato (exit 0). Reproducido en vivo el 2026-09-09 corriendo
  // `node fanout-tail.js` a mano: salía solo en vez de quedarse esperando.
  // Quien lo llame desde un test debe hacer `clearInterval` del timer que
  // se devuelve acá.
  const timer = setInterval(tick, intervaloMs);
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
