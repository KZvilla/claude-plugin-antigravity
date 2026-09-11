#!/usr/bin/env node
/**
 * Visor local de un fan-out en curso (`/lagrange:watch`).
 *
 * Sirve una página en 127.0.0.1 que muestra, en vivo, todos los subagentes
 * del lote a la vez: su estado de orquestación (FEAT-008,
 * `.fanout-status-<slug>.json`) y el detalle de lo que va haciendo cada uno
 * (FEAT-009, `.agy-progress-<slug>-<taskId>.jsonl`), con un botón para
 * detener cualquiera (FEAT-012, escribe el centinela vía `marcarDetencion`).
 *
 * Uso: node fanout-watch.js [repoPath] [--port N] [--slug X]
 *
 * POR QUÉ ESTO Y NO UNA VENTANA DE TERMINAL PROPIA
 * ------------------------------------------------
 * El intento anterior (FEAT-010) abría una ventana de Windows Terminal con
 * un pane por subagente. Se abandonó tras encontrar, en una sola sesión,
 * cuatro fallos distintos: `spawn` sin listener de `'error'` tumbaba el
 * servidor MCP entero; encadenar dos `split-pane` en una invocación
 * crasheaba `TerminalApp.dll` (bug de Windows Terminal, no nuestro); `wt`
 * re-parsea el comando del pane y lo parte por espacios, así que la ruta
 * `C:\Program Files\nodejs\node.exe` fallaba en silencio; y no hay
 * aislamiento de proceso entre la ventana nueva y la que hospeda la propia
 * sesión de Claude Code, así que un crash se llevaba puesta la sesión.
 *
 * Un servidor local no necesita ventana: el navegador ya está abierto. Sin
 * dependencias (`node:http` + SSE, sin WebSocket ni build), sin nada
 * específico del sistema operativo, y con sitio de sobra para mostrar N
 * subagentes sin pelear por el ancho de una columna de terminal.
 *
 * SEGURIDAD (SEC-011): los logs traen prompts y código generado, así que el
 * servidor escucha SOLO en 127.0.0.1. Eso no alcanza: escuchar en loopback no
 * protege del navegador del propio usuario. Cualquier página abierta en otra
 * pestaña puede postear a 127.0.0.1 con una request simple que ni siquiera
 * dispara preflight CORS, y hasta esta versión eso bastaba para detenerle un
 * subagente a alguien desde un sitio cualquiera.
 *
 * Cuatro capas, y ninguna alcanza sola:
 *
 *   1. Token por sesión (24 bytes al azar) que viaja en la URL que se imprime
 *      en la terminal. Sin él no se sirve ni la página ni el stream.
 *   2. Las mutaciones exigen el token en la cabecera `x-lagrange-token`, no en
 *      la query: una cabecera propia obliga al navegador a pedir preflight
 *      antes de cruzar orígenes, y el preflight no se responde. Un `<form>`
 *      hostil no puede mandarla.
 *   3. `Origin` y `Sec-Fetch-Site` se validan en toda mutación.
 *   4. El `Host` tiene que ser loopback, contra DNS rebinding — un dominio que
 *      resuelve a 127.0.0.1 sería mismo-origen para el navegador.
 *
 * Esto importa más de lo que parece para el visor de hoy (lo peor era cortar
 * un fan-out) porque el tablero de agentes persistidos (`FEAT-023`) quiere
 * montar acá los decision gates: aprobar o rechazar lo que un agente escaló.
 * Un endpoint de aprobación sin autenticar no es una molestia, es que un sitio
 * cualquiera apruebe por vos.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { rutaEstado, rutaProgreso, marcarDetencion, DIR_WORKTREES } = require('./fanout-estado.js');
const { listarWorktrees } = require('./worktrees.js');
const tableroAgentes = require('./agents/tablero.js');
const memoriaAgentes = require('./agents/memoria.js');
const { interpretarEvento, crearSeguidor } = require('./fanout-tail.js');

const PUERTO_POR_DEFECTO = 4517;
const INTERVALO_SONDEO_MS = 500;

/**
 * Encuentra el lote más reciente mirando los archivos de estado que deja
 * FEAT-008. Mismo criterio que `fanout-statusline.js`: gana el de
 * `actualizado` más nuevo, para que abrir el visor sin argumentos muestre
 * "lo que está pasando ahora" sin tener que saberse el slug.
 */
function descubrirLotes(repoPath) {
  const dir = path.join(repoPath, DIR_WORKTREES);
  let nombres = [];
  try {
    nombres = fs.readdirSync(dir).filter(n => n.startsWith('.fanout-status-') && n.endsWith('.json'));
  } catch {
    return [];
  }

  const lotes = [];
  for (const nombre of nombres) {
    try {
      const datos = JSON.parse(fs.readFileSync(path.join(dir, nombre), 'utf8'));
      if (datos && datos.slug) lotes.push(datos);
    } catch {
      // Un archivo a medio escribir no invalida al resto.
    }
  }
  return lotes.sort((a, b) => String(b.actualizado || '').localeCompare(String(a.actualizado || '')));
}

