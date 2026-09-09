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
 * SEGURIDAD: los logs traen prompts y código generado, así que el servidor
 * escucha SOLO en 127.0.0.1 y no se ofrece forma de exponerlo a la red. No
 * hay autenticación más allá de eso: en localhost es razonable, pero es una
 * decisión deliberada, no un olvido.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { rutaEstado, rutaProgreso, marcarDetencion, DIR_WORKTREES } = require('./fanout-estado.js');
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

function paginaHtml(slug) {
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
  #grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
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
  .stop { margin-left: auto; background: none; border: 1px solid #3d4350; color: #d7dae0;
          border-radius: 4px; padding: 2px 9px; cursor: pointer; font: inherit; font-size: 11px; }
  .stop:hover:not(:disabled) { border-color: #f85149; color: #f85149; }
  .stop:disabled { opacity: .35; cursor: default; }
  .log { overflow-y: auto; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; flex: 1; }
  .linea { padding: 1px 0; border-bottom: 1px solid #1c2029; }
  .hora { color: #4d5566; }
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
</header>
<div id="grid"></div>
<div id="vacio" hidden>Sin tareas todavía.</div>
<script>
const grid = document.getElementById('grid');
const resumen = document.getElementById('resumen');
const tarjetas = new Map();

function tarjeta(taskId) {
  if (tarjetas.has(taskId)) return tarjetas.get(taskId);
  const el = document.createElement('div');
  el.className = 'tarea';
  el.innerHTML = '<div class="cab"><span class="nombre"></span>' +
    '<span class="estado"></span>' +
    '<button class="stop">Detener</button></div><div class="log"></div>';
  el.querySelector('.nombre').textContent = taskId;
  el.querySelector('.stop').addEventListener('click', async (ev) => {
    const boton = ev.currentTarget;
    boton.disabled = true;
    boton.textContent = 'Deteniendo…';
    try {
      const r = await fetch('/api/detener', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

function pintarEstado(datos) {
  const tareas = datos.tareas || {};
  const ids = Object.keys(tareas);
  document.getElementById('vacio').hidden = ids.length > 0;

  let ok = 0, err = 0, corriendo = 0;
  for (const id of ids) {
    const t = tareas[id];
    const el = tarjeta(id);
    const estado = t.detenido ? 'detenida' : (t.estado || 'pendiente');
    const badge = el.querySelector('.estado');
    badge.textContent = estado;
    badge.className = 'estado ' + estado;
    // Detener solo tiene sentido mientras siga en vuelo.
    el.querySelector('.stop').disabled = !(estado === 'corriendo' || estado === 'reintentando');
    if (t.estado === 'ok') ok++;
    else if (t.estado === 'error') err++;
    else if (t.estado === 'corriendo' || t.estado === 'reintentando') corriendo++;
  }
  resumen.textContent = ids.length + ' tareas · ' + ok + ' ok · ' + err + ' error · ' +
    corriendo + ' en vuelo' + (datos.terminado ? ' · terminado' : '');
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

const fuente = new EventSource('/api/eventos');
fuente.addEventListener('estado', e => pintarEstado(JSON.parse(e.data)));
fuente.addEventListener('evento', e => pintarEvento(JSON.parse(e.data)));
fuente.onerror = () => { resumen.textContent = 'desconectado (¿se cerró el visor?)'; };
</script>
</body>
</html>`;
}

function escapar(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function crearServidor(repoPath, slug, { intervaloMs = INTERVALO_SONDEO_MS } = {}) {
  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(paginaHtml(slug));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/eventos') {
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
      const estadoInicial = leerEstado(repoPath, slug);
      if (estadoInicial) {
        ultimoEstadoSerializado = JSON.stringify(estadoInicial.tareas || {});
        empujar('estado', estadoInicial);
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
          empujar('estado', estado);
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

    if (req.method === 'POST' && url.pathname === '/api/detener') {
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

  if (!slug) {
    process.stderr.write(
      `No hay ningún lote de fan-out en ${path.join(repoPath, DIR_WORKTREES)}.\n` +
      'Corré un agy_fanout primero, o pasá --slug si sabés cuál querés mirar.\n'
    );
    process.exitCode = 1;
    return;
  }

  const servidor = crearServidor(repoPath, slug);
  // Solo loopback, a propósito: estos logs traen prompts y código.
  servidor.listen(puerto, '127.0.0.1', () => {
    process.stdout.write(`\nVisor de fan-out para "${slug}"\n`);
    process.stdout.write(`  http://127.0.0.1:${puerto}\n\n`);
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

module.exports = { crearServidor, descubrirLotes, crearVigilante, paginaHtml };
