/**
 * Visor local de fan-out (`/lagrange:watch`, fanout-watch.js).
 *
 * Se prueba contra un servidor real levantado en 127.0.0.1 con un puerto
 * efímero (`listen(0)`): el contrato que importa es HTTP —qué sirve, qué
 * empuja por SSE, y que el POST de detener escriba el centinela de
 * FEAT-012— y eso no se puede comprobar sin un servidor de verdad. Los
 * archivos de estado y de progreso son los reales que escriben
 * fanout-estado.js y el orquestador, creados a mano acá.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { check, group, report } = require('./lib/assert');

const { crearServidor, descubrirLotes, crearVigilante, paginaHtml } = require('../mcp-server/fanout-watch.js');
const { crearEscritorDeEstado, rutaProgreso, rutaControl } = require('../mcp-server/fanout-estado.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

function escribirEvento(repo, slug, taskId, evento) {
  const ruta = rutaProgreso(repo, slug, taskId);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.appendFileSync(ruta, JSON.stringify(evento) + '\n');
}

/** GET simple contra el servidor de pruebas. */
function pedir(puerto, ruta) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: puerto, path: ruta }, (res) => {
      let cuerpo = '';
      res.on('data', c => { cuerpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, cuerpo }));
    }).on('error', reject);
  });
}

