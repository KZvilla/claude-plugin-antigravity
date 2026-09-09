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
const MAX_LARGO_PARAM = 120;

function formatearHora(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

/**
 * Nombres de parámetro que valen como "el sujeto" de una llamada a
 * herramienta, en orden de preferencia.
 *
 * A propósito es una lista de CANDIDATOS y no un mapa herramienta →
 * parámetro: de las herramientas de `agy` solo se verificó en vivo la forma
 * de `write_to_file` (`TargetFile`), así que un mapa fijo sería inventar el
 * resto. Con candidatos, una herramienta desconocida degrada a mostrar solo
 * su nombre en vez de `🔧 run_command → undefined`.
 *
 * Se excluyen a propósito los parámetros que traen payload (`CodeContent`,
 * `TargetContent`, `ReplacementContent`): son de kilobytes y volcarlos en el
 * visor sería peor que no mostrar nada.
 */
const PARAMS_INTERESANTES = [
  'TargetFile', 'AbsolutePath', 'DirectoryPath', 'SearchPath', 'FilePath',
  'CommandLine', 'Command', 'Query', 'SearchTerm', 'Url', 'Pattern'
];

function resumirHerramienta(su) {
  const nombre = su.tool_name || (su.tool_info && su.tool_info.name) || 'herramienta';
  const params = (su.tool_info && su.tool_info.parameters) || {};

  let sujeto = null;
  for (const clave of PARAMS_INTERESANTES) {
    const v = params[clave];
    if (typeof v === 'string' && v.trim()) { sujeto = v.trim(); break; }
  }

  if (!sujeto) return nombre;
  const corto = sujeto.length > MAX_LARGO_PARAM
    ? `${sujeto.slice(0, MAX_LARGO_PARAM)}…`
    : sujeto;
  return `${nombre} → ${corto}`;
}

/**
 * Proyección PURA y sin estado de un evento NDJSON a algo mostrable.
 * Devuelve `null` cuando no hay nada que mostrar.
 *
 * Existe separada de `formatearLinea` porque el visor y la CLI necesitan
 * cosas distintas del mismo evento: la CLI quiere una línea ya armada; el
 * visor quiere los campos sueltos —sobre todo `stepIndex`— para poder unir
 * en el navegador los `text_delta` de un mismo paso.
 *
 * Lo que NO hace, deliberadamente: acumular. `agy` parte la prosa en
 * `text_delta` a mitad de palabra, y la tentación es juntarlos acá hasta que
 * el paso cierre con `state: "DONE"`. Una auditoría adversarial del plan
 * (2026-09-09) mostró por qué sería un error: si a un subagente lo matan
 * (FEAT-012), su paso en curso nunca recibe el `DONE` y todo lo acumulado se
 * perdería sin mostrarse jamás; y un paso largo dejaría la vista congelada
 * hasta terminar. Se emite todo, siempre, apenas llega; unir es trabajo de
 * quien pinta, que además ya tiene estado propio por tarea.
 *
 * @returns {{tipo: string, stepIndex: number|null, texto: string}|null}
 */
function interpretarEvento(cruda) {
  let ev;
  try {
    ev = JSON.parse(cruda);
  } catch {
    return { tipo: 'raro', stepIndex: null, texto: String(cruda).slice(0, MAX_LARGO_CRUDO) };
  }

  switch (ev.event) {
    case 'init': {
      const cid = ev.conversation_id || (ev.init && ev.init.conversation_id);
      return { tipo: 'inicio', stepIndex: null, texto: `iniciado${cid ? ` (${String(cid).slice(0, 8)})` : ''}` };
    }

    case 'step_update': {
      const su = ev.step_update || {};
      const stepIndex = typeof su.step_index === 'number' ? su.step_index : null;

      if (su.step_type === 'tool') {
        // Solo el ACTIVE: es cuando querés enterarte de que arrancó algo que
        // puede tardar. El DONE del mismo paso repetiría la misma línea.
        if (su.state && su.state !== 'ACTIVE') return null;
        return { tipo: 'tool', stepIndex, texto: resumirHerramienta(su) };
      }

      // Cualquier otro step_type que no sea la respuesta del agente (el eco
      // del prompt del usuario, por ejemplo) no aporta nada al visor.
      if (su.step_type && su.step_type !== 'agent_response') return null;

      const delta = su.text_delta || su.delta || su.text;
      // Un `agent_response` puede cerrar en DONE sin texto: es el paso de
      // "pensamiento", con usage y duración pero nada que leer.
      if (!delta) return null;
      return { tipo: 'prosa', stepIndex, texto: String(delta) };
    }

    case 'result': {
      const r = ev.result || {};
      const ok = r.status === 'SUCCESS' && !r.error;
      const dur = typeof r.duration_seconds === 'number' ? ` ${r.duration_seconds.toFixed(1)}s` : '';
      return {
        tipo: ok ? 'fin-ok' : 'fin-error',
        stepIndex: null,
        texto: `terminado${dur}${r.error ? ` — ${String(r.error).slice(0, MAX_LARGO_DELTA)}` : ''}`
      };
    }

    default:
      return { tipo: 'raro', stepIndex: null, texto: `evento: ${ev.event || '(sin campo event)'}` };
  }
}

const MARCA_POR_TIPO = {
  inicio: '▶',
  prosa: '·',
  tool: '🔧',
  'fin-ok': '✔',
  'fin-error': '✘',
  raro: '？'
};

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
  const e = interpretarEvento(cruda);
  if (e === null) return null;

  // La CLI es una terminal: una línea por evento, ya escrita, sin manera de
  // volver atrás a unirla con la siguiente. Así que acá sí se aplasta el
  // texto a una sola línea. El visor NO usa este camino — puede unir los
  // fragmentos en el DOM y conserva los saltos.
  if (e.tipo === 'prosa') {
    const plano = e.texto.replace(/\s+/g, ' ').trim();
    if (!plano) return null;
    e.texto = plano.slice(0, MAX_LARGO_DELTA);
  }

  // Prefijo con la hora solo si corresponde; sin él, nada de espacios sueltos
  // al principio de la línea.
  const p = opciones.conHora === false ? '' : `${formatearHora()} `;
  return `${p}${MARCA_POR_TIPO[e.tipo] || '？'} ${e.texto}`;
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

module.exports = { formatearLinea, interpretarEvento, crearSeguidor, seguir };