function leerEstado(repoPath, slug) {
  try {
    return JSON.parse(fs.readFileSync(rutaEstado(repoPath, slug), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Momento de la última señal de vida del lote, en ms.
 *
 * Por qué NO alcanza con `datos.actualizado` (FEAT-016): ese campo solo se
 * bumpea dentro de `marcar()`/`terminar()`, y una tarea que corre diez
 * minutos genera UN solo `marcar` — el de "corriendo", al despacharla. O sea
 * que `actualizado` queda congelado durante toda la corrida de un subagente
 * perfectamente sano. Un "¿hace cuánto que no pasa nada?" basado solo en eso
 * daría falso positivo en el caso más normal que existe.
 *
 * El log de progreso (FEAT-009) sí crece mientras el subagente escupe
 * deltas, así que la señal real es el más reciente de los dos. Se saca del
 * disco y no del ciclo de vida de la conexión: así sobrevive a un F5 y no se
 * resetea al reconectar, que es cuando un lote muerto podría disfrazarse de
 * recién llegado.
 */
function ultimaSenal(repoPath, slug, taskIds) {
  let masReciente = 0;
  const mirar = (ruta) => {
    try {
      const t = fs.statSync(ruta).mtimeMs;
      if (t > masReciente) masReciente = t;
    } catch {
      // Que falte un archivo no es un error: la tarea puede no haber escrito
      // todavía.
    }
  };

  mirar(rutaEstado(repoPath, slug));
  for (const taskId of taskIds) mirar(rutaProgreso(repoPath, slug, taskId));
  return masReciente;
}

/**
 * Mantiene un seguidor por tarea y devuelve solo lo nuevo desde la última
 * vez. Se apoya en `crearSeguidor` de fanout-tail.js —el mismo lector
 * incremental por offset, ya probado— en vez de releer el archivo entero
 * en cada tick.
 */
function crearVigilante(repoPath, slug) {
  const seguidores = new Map();

  return {
    /**
     * Devuelve los eventos nuevos ya interpretados, pero SIN unir: cada
     * `text_delta` sale tal cual llegó, con su `stepIndex`. Unir los
     * fragmentos de un mismo paso es trabajo del navegador (ver `pintarEvento`
     * en la página) — hacerlo acá significaría retener texto hasta que el paso
     * cierre con `DONE`, y un subagente al que matan (FEAT-012) nunca emite
     * ese `DONE`: lo retenido se perdería sin mostrarse nunca, y un paso largo
     * dejaría la tarjeta congelada mientras tanto.
     *
     * `conHora: false` para la reproducción del historial al conectar: los
     * eventos de agy no traen timestamp, así que ponerle la hora actual a una
     * línea vieja es inventar el dato. Los eventos que llegan en vivo sí la
     * llevan.
     */
    nuevosEventos(taskIds, { conHora = true } = {}) {
      const salida = [];
      for (const taskId of taskIds) {
        if (!seguidores.has(taskId)) {
          seguidores.set(taskId, crearSeguidor(rutaProgreso(repoPath, slug, taskId)));
        }
        for (const cruda of seguidores.get(taskId).leerNuevas()) {
          const e = interpretarEvento(cruda);
          if (e === null) continue;
          salida.push({
            taskId,
            tipo: e.tipo,
            stepIndex: e.stepIndex,
            texto: e.texto,
            hora: conHora ? new Date().toTimeString().slice(0, 8) : null
          });
        }
      }
      return salida;
    }
  };
}

function paginaHtml(slug, token) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>fanout · ${escapar(slug)}</title>
<style>
  :root { color-scheme: dark light; }
  html, body { height: 100%; }
  body { margin: 0; font: 13px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
         background: #11131a; color: #d7dae0; display: flex; flex-direction: column; }
  header { padding: 10px 16px; border-bottom: 1px solid #2a2f3a; display: flex;
           align-items: baseline; gap: 12px; background: #11131a; flex: none; }
  h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .meta { color: #7d8596; font-size: 12px; }
  /* Las tarjetas estiran para ocupar el alto disponible: con pocas tareas la
     ventana se llenaba de vacío y el log quedaba en una franja de 220px. */
  /* min(100%, 360px): en una ventana de menos de 360px la tarjeta se achica en
     vez de desbordar la grilla (FEAT-032). */
  #grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
          grid-auto-rows: minmax(260px, 1fr); gap: 12px; padding: 12px;
          flex: 1; min-height: 0; overflow-y: auto; }
  .tarea { border: 1px solid #2a2f3a; border-radius: 6px; display: flex; flex-direction: column;
           min-height: 0; background: #161922; }
  .cab { padding: 8px 10px; border-bottom: 1px solid #2a2f3a; display: flex; align-items: center; gap: 8px; }
  .nombre { font-weight: 600; }
  .estado { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
  .pendiente { color: #7d8596; } .corriendo { color: #58a6ff; }
  .reintentando { color: #d29922; } .ok { color: #3fb950; }
  .error { color: #f85149; } .detenida { color: #db6d28; }
  .meta.fin { color: #3fb950; }
  .meta.quieto { color: #d29922; }
  .tiempo { font-size: 11px; color: #7d8596; font-variant-numeric: tabular-nums; }
  .tiempo.vivo { color: #58a6ff; }
  /* Scopeado a .tarea: la cabecera de la página ya usa .meta para su resumen
     y sin esto heredaba padding y borde de la fila de la tarjeta. */
  .tarea .meta { padding: 4px 10px; font-size: 11px; color: #7d8596; border-bottom: 1px solid #2a2f3a;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tarea .meta:empty { display: none; }
  .porque { padding: 5px 10px; font-size: 12px; color: #f0a58a; background: #241a1a;
            border-bottom: 1px solid #2a2f3a; white-space: pre-wrap; word-break: break-word; }
  .acciones { margin-left: auto; display: flex; gap: 6px; }
  .stop, .dif { background: none; border: 1px solid #3d4350; color: #d7dae0;
          border-radius: 4px; padding: 2px 9px; cursor: pointer; font: inherit; font-size: 11px; }
  .stop:hover:not(:disabled) { border-color: #f85149; color: #f85149; }
  .dif:hover:not(:disabled) { border-color: #58a6ff; color: #58a6ff; }
  .stop:disabled, .dif:disabled { opacity: .35; cursor: default; }
  .stop:focus-visible, .dif:focus-visible, .diff:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
  /* FEAT-033: el diff ocupa el lugar del log, que se oculta pero sigue en el
     DOM (pintarEvento lo necesita en cada evento). */
  .diff { margin: 0; overflow: auto; padding: 8px 10px; white-space: pre; flex: 1; font: inherit; font-size: 12px; }
  .d-mas { color: #3fb950; } .d-menos { color: #f85149; } .d-hunk { color: #58a6ff; } .dh { color: #7d8596; }
  /* Visualmente oculto pero leído por lectores de pantalla. */
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
             overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .log { overflow-y: auto; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; flex: 1; }
  .linea { padding: 1px 0; border-bottom: 1px solid #1c2029; }
  .hora { color: #7d8596; }
  .marca { color: #7d8596; }
  /* La llamada a herramienta es lo que dice qué está HACIENDO el subagente:
     tiene que saltar por encima de la prosa, no perderse dentro de ella. */
  .linea.tool { background: #1a2030; border-left: 2px solid #58a6ff; padding-left: 6px; }
  .linea.tool .marca, .linea.tool .txt { color: #9cc7ff; }
  .linea.inicio .txt { color: #7d8596; }
  .linea .fin-ok, .linea.fin-ok .txt { color: #3fb950; }
  .linea.fin-error .txt { color: #f85149; }
  .linea.raro .txt { color: #d29922; }
  #vacio { padding: 40px 16px; color: #7d8596; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>fanout · ${escapar(slug)}</h1>
  <span class="meta" id="resumen">conectando…</span>
  <!-- #resumen se reescribe cada segundo (el reloj de "sin novedad"): con
       aria-live el lector de pantalla no pararía de hablar. Este span solo
       cambia cuando cambian los conteos o termina el lote (FEAT-032). -->
  <span class="sr-only" aria-live="polite" id="anuncio"></span>
</header>
<div id="grid"></div>
<div id="vacio" hidden>Sin tareas todavía.</div>
<script>
// Inyectado por el servidor. Es de esta sesión del visor: se muere con el
// proceso y no sirve para el próximo.
const TOKEN = ${JSON.stringify(token || '')};
const grid = document.getElementById('grid');
const resumen = document.getElementById('resumen');
const tarjetas = new Map();

function tarjeta(taskId) {
  if (tarjetas.has(taskId)) return tarjetas.get(taskId);
  const el = document.createElement('div');
  el.className = 'tarea';
  el.innerHTML = '<div class="cab"><span class="nombre"></span>' +
    '<span class="estado"></span><span class="tiempo"></span>' +
    '<span class="acciones"><button class="dif" disabled aria-pressed="false">Diff</button>' +
    '<button class="stop">Detener</button></span></div>' +
    '<div class="meta"></div><div class="porque"></div><div class="log"></div>' +
    '<pre class="diff" tabindex="0" hidden></pre>';
  el.querySelector('.nombre').textContent = taskId;
  // FEAT-033 — Lo que dejó el subagente en su worktree. Alterna con el log:
  // el log se oculta, nunca se quita (pintarEvento lo busca en cada evento).
  el.querySelector('.dif').addEventListener('click', async (ev) => {
    const boton = ev.currentTarget;
    const log = el.querySelector('.log');
    const pre = el.querySelector('.diff');
    if (boton.getAttribute('aria-pressed') === 'true') {
      pre.hidden = true;
      log.hidden = false;
      // Mientras estuvo oculto, asignar el scroll no hacía nada.
      log.scrollTop = log.scrollHeight;
      boton.setAttribute('aria-pressed', 'false');
      boton.textContent = 'Diff';
      return;
    }
    boton.disabled = true;
    boton.textContent = 'Cargando…';
    let r;
    try {
      const resp = await fetch('/api/diff?t=' + encodeURIComponent(TOKEN) + '&taskId=' + encodeURIComponent(taskId));
      r = await resp.json();
    } catch { r = { ok: false, motivo: 'no se pudo pedir el diff' }; }
    pintarDiff(pre, r);
    log.hidden = true;
    pre.hidden = false;
    boton.disabled = false;
    boton.setAttribute('aria-pressed', 'true');
    boton.textContent = 'Log';
  });
  el.querySelector('.stop').addEventListener('click', async (ev) => {
    const boton = ev.currentTarget;
    boton.disabled = true;
    boton.textContent = 'Deteniendo…';
    try {
      // El token va por cabecera propia y no en la query a propósito: una
      // cabecera no estándar obliga al navegador a hacer preflight antes de
      // cruzar orígenes, y el servidor no responde preflights. Un formulario
      // hostil en otra pestaña no tiene forma de mandarla.
      const r = await fetch('/api/detener?t=' + encodeURIComponent(TOKEN), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lagrange-token': TOKEN },
        body: JSON.stringify({ taskId })
      });
      // El pedido queda escrito, pero al subagente lo mata el orquestador en
      // su próximo sondeo (unos segundos). Decir "Deteniendo…" para siempre
      // haría pensar que se colgó: esto avisa que el pedido salió, y el
      // badge de estado cambia solo cuando la muerte se hace efectiva.
      boton.textContent = r.ok ? 'Detención pedida' : 'Falló';
    } catch { boton.textContent = 'Falló'; }
  });
  grid.appendChild(el);
  tarjetas.set(taskId, el);
  return el;
}

// Último estado conocido por tarea. Lo necesita el reloj: el servidor manda
// el evento estado SOLO cuando el JSON cambia, así que una tarea que corre diez
// minutos no genera un solo evento — si el tiempo dependiera de eso, quedaría
// congelado. El ticking es del cliente y se calcula contra inicio.
const ultimoEstado = new Map();

function duracion(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)); // clamp: el inicio lo escribe
  const m = Math.floor(s / 60);                 // otro proceso, con su reloj.
  return m > 0 ? m + 'm' + String(s % 60).padStart(2, '0') + 's' : s + 's';
}

function refrescarTiempos() {
  for (const [id, t] of ultimoEstado) {
    const el = tarjetas.get(id);
    if (!el) continue;
    const campo = el.querySelector('.tiempo');
    if (!t.inicio) { campo.textContent = ''; continue; }
    const desde = new Date(t.inicio).getTime();
    const hasta = t.fin ? new Date(t.fin).getTime() : Date.now();
    campo.textContent = duracion(hasta - desde);
    campo.className = 'tiempo' + (t.fin ? '' : ' vivo');
  }
}
// Un solo interval global para toda la página, no uno por tarjeta: attachear
// timers en cada pintarEstado los iria acumulando.
setInterval(() => { refrescarTiempos(); refrescarCabecera(); }, 1000);

function explicarFallo(t) {
  if (t.detenido) return t.motivo ? 'detenida: ' + t.motivo : 'detenida a pedido';
  if (t.porCuota) return 'sin cuota' + (t.error ? ': ' + t.error : '');
  if (t.estado === 'error') return t.error || 'error sin detalle';
  return '';
}

// Último texto anunciado al lector de pantalla (FEAT-032). Declarado antes de
// pintarEstado, que lo usa: con un let más abajo, una llamada síncrona
// anterior daría ReferenceError.
let ultimoAnuncio = '';

function pintarEstado(datos) {
  const tareas = datos.tareas || {};
  const ids = Object.keys(tareas);
  document.getElementById('vacio').hidden = ids.length > 0;

  let ok = 0, err = 0, corriendo = 0;
  for (const id of ids) {
    const t = tareas[id];
    ultimoEstado.set(id, t);
    const el = tarjeta(id);
    const estado = t.detenido ? 'detenida' : (t.estado || 'pendiente');
    const badge = el.querySelector('.estado');
    badge.textContent = estado + (t.intentos > 1 ? ' ×' + t.intentos : '');
    badge.className = 'estado ' + estado;
    // Detener solo tiene sentido mientras siga en vuelo.
    el.querySelector('.stop').disabled = !(estado === 'corriendo' || estado === 'reintentando');
    // El diff, solo con la tarea quieta: mientras corre, el worktree cambia.
    const dif = el.querySelector('.dif');
    if (dif.textContent !== 'Cargando…') {
      dif.disabled = !(estado === 'ok' || estado === 'error' || estado === 'detenida');
    }

    const meta = [];
    if (t.modelo) meta.push(t.modelo);
    else if ('modelo' in t) meta.push('modelo por defecto');
    if (t.rama) meta.push(t.rama);
    if (Array.isArray(t.archivos) && t.archivos.length) meta.push(t.archivos.join(' '));
    const elMeta = el.querySelector('.meta');
    elMeta.textContent = meta.join('  ·  ');
    // La fila se recorta con ellipsis para no comerse la tarjeta; el title
    // deja leer la lista de archivos entera al pasar el mouse, que si no
    // quedaría truncada sin manera de verla.
    // Doble escape a propósito: esto vive dentro del template literal que
    // arma la página, así que una secuencia de escape simple la consumiría el
    // literal de AFUERA y emitiría un salto de línea real en medio del string
    // del cliente — error de sintaxis en el navegador que ningún test de
    // servidor ve. (Este comentario también evita escribirla, por lo mismo.)
    elMeta.title = meta.join('\\n');

    const porque = explicarFallo(t);
    const elPorque = el.querySelector('.porque');
    elPorque.textContent = porque;
    elPorque.hidden = !porque;

    if (t.estado === 'ok') ok++;
    else if (t.estado === 'error') err++;
    else if (t.estado === 'corriendo' || t.estado === 'reintentando') corriendo++;
  }
  refrescarTiempos();

  loteTerminado = datos.terminado || null;
  loteIniciado = datos.iniciado || null;
  // Punto de partida que sale del disco; los eventos que lleguen después la
  // adelantan (ver marcarActividad).
  if (typeof datos.ultimaSenal === 'number' && datos.ultimaSenal > ultimaActividad) {
    ultimaActividad = datos.ultimaSenal;
  }

  const partes = [ids.length + ' tareas', ok + ' ok', err + ' error'];
  if (!loteTerminado) partes.push(corriendo + ' en vuelo');
  resumenBase = partes.join(' · ');
  refrescarCabecera();

  // Lo que se anuncia al lector de pantalla: solo los conteos y el fin del
  // lote, nunca el reloj que corre cada segundo.
  const anuncio = resumenBase + (loteTerminado ? ' · terminado' : '');
  if (anuncio !== ultimoAnuncio) {
    ultimoAnuncio = anuncio;
    document.getElementById('anuncio').textContent = anuncio;
  }
}

// Estado del lote que necesita la cabecera entre repintados.
let loteTerminado = null;
let loteIniciado = null;
let resumenBase = '';
let ultimaActividad = 0;

// Cualquier evento que llegue es señal de vida: adelanta el reloj de
// "sin novedad" sin que el servidor tenga que mandar pulsos.
function marcarActividad() { ultimaActividad = Date.now(); }

// Cuánto silencio hace falta para decirlo. Un subagente que piensa un rato
// largo es normal; varios minutos sin una sola línea ni cambio de estado ya
// merece que la persona lo sepa — sin declararlo muerto, porque desde acá no
// se puede saber si el proceso sigue vivo.
const SILENCIO_AVISO_MS = 2 * 60 * 1000;

function refrescarCabecera() {
  if (!resumenBase) return;
  let extra = '';
  if (loteTerminado) {
    const total = loteIniciado
      ? ' en ' + duracion(new Date(loteTerminado).getTime() - new Date(loteIniciado).getTime())
      : '';
    extra = ' · terminado' + total;
  } else if (ultimaActividad) {
    const quieto = Date.now() - ultimaActividad;
    // No se afirma que esté muerto: se dice desde cuándo no hay señales y
    // que juzgue quien mira. El visor no puede saber si el proceso vive.
    if (quieto > SILENCIO_AVISO_MS) extra = ' · sin novedad hace ' + duracion(quieto);
  }
  resumen.textContent = resumenBase + extra;
  resumen.className = 'meta' + (loteTerminado ? ' fin' : (extra ? ' quieto' : ''));
}

// FEAT-033 — Todo con textContent: el diff es contenido del worktree y jamás
// pasa por innerHTML. Una línea, un span, con su color por el primer carácter.
function pintarDiff(pre, r) {
  pre.textContent = '';
  const agregar = (texto, clase) => {
    const s = document.createElement('span');
    if (clase) s.className = clase;
    s.textContent = texto + '\\n';
    pre.appendChild(s);
  };
  if (!r || !r.ok) { agregar((r && r.motivo) || 'sin diff', 'dh'); return; }
  if (r.aviso) agregar(r.aviso, 'dh');
  if (r.status) {
    agregar('$ git status', 'dh');
    r.status.split('\\n').forEach((l) => agregar(l));
  }
  (r.ocultos || []).forEach((f) => agregar('# ' + f + ': oculto por deny_paths', 'dh'));
  if (r.diff) {
    r.diff.split('\\n').forEach((l) => agregar(l,
      l.startsWith('@@') ? 'd-hunk' : (l.startsWith('+') ? 'd-mas' : (l.startsWith('-') ? 'd-menos' : ''))));
  } else if (!r.aviso) {
    agregar('(sin cambios contra la base)', 'dh');
  }
  if (r.truncado) agregar('… diff truncado', 'dh');
}

const MARCA = { inicio: '▶', prosa: '·', tool: '🔧', 'fin-ok': '✔', 'fin-error': '✘', raro: '？' };
const MAX_LINEAS = 400;

// Acá es donde se unen los fragmentos. agy parte la prosa en text_delta a
// mitad de palabra ("...en e" / "l artefacto..."), así que un div por evento
// rendía una frase partida en siete líneas rotas. Los deltas de un mismo
// paso comparten stepIndex: si el último bloque de la tarjeta es del mismo
// paso, el texto se APPENDEA ahí en vez de abrir uno nuevo, y la frase se
// escribe sola como un párrafo.
//
// Se hace en el cliente y no en el servidor a propósito: así no hay que
// retener nada esperando el DONE de un paso que quizás nunca llegue (a un
// subagente lo pueden matar a mitad), y lo que ya llegó queda a la vista.
function pintarEvento(ev) {
  const el = tarjeta(ev.taskId).querySelector('.log');
  const pegadoAbajo = el.scrollHeight - el.scrollTop - el.clientHeight < 30;

  const ultimo = el.lastElementChild;
  const continua = ev.tipo === 'prosa' &&
    ultimo &&
    ultimo.dataset.tipo === 'prosa' &&
    ultimo.dataset.step === String(ev.stepIndex);

  if (continua) {
    ultimo.querySelector('.txt').textContent += ev.texto;
  } else {
    const linea = document.createElement('div');
    linea.className = 'linea ' + ev.tipo;
    linea.dataset.tipo = ev.tipo;
    linea.dataset.step = String(ev.stepIndex);
    if (ev.hora) {
      const h = document.createElement('span');
      h.className = 'hora';
      h.textContent = ev.hora + ' ';
      linea.appendChild(h);
    }
    const m = document.createElement('span');
    m.className = 'marca';
    m.textContent = (MARCA[ev.tipo] || '？') + ' ';
    linea.appendChild(m);
    const t = document.createElement('span');
    t.className = 'txt';
    t.textContent = ev.texto;
    linea.appendChild(t);
    el.appendChild(linea);

    // Tope simple: una corrida larga no debe dejar la pestaña con decenas de
    // miles de nodos. Se tira el más viejo, no hay retención sofisticada.
    while (el.childElementCount > MAX_LINEAS) el.firstElementChild.remove();
  }

  if (pegadoAbajo) el.scrollTop = el.scrollHeight;
}

const fuente = new EventSource('/api/eventos?t=' + encodeURIComponent(TOKEN));
// Ojo con qué cuenta como "actividad". La ráfaga inicial al conectar es
// HISTORIAL, no vida: si contara, abrir la pestaña sobre un lote abandonado
// hace media hora lo mostraría como recién activo — que es justo la mentira
// que FEAT-016 viene a sacar. El estado no bumpea nada: trae ultimaSenal
// sacada del mtime en disco, que es la verdad. Y de los eventos de log solo
// cuentan los que llegan en vivo, que son los que traen hora (el replay
// viene con hora en null, ver crearVigilante).
fuente.addEventListener('estado', e => pintarEstado(JSON.parse(e.data)));
fuente.addEventListener('evento', e => {
  const ev = JSON.parse(e.data);
  if (ev.hora) marcarActividad();
  pintarEvento(ev);
});
fuente.onerror = () => { resumen.textContent = 'desconectado (¿se cerró el visor?)'; };
</script>
</body>
</html>`;
}

/**
 * FEAT-023 — La vista de agentes persistidos.
 *
 * Pagina aparte y no una SPA con la de fan-out: son dos cosas distintas que
 * comparten servidor y token, no una sola vista con pestañas internas.
 * Convertir la de fan-out en SPA habria significado reescribirle el cliente
 * SSE para nada.
 */
function paginaAgentes(token, haySlug) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>agentes persistidos</title>
<style>
  :root { color-scheme: dark light; }
  html, body { height: 100%; }
  body { margin: 0; font: 13px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
         background: #11131a; color: #d7dae0; display: flex; flex-direction: column; }
  header { padding: 10px 16px; border-bottom: 1px solid #2a2f3a; display: flex;
           align-items: baseline; gap: 12px; background: #11131a; flex: none; }
  h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .meta { color: #7d8596; font-size: 12px; }
  nav { margin-left: auto; display: flex; gap: 4px; }
  nav a { color: #7d8596; text-decoration: none; font-size: 12px; padding: 2px 10px;
          border: 1px solid #2a2f3a; border-radius: 999px; }
  nav a.activa { color: #58a6ff; border-color: #58a6ff; }
  nav a:hover { color: #d7dae0; }
  main { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; }
  .aviso { border: 1px solid #d29922; color: #d29922; background: #221d10;
           padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #1c2029; vertical-align: top; }
  th { color: #7d8596; font-weight: 600; font-size: 11px; text-transform: uppercase;
       letter-spacing: .04em; border-bottom-color: #2a2f3a; }
  tr.fila { cursor: pointer; }
  /* FEAT-032: el botón es lo que da foco, Enter y Espacio a la fila. */
  .expandir { background: none; border: 0; padding: 0; color: inherit; font: inherit;
              cursor: pointer; text-align: left; }
  .expandir:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
  .tabla-scroll { overflow-x: auto; }
  tr.fila:hover td { background: #161922; }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
  .si { color: #3fb950; } .no { color: #f85149; } .tibio { color: #d29922; }
  .apagado { color: #7d8596; }
  .hilo { font-size: 11px; color: #7d8596; }
  .criterio { background: #0d0f15; }
  .criterio td { padding: 0 10px 12px; }
  .entrada { border-left: 2px solid #2a2f3a; padding: 4px 0 4px 10px; margin-top: 8px; }
  .entrada .cuerpo { white-space: pre-wrap; word-break: break-word; }
  .entrada .pie { font-size: 11px; color: #7d8596; margin-top: 2px; }
  .usos { color: #58a6ff; }
  .frio { color: #7d8596; }
  .vacio { color: #7d8596; font-style: italic; padding: 8px 0; }
</style>
</head>
<body>
<header>
  <h1>agentes persistidos</h1>
  <span class="meta" id="resumen" aria-live="polite">cargando…</span>
  <nav>
    ${haySlug ? `<a href="/?t=${token || ''}">fan-out</a>` : ''}
    <a class="activa" href="#">agentes</a>
  </nav>
</header>
<main>
  <div id="avisos"></div>
  <div class="tabla-scroll">
  <table>
    <thead><tr>
      <th>agente</th><th>skill</th><th>acceso</th><th>resuelve</th>
      <th>hilo</th><th>casts</th><th>último cast</th>
    </tr></thead>
    <tbody id="cuerpo"></tbody>
  </table>
  </div>
</main>
<script>
const TOKEN = ${JSON.stringify(token || '')};
const resumen = document.getElementById('resumen');
const avisos = document.getElementById('avisos');
const cuerpo = document.getElementById('cuerpo');
const abiertos = new Set();

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString();
}

function pedir(ruta) {
  return fetch(ruta + (ruta.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(TOKEN))
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
}

function pintarAvisos(datos) {
  const lista = [];
  if (!datos.agyDisponible) {
    lista.push('No se pudo consultar <code>agy agents</code>, así que la columna '
      + '"resuelve" no significa nada en esta carga: ' + esc(datos.motivoAgy || ''));
  }
  if (datos.registroIlegible) lista.push('El registro de agentes está ilegible en disco.');
  if (datos.estadoIlegible) lista.push('El estado de hilos está ilegible en disco.');
  const rotos = (datos.agentes || []).filter(a => datos.agyDisponible && a.enRegistro && !a.resuelve);
  if (rotos.length) {
    lista.push('Antigravity no resuelve ' + rotos.map(a => '<code>' + esc(a.nombre) + '</code>').join(', ')
      + '. Castearlos se aborta a propósito: <code>--agent</code> con un nombre inexistente '
      + 'cae en silencio al agente por defecto, con escritura completa.');
  }
  avisos.innerHTML = lista.map(t => '<div class="aviso">' + t + '</div>').join('');
}

function pintarCriterio(celda, agente) {
  celda.innerHTML = '<div class="vacio">buscando criterio acumulado…</div>';
  pedir('/api/agentes/criterio?agente=' + encodeURIComponent(agente)).then(r => {
    if (!r.ok) {
      celda.innerHTML = '<div class="vacio">sin criterio disponible (' + esc(r.motivo) + ')</div>';
      return;
    }
    if (!r.entradas.length) {
      celda.innerHTML = '<div class="vacio">todavía no acumuló criterio. '
        + 'Se llena solo cuando el agente emite su bloque de memoria al terminar un cast.</div>';
      return;
    }
    celda.innerHTML = r.entradas.map(e =>
      '<div class="entrada"><div class="cuerpo">' + esc(e.contenido) + '</div>'
      + '<div class="pie">' + esc(e.tipo) + ' · ' + esc(fecha(e.creado))
      // access_count es lo que separa el criterio que se usa del que quedó
      // ocupando lugar en el budget de rehidratación.
      + ' · <span class="' + (e.usos > 0 ? 'usos' : 'frio') + '">'
      + (e.usos > 0 ? ('usado ' + e.usos + '×') : 'nunca usado') + '</span></div></div>'
    ).join('') + (r.truncado ? '<div class="vacio">(lista truncada)</div>' : '');
  }).catch(err => {
    celda.innerHTML = '<div class="vacio">error: ' + esc(err.message) + '</div>';
  });
}

function alternar(nombre, fila) {
  const siguiente = fila.nextElementSibling;
  const boton = fila.querySelector('button.expandir');
  if (abiertos.has(nombre)) {
    abiertos.delete(nombre);
    siguiente.hidden = true;
    if (boton) boton.setAttribute('aria-expanded', 'false');
    return;
  }
  abiertos.add(nombre);
  siguiente.hidden = false;
  if (boton) boton.setAttribute('aria-expanded', 'true');
  pintarCriterio(siguiente.querySelector('td'), nombre);
}

function pintar(datos) {
  pintarAvisos(datos);
  const agentes = datos.agentes || [];
  resumen.textContent = agentes.length
    ? agentes.length + ' agente(s) · clic en una fila para ver su criterio acumulado'
    : 'ningún agente registrado todavía';

  cuerpo.innerHTML = '';
  for (const [i, a] of agentes.entries()) {
    const fila = document.createElement('tr');
    fila.className = 'fila';
    const acceso = a.readOnly === null
      ? '<span class="pill apagado">huérfano</span>'
      : (a.readOnly ? '<span class="pill si">read-only</span>' : '<span class="pill tibio">read/write</span>');
    const resuelve = !datos.agyDisponible
      ? '<span class="apagado">?</span>'
      : (a.resuelve ? '<span class="si">sí</span>' : '<span class="no">no</span>');
    // El botón da a la fila foco, Enter y Espacio (FEAT-032).
    fila.innerHTML = '<td><button type="button" class="expandir" aria-expanded="false" aria-controls="det-' + i + '">'
      + '<strong>' + esc(a.nombre) + '</strong></button></td>'
      + '<td class="apagado">' + esc(a.skill || '—') + '</td>'
      + '<td>' + acceso + '</td>'
      + '<td>' + resuelve + '</td>'
      + '<td class="hilo">' + (a.conversationId ? esc(a.conversationId.slice(0, 8)) + '…' : '—') + '</td>'
      + '<td>' + a.casts + '</td>'
      + '<td class="apagado">' + esc(fecha(a.ultimoCast)) + '</td>';
    cuerpo.appendChild(fila);

    const detalle = document.createElement('tr');
    detalle.className = 'criterio';
    detalle.id = 'det-' + i;
    detalle.hidden = true;
    detalle.innerHTML = '<td colspan="7"></td>';
    cuerpo.appendChild(detalle);

    // Un solo camino por click: el del botón. La fila atiende el resto de su
    // superficie, pero ignora lo que viene del botón; si no, el mismo click
    // burbujearía y abriría y cerraría a la vez.
    fila.querySelector('button.expandir').addEventListener('click', () => alternar(a.nombre, fila));
    fila.addEventListener('click', (ev) => {
      if (ev.target.closest('button.expandir')) return;
      alternar(a.nombre, fila);
    });
  }
}

pedir('/api/agentes').then(pintar).catch(err => {
  resumen.textContent = 'no se pudo cargar: ' + err.message;
});
</script>
</body>
</html>`;
}

function escapar(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * SEC-011 — Comparación en tiempo constante. Un `===` sobre el token filtra,
 * por cuánto tarda en fallar, cuántos caracteres acertó quien prueba.
 */
function tokenCoincide(esperado, recibido) {
  if (typeof recibido !== 'string' || recibido.length !== esperado.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(recibido), Buffer.from(esperado));
  } catch {
    return false;
  }
}

/**
 * Anti DNS rebinding: escuchar en 127.0.0.1 no impide que un dominio del
 * atacante resuelva a 127.0.0.1 y que el navegador trate a esa página como
 * mismo-origen nuestro. Lo que delata el intento es el `Host`.
 */
function hostEsLoopback(req) {
  const host = String(req.headers.host || '');
  const soloHost = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return soloHost === '127.0.0.1' || soloHost === 'localhost' || soloHost === '::1';
}

/**
 * Para las mutaciones. `Sec-Fetch-Site` lo pone el navegador y no se puede
 * falsear desde JavaScript; `Origin` cubre a los clientes que no lo mandan.
 * Un cliente sin navegador (curl, un test) no manda ninguno de los dos: eso
 * se acepta, porque ahí el token es toda la autenticación que hay y no existe
 * el problema de la petición cruzada involuntaria.
 */
function origenAceptable(req) {
  const sitio = req.headers['sec-fetch-site'];
  if (sitio && sitio !== 'same-origin' && sitio !== 'none') return false;

  const origen = req.headers.origin;
  if (!origen) return true;
  try {
    const host = new URL(origen).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * El visor no resuelve el binario de agy como lo hace el servidor MCP: acá
 * alcanza con el nombre, porque solo se usa para `agy agents` y un fallo se
 * refleja en la página como "no se pudo consultar" en vez de tumbar nada.
 */
// ==============================================================================
// FEAT-033 — Diff del worktree de una tarea
// ==============================================================================

// Del cliente solo llega el `taskId`, y se busca entre las tareas del estado.
// La rama y la base salen del archivo de estado; como un subagente con
// escritura podría tocarlo, se validan con la forma exacta que produce el
// orquestador.
const RAMA_VALIDA = /^wt\/[A-Za-z0-9._-]+$/;
const BASE_VALIDA = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const DIFF_TOPE_BYTES = 200 * 1024;
const DIFF_MAX_ARCHIVOS = 200;
// Límite de argv de CreateProcessW: 32 767 caracteres en total. La mitad para
// las rutas deja margen de sobra para git.exe y sus flags.
const DIFF_MAX_CARACTERES_ARGS = 16000;

/**
 * `-c core.quotePath=false` y `--literal-pathspecs` en toda llamada: los nombres
 * vuelven sin escapar y ningún nombre de archivo se interpreta como magia.
 */
function gitWt(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', '-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/**
 * La política de `deny_paths` del bridge (ESM). Con `pathToFileURL`: en
 * Windows, `import()` de una ruta absoluta falla con «Received protocol 'c:'».
 */
function cargarPolitica() {
  return import(pathToFileURL(path.join(__dirname, '..', 'telegram-bridge', 'policy.js')).href);
}

/**
 * @returns {Promise<{ codigo: number, cuerpo: object }>}
 */
async function diffDeTarea(repoPath, slug, taskId, { cargarPoliticaFn = cargarPolitica } = {}) {
  const estado = slug ? leerEstado(repoPath, slug) : null;
  const tareas = (estado && estado.tareas) || {};
  if (!taskId || !Object.prototype.hasOwnProperty.call(tareas, taskId)) {
    return { codigo: 404, cuerpo: { ok: false, motivo: 'tarea desconocida' } };
  }
  const rama = tareas[taskId].rama;
  const ramaBase = estado.ramaBase;
  if (typeof rama !== 'string' || !RAMA_VALIDA.test(rama)
      || typeof ramaBase !== 'string' || !BASE_VALIDA.test(ramaBase)) {
    return { codigo: 409, cuerpo: { ok: false, motivo: 'estado del lote inesperado' } };
  }

  // El worktree de esa rama, y solo si su ruta real queda bajo
  // .claude/worktrees del repo.
  let wt = null;
  const entrada = listarWorktrees(repoPath).find((w) => w.rama === rama);
  if (entrada && fs.existsSync(entrada.ruta)) {
    try {
      const dirReal = fs.realpathSync.native(path.join(repoPath, DIR_WORKTREES));
      const wtReal = fs.realpathSync.native(entrada.ruta);
      const rel = path.relative(dirReal, wtReal);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) wt = wtReal;
    } catch {}
  }
  if (!wt) return { codigo: 200, cuerpo: { ok: false, motivo: 'worktree no disponible o ya limpiado' } };

  // Contra el merge-base y no contra la base a secas: si la base avanzó
  // durante el fan-out, sus commits nuevos se verían como borrados del
  // subagente.
  let base;
  try {
    base = gitWt(wt, ['merge-base', '--end-of-options', ramaBase, 'HEAD']).trim();
  } catch {
    return { codigo: 200, cuerpo: { ok: false, motivo: 'no se pudo determinar la base' } };
  }

  // Sin política no hay diff: falla cerrado.
  let politica;
  try {
    politica = await cargarPoliticaFn();
  } catch {
    return { codigo: 200, cuerpo: { ok: false, motivo: 'no se pudo cargar la política' } };
  }
  // La del repo principal: `.claude/antigravity.json` está ignorado y el
  // worktree no lo tiene.
  const deny = politica.loadPolicy(repoPath).denyPaths;

  try {
    const status = gitWt(wt, ['status', '--porcelain=v1', '-uall']).replace(/\s+$/, '');

    // deny_paths se aplica sobre la LISTA de archivos, no sobre el texto del
    // diff: `-z` no escapa nombres y `--no-renames` separa cada renombre en
    // una baja y un alta, así que cada ruta se juzga por sí misma.
    const archivos = gitWt(wt, ['diff', '--name-only', '-z', '--no-renames', '--end-of-options', base, '--'])
      .split('\0').filter(Boolean);
    const ocultos = [];
    const permitidos = [];
    for (const f of archivos) {
      (politica.matchDeniedPath(path.join(wt, f), deny) ? ocultos : permitidos).push(f);
    }

    let diff = '';
    let truncado = false;
    let aviso = null;
    const caracteres = permitidos.reduce((n, f) => n + f.length + 3, 0);
    if (permitidos.length >= DIFF_MAX_ARCHIVOS || caracteres > DIFF_MAX_CARACTERES_ARGS) {
      aviso = 'demasiados archivos para el diff: usá la terminal';
    } else if (permitidos.length > 0) {
      try {
        diff = gitWt(wt, ['diff', '--no-renames', '--end-of-options', base, '--', ...permitidos]);
      } catch (err) {
        // Más de 5 MB: execFileSync corta con ENOBUFS, pero lo que alcanzó a
        // leer viene en err.stdout. Mejor el principio, truncado, que un error.
        if (err.code !== 'ENOBUFS' || typeof err.stdout !== 'string') throw err;
        diff = err.stdout;
        truncado = true;
      }
      const bytes = Buffer.from(diff, 'utf8');
      if (bytes.length > DIFF_TOPE_BYTES) {
        diff = bytes.subarray(0, DIFF_TOPE_BYTES).toString('utf8');
        truncado = true;
      }
    }
    return { codigo: 200, cuerpo: { ok: true, status, diff, ocultos, truncado, aviso } };
  } catch (err) {
    return { codigo: 200, cuerpo: { ok: false, motivo: `git falló: ${String(err.message).split(/\r?\n/)[0]}` } };
  }
}

const AGY_BIN_VISOR =process.env.AGY_BIN || (process.platform === 'win32' ? 'agy.exe' : 'agy');

function crearServidor(repoPath, slug, { intervaloMs = INTERVALO_SONDEO_MS, token, agyBin = AGY_BIN_VISOR, homeDir = os.homedir() } = {}) {
  // Un token por sesión del visor. No se persiste: si el proceso se cae, el
  // que quedó en una pestaña abierta deja de servir, que es lo correcto.
  const tokenAcceso = token || crypto.randomBytes(24).toString('hex');

  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    const rechazar = (codigo, mensaje) => {
      res.writeHead(codigo, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(mensaje);
    };

    if (!hostEsLoopback(req)) {
      return rechazar(403, 'Solo se atiende por loopback.');
    }

    // El preflight no se responde: es lo que impide que otra pestaña mande la
    // cabecera `x-lagrange-token` cruzando orígenes.
    if (req.method === 'OPTIONS') {
      return rechazar(405, 'No.');
    }

    // FEAT-023. Sin lote de fan-out la raíz muestra directamente los agentes:
    // el visor dejó de ser solo el mirador de un fan-out, y exigir un lote para
    // arrancar dejaba la vista de agentes inalcanzable en un repo donde nunca
    // se corrió `agy_fanout`.
    const rutaAgentes = url.pathname === '/agents' || (url.pathname === '/' && !slug);

    if (req.method === 'GET' && rutaAgentes) {
      if (!tokenCoincide(tokenAcceso, url.searchParams.get('t'))) {
        return rechazar(403,
          'Falta el token de esta sesión del visor.\n\n'
          + 'Abrí la URL completa que imprimió la terminal, la que termina en "?t=...".');
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer'
      });
      res.end(paginaAgentes(tokenAcceso, Boolean(slug)));
      return;
    }

    // La matriz sale de disco y de un `agy agents`: barata, se pide de una.
    if (req.method === 'GET' && url.pathname === '/api/agentes') {
      if (!tokenCoincide(tokenAcceso, url.searchParams.get('t'))) {
        return rechazar(403, 'token invalido');
      }
      tableroAgentes.matriz(agyBin, homeDir).then(datos => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(datos));
      }).catch(err => {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // El criterio es una llamada de red con timeout, así que va aparte y bajo
    // demanda: no se paga al abrir la página, se paga al desplegar un agente.
    if (req.method === 'GET' && url.pathname === '/api/agentes/criterio') {
      if (!tokenCoincide(tokenAcceso, url.searchParams.get('t'))) {
        return rechazar(403, 'token invalido');
      }
      const agente = url.searchParams.get('agente');
      if (!agente || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(agente)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, motivo: 'agente invalido' }));
        return;
      }
      // El homeDir se propaga para que los tests no le peguen al servicio de
      // memoria real del usuario.
      memoriaAgentes.criterioDeAgente(agente, { homeDir }).then(datos => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(datos));
      }).catch(err => {
        // criterioDeAgente no debería lanzar nunca, pero si lo hace no puede
        // tumbar el servidor del visor.
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, motivo: err.message }));
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (!tokenCoincide(tokenAcceso, url.searchParams.get('t'))) {
        return rechazar(403,
          'Falta el token de esta sesión del visor.\n\n'
          + 'Abrí la URL completa que imprimió la terminal, la que termina en "?t=...".\n'
          + 'El token cambia cada vez que arranca el visor.');
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // La página lleva el token adentro: que no quede en ninguna caché.
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer'
      });
      res.end(paginaHtml(slug, tokenAcceso));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/eventos') {
      // El stream también va con token: por acá salen los prompts y el código
      // que genera cada subagente.
      if (!tokenCoincide(tokenAcceso, url.searchParams.get('t'))) {
        return rechazar(403, 'token invalido');
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });

      // El vigilante (y el último estado visto) son POR CONEXIÓN, no por
      // servidor: llevan el offset de lectura de cada log, así que
      // compartirlos hacía que la primera conexión se comiera el historial y
      // cualquier pestaña posterior —o un simple F5— arrancara vacía.
      // Encontrado mirando la página con Playwright: dos de las tres tarjetas
      // no mostraban una sola línea porque un `curl` previo ya había
      // consumido el backlog.
      const vigilante = crearVigilante(repoPath, slug);
      let ultimoEstadoSerializado = '';

      const empujar = (tipo, datos) => {
        res.write(`event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`);
      };

      // El primer envío va con el estado completo para que una pestaña que
      // se abre a mitad del lote no arranque en blanco.
      // `ultimaSenal` viaja con el estado y no en un pulso periódico: el
      // cliente la usa como punto de partida y después la adelanta sola cada
      // vez que le llega CUALQUIER evento. Así una pestaña recién abierta
      // sobre un lote muerto no lo ve "recién activo" (el dato sale del
      // disco), y un lote vivo nunca se marca quieto (los eventos lo
      // refrescan) — todo sin mandar un mensaje cada 500ms.
      const conSenal = (estado) => ({
        ...estado,
        ultimaSenal: ultimaSenal(repoPath, slug, Object.keys(estado.tareas || {}))
      });

      const estadoInicial = leerEstado(repoPath, slug);
      if (estadoInicial) {
        ultimoEstadoSerializado = JSON.stringify(estadoInicial.tareas || {});
        empujar('estado', conSenal(estadoInicial));
        for (const ev of vigilante.nuevosEventos(Object.keys(estadoInicial.tareas || {}), { conHora: false })) {
          empujar('evento', ev);
        }
      }

      const timer = setInterval(() => {
        const estado = leerEstado(repoPath, slug);
        if (!estado) return;

        const serializado = JSON.stringify(estado.tareas || {});
        if (serializado !== ultimoEstadoSerializado) {
          ultimoEstadoSerializado = serializado;
          empujar('estado', conSenal(estado));
        }
        for (const ev of vigilante.nuevosEventos(Object.keys(estado.tareas || {}))) {
          empujar('evento', ev);
        }
      }, intervaloMs);

      req.on('close', () => clearInterval(timer));
      return;
    }

    // El navegador lo pide siempre; sin esto ensucia la consola con un 404.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    // FEAT-033 — Solo lectura: token por query, como /api/eventos, que ya
    // transmite prompts y código de los subagentes.
    if (req.method === 'GET' && url.pathname === '/api/diff') {
      if (!tokenCoincide(tokenAcceso, url.searchParams.get('t'))) {
        return rechazar(403, 'token invalido');
      }
      diffDeTarea(repoPath, slug, url.searchParams.get('taskId') || '').then(({ codigo, cuerpo }) => {
        res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(cuerpo));
      }).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, motivo: err.message }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/detener') {
      // Acá el token se exige en la cabecera, no en la query: una cabecera
      // propia no se puede mandar cruzando orígenes sin un preflight que este
      // servidor no responde. Con el token solo en la query, un `<form>` en
      // otra pestaña alcanzaría.
      if (!tokenCoincide(tokenAcceso, req.headers['x-lagrange-token'])) {
        return rechazar(403, 'falta o no coincide x-lagrange-token');
      }
      if (!origenAceptable(req)) {
        return rechazar(403, 'origen no permitido');
      }

      let cuerpo = '';
      req.on('data', c => {
        cuerpo += c;
        // Nadie legítimo manda más que un taskId acá.
        if (cuerpo.length > 4096) req.destroy();
      });
      req.on('end', () => {
        let taskId;
        try { taskId = JSON.parse(cuerpo).taskId; } catch {}
        if (!taskId) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"ok":false,"error":"falta taskId"}');
          return;
        }
        try {
          marcarDetencion(repoPath, slug, taskId, 'detenido desde /lagrange:watch');
          process.stderr.write(`[fanout-watch] detención pedida para "${taskId}"\n`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no encontrado');
  });

  // Quien levanta el servidor necesita el token para poder imprimir una URL
  // que sirva. Va como propiedad para no cambiarle la forma al valor de
  // retorno, que ya es el server y lo usan los tests.
  servidor.tokenAcceso = tokenAcceso;
  return servidor;
}

function main() {
  const argv = process.argv.slice(2);
  const puertoIdx = argv.indexOf('--port');
  const slugIdx = argv.indexOf('--slug');
  const puerto = puertoIdx !== -1 ? parseInt(argv[puertoIdx + 1], 10) : PUERTO_POR_DEFECTO;
  const slugPedido = slugIdx !== -1 ? argv[slugIdx + 1] : null;
  const repoPath = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--port' && argv[i - 1] !== '--slug')
    || process.cwd();

  const lotes = descubrirLotes(repoPath);
  const slug = slugPedido || (lotes[0] && lotes[0].slug);

  // Antes de FEAT-023 esto salía con error: el visor era solo el mirador de un
  // fan-out. Ahora también muestra los agentes persistidos, que no dependen de
  // ningún lote ni de ningún repo, así que no tener lote deja de ser fatal.
  if (!slug) {
    process.stderr.write(
      `No hay ningún lote de fan-out en ${path.join(repoPath, DIR_WORKTREES)}: `
      + 'se abre solo la vista de agentes persistidos.\n'
    );
  }

  const servidor = crearServidor(repoPath, slug);
  // Solo loopback, a propósito: estos logs traen prompts y código.
  servidor.listen(puerto, '127.0.0.1', () => {
    process.stdout.write(slug
      ? `\nVisor de fan-out para "${slug}" (+ agentes persistidos en /agents)\n`
      : '\nVisor de agentes persistidos\n');
    // La URL SIN el token no sirve para nada: es a propósito (SEC-011).
    process.stdout.write(`  http://127.0.0.1:${puerto}/?t=${servidor.tokenAcceso}\n\n`);
    if (lotes.length > 1) {
      process.stdout.write(`Otros lotes: ${lotes.slice(1).map(l => l.slug).join(', ')} (--slug <nombre>)\n\n`);
    }
    process.stdout.write('Ctrl+C para cerrar.\n');
  });

  servidor.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`El puerto ${puerto} ya está ocupado. Probá con --port ${puerto + 1}.\n`);
    } else {
      process.stderr.write(`No se pudo levantar el visor: ${err.message}\n`);
    }
    process.exitCode = 1;
  });
}

if (require.main === module) main();

module.exports = { crearServidor, descubrirLotes, crearVigilante, paginaHtml, paginaAgentes, ultimaSenal, diffDeTarea };