function postear(puerto, ruta, datos) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(datos);
    const req = http.request({
      host: '127.0.0.1', port: puerto, path: ruta, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, (res) => {
      let cuerpo = '';
      res.on('data', c => { cuerpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, cuerpo }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Abre el stream SSE y junta los eventos que llegan durante `ms`. */
function escucharSse(puerto, ms) {
  return new Promise((resolve, reject) => {
    const recibidos = [];
    const req = http.get({ host: '127.0.0.1', port: puerto, path: '/api/eventos' }, (res) => {
      let buffer = '';
      res.on('data', (c) => {
        buffer += c.toString();
        const bloques = buffer.split('\n\n');
        buffer = bloques.pop();
        for (const bloque of bloques) {
          const tipo = (bloque.match(/^event: (.+)$/m) || [])[1];
          const datos = (bloque.match(/^data: (.+)$/m) || [])[1];
          if (tipo && datos) recibidos.push({ tipo, datos: JSON.parse(datos) });
        }
      });
      setTimeout(() => { req.destroy(); resolve(recibidos); }, ms);
    });
    req.on('error', (err) => {
      // destroy() al final dispara ECONNRESET: no es un fallo del test.
      if (err.code === 'ECONNRESET') resolve(recibidos);
      else reject(err);
    });
  });
}

function levantar(repo, slug) {
  return new Promise((resolve) => {
    const servidor = crearServidor(repo, slug, { intervaloMs: 40 });
    servidor.listen(0, '127.0.0.1', () => resolve({ servidor, puerto: servidor.address().port }));
  });
}

async function main() {
  await group('descubrirLotes', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-desc-'));
    try {
      check('sin nada, devuelve lista vacía sin reventar', descubrirLotes(repo).length === 0);

      crearEscritorDeEstado(repo, 'lote-viejo', [{ id: 'a' }]).iniciar({ ramaBase: 'x', concurrencia: 1 });
      crearEscritorDeEstado(repo, 'lote-nuevo', [{ id: 'b' }]).iniciar({ ramaBase: 'x', concurrencia: 1 });
      // `actualizado` decide cuál es "el actual"; se fuerza para no depender
      // del reloj entre dos escrituras casi simultáneas.
      const ruta = path.join(repo, '.claude', 'worktrees', '.fanout-status-lote-nuevo.json');
      const datos = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      datos.actualizado = '2099-01-01T00:00:00.000Z';
      fs.writeFileSync(ruta, JSON.stringify(datos));

      const lotes = descubrirLotes(repo);
      check('encuentra los dos lotes', lotes.length === 2, String(lotes.length));
      check('el más reciente va primero', lotes[0].slug === 'lote-nuevo', lotes[0].slug);
    } finally { borrar(repo); }
  });

  await group('crearVigilante devuelve solo lo nuevo, ya formateado', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-vig-'));
    try {
      const vig = crearVigilante(repo, 'lote');
      check('sin log todavía, no hay eventos', vig.nuevosEventos(['a']).length === 0);

      escribirEvento(repo, 'lote', 'a', { event: 'init', conversation_id: 'abcd1234' });
      const primera = vig.nuevosEventos(['a']);
      check('trae el evento nuevo', primera.length === 1, JSON.stringify(primera));
      check('viene con taskId y texto formateado', primera[0].taskId === 'a' && /iniciado/.test(primera[0].texto), JSON.stringify(primera[0]));

      check('no repite lo ya entregado', vig.nuevosEventos(['a']).length === 0);

      escribirEvento(repo, 'lote', 'a', { event: 'step_update', step_update: { step_type: 'user_input', text_delta: 'ECO' } });
      check('descarta lo que formatearLinea considera ruido (eco del prompt)', vig.nuevosEventos(['a']).length === 0);

      // El historial se reproduce SIN hora: los eventos de agy no traen
      // timestamp, así que sellar una línea vieja con la hora actual es
      // inventar el dato (se veía "17:26:32 · sigue en vuelo 17:25:10").
      escribirEvento(repo, 'lote', 'b', { event: 'init', conversation_id: 'bbbb2222' });
      const sinHora = crearVigilante(repo, 'lote').nuevosEventos(['b'], { conHora: false });
      check('el replay del historial viene sin hora', sinHora[0].hora === null, JSON.stringify(sinHora[0]));

      escribirEvento(repo, 'lote', 'c', { event: 'init', conversation_id: 'cccc3333' });
      const conHora = crearVigilante(repo, 'lote').nuevosEventos(['c']);
      check('lo que llega en vivo sí trae hora', /^\d\d:\d\d:\d\d$/.test(conHora[0].hora), JSON.stringify(conHora[0]));

      // FEAT-014: el evento ahora viaja estructurado, no como una línea ya
      // armada — el navegador necesita `stepIndex` para unir los fragmentos.
      check('el evento trae tipo y stepIndex', conHora[0].tipo === 'inicio' && 'stepIndex' in conHora[0], JSON.stringify(conHora[0]));
    } finally { borrar(repo); }
  });

  await group('paginaHtml escapa el slug (no inyecta HTML)', () => {
    const html = paginaHtml('<script>alert(1)</script>');
    check('no deja el script crudo', !html.includes('<script>alert(1)</script>'));
    check('lo deja escapado', html.includes('&lt;script&gt;'));
  });

  await group('servidor: sirve la página y transmite estado + eventos por SSE', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-srv-'));
    let servidor;
    try {
      const escritor = crearEscritorDeEstado(repo, 'mi-lote', [{ id: 'auth' }, { id: 'billing' }]);
      escritor.iniciar({ ramaBase: 'feat/x', concurrencia: 2 });
      escritor.marcar('auth', { estado: 'corriendo' });
      escribirEvento(repo, 'mi-lote', 'auth', { event: 'init', conversation_id: 'cafe1234' });

      const lanzado = await levantar(repo, 'mi-lote');
      servidor = lanzado.servidor;
      const { puerto } = lanzado;

      const pagina = await pedir(puerto, '/');
      check('GET / responde 200 html', pagina.status === 200 && /text\/html/.test(pagina.headers['content-type']));
      check('la página nombra el lote', pagina.cuerpo.includes('mi-lote'));
      check('trae el cliente SSE', pagina.cuerpo.includes("new EventSource('/api/eventos')"));

      const noExiste = await pedir(puerto, '/no-existe');
      check('404 en rutas desconocidas', noExiste.status === 404);

      // Escuchar y, mientras tanto, generar actividad nueva.
      const escucha = escucharSse(puerto, 400);
      await new Promise(r => setTimeout(r, 120));
      escritor.marcar('billing', { estado: 'corriendo' });
      escribirEvento(repo, 'mi-lote', 'billing', {
        event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'tocando billing.js' }
      });

      const recibidos = await escucha;
      const estados = recibidos.filter(r => r.tipo === 'estado');
      const eventos = recibidos.filter(r => r.tipo === 'evento');

      check('manda el estado inicial al conectar', estados.length >= 1, JSON.stringify(recibidos.map(r => r.tipo)));
      check('el estado inicial trae las dos tareas',
        Object.keys(estados[0].datos.tareas || {}).sort().join(',') === 'auth,billing',
        JSON.stringify(Object.keys(estados[0].datos.tareas || {})));
      check('empuja el evento ya existente al conectar (no arranca en blanco)',
        eventos.some(e => e.datos.taskId === 'auth' && /iniciado/.test(e.datos.texto)), JSON.stringify(eventos));
      check('empuja el evento nuevo que apareció mientras escuchaba',
        eventos.some(e => e.datos.taskId === 'billing' && /billing\.js/.test(e.datos.texto)), JSON.stringify(eventos));
      check('reenvía el estado cuando cambia', estados.length >= 2, `estados = ${estados.length}`);
    } finally {
      if (servidor) await new Promise(r => servidor.close(r));
      borrar(repo);
    }
  });

  await group('servidor: cada conexión recibe el historial completo (regresión)', async () => {
    // Bug encontrado mirando la página real con Playwright: el vigilante y el
    // "último estado" eran por SERVIDOR, no por conexión. Como llevan el
    // offset de lectura de cada log, la primera conexión se comía el
    // historial y cualquier pestaña posterior —o un F5— arrancaba vacía.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-replay-'));
    let servidor;
    try {
      crearEscritorDeEstado(repo, 'lote-replay', [{ id: 'a' }]).iniciar({ ramaBase: 'x', concurrencia: 1 });
      escribirEvento(repo, 'lote-replay', 'a', { event: 'init', conversation_id: 'aaaa1111' });
      escribirEvento(repo, 'lote-replay', 'a', {
        event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'linea historica' }
      });

      const lanzado = await levantar(repo, 'lote-replay');
      servidor = lanzado.servidor;
      const { puerto } = lanzado;

      const primera = await escucharSse(puerto, 250);
      const segunda = await escucharSse(puerto, 250);

      const historicasDe = (recibidos) => recibidos
        .filter(r => r.tipo === 'evento' && /linea historica/.test(r.datos.texto)).length;

      check('la primera conexión ve la línea histórica', historicasDe(primera) === 1, JSON.stringify(primera));
      check('la SEGUNDA conexión también la ve (no se la comió la primera)',
        historicasDe(segunda) === 1, JSON.stringify(segunda));
      check('la segunda también recibe el estado inicial',
        segunda.some(r => r.tipo === 'estado'), JSON.stringify(segunda.map(r => r.tipo)));
    } finally {
      if (servidor) await new Promise(r => servidor.close(r));
      borrar(repo);
    }
  });

  await group('servidor: /favicon.ico responde 204 (no ensucia la consola)', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-fav-'));
    let servidor;
    try {
      crearEscritorDeEstado(repo, 'lote-fav', [{ id: 'a' }]).iniciar({ ramaBase: 'x', concurrencia: 1 });
      const lanzado = await levantar(repo, 'lote-fav');
      servidor = lanzado.servidor;
      const r = await pedir(lanzado.puerto, '/favicon.ico');
      check('204, no 404', r.status === 204, String(r.status));
    } finally {
      if (servidor) await new Promise(r => servidor.close(r));
      borrar(repo);
    }
  });

  await group('servidor: POST /api/detener escribe el centinela de FEAT-012', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-stop-'));
    let servidor;
    try {
      crearEscritorDeEstado(repo, 'lote-stop', [{ id: 'solo' }]).iniciar({ ramaBase: 'x', concurrencia: 1 });
      const lanzado = await levantar(repo, 'lote-stop');
      servidor = lanzado.servidor;
      const { puerto } = lanzado;

      check('todavía no hay centinela', !fs.existsSync(rutaControl(repo, 'lote-stop', 'solo')));

      const r = await postear(puerto, '/api/detener', { taskId: 'solo' });
      check('responde 200 ok', r.status === 200 && JSON.parse(r.cuerpo).ok === true, r.cuerpo);
      check('el centinela quedó escrito donde FEAT-012 lo busca', fs.existsSync(rutaControl(repo, 'lote-stop', 'solo')));

      const contenido = JSON.parse(fs.readFileSync(rutaControl(repo, 'lote-stop', 'solo'), 'utf8'));
      check('deja constancia de que vino del visor', /watch/.test(contenido.motivo || ''), contenido.motivo);

      const malo = await postear(puerto, '/api/detener', { nada: true });
      check('400 si falta taskId', malo.status === 400, String(malo.status));

      // El taskId llega del navegador: no puede escaparse del directorio de
      // worktrees por más raro que venga. `rutaControl` lo pasa por
      // `idParaArchivo` (slugifica + sufijo hash), así que no hay separadores
      // de ruta que sobrevivan — pero conviene probarlo, no asumirlo.
      const dirWorktrees = path.join(repo, '.claude', 'worktrees');
      const antes = new Set(fs.readdirSync(dirWorktrees));
      const travesia = await postear(puerto, '/api/detener', { taskId: '../../../../evil' });
      check('acepta el pedido sin reventar', travesia.status === 200, String(travesia.status));

      const fueraDelDir = fs.existsSync(path.join(repo, 'evil')) ||
        fs.existsSync(path.join(repo, '..', 'evil')) ||
        fs.existsSync(path.join(repo, '.claude', 'evil'));
      check('no escribió nada fuera de .claude/worktrees', !fueraDelDir);

      const nuevos = fs.readdirSync(dirWorktrees).filter(n => !antes.has(n));
      check('el archivo quedó dentro del dir, con nombre saneado', nuevos.length === 1, JSON.stringify(nuevos));
      check('sin separadores de ruta en el nombre',
        nuevos[0] && !nuevos[0].includes('/') && !nuevos[0].includes('\\') && !nuevos[0].includes('..'),
        nuevos[0]);
    } finally {
      if (servidor) await new Promise(r => servidor.close(r));
      borrar(repo);
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
