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

const { crearServidor, descubrirLotes, crearVigilante, paginaHtml, paginaAgentes } = require('../mcp-server/fanout-watch.js');
const { crearEscritorDeEstado, rutaProgreso, rutaControl, rutaEstado } = require('../mcp-server/fanout-estado.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

function escribirEvento(repo, slug, taskId, evento) {
  const ruta = rutaProgreso(repo, slug, taskId);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.appendFileSync(ruta, JSON.stringify(evento) + '\n');
}

/** GET simple contra el servidor de pruebas. */
function pedir(puerto, ruta, token) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: puerto, path: conToken(ruta, token) }, (res) => {
      let cuerpo = '';
      res.on('data', c => { cuerpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, cuerpo }));
    }).on('error', reject);
  });
}

function postear(puerto, ruta, datos, { token, cabeceras = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(datos);
    const base = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    if (token) base['x-lagrange-token'] = token;
    const req = http.request({
      host: '127.0.0.1', port: puerto, path: ruta, method: 'POST',
      headers: { ...base, ...cabeceras }
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
function escucharSse(puerto, ms, token) {
  return new Promise((resolve, reject) => {
    const recibidos = [];
    const req = http.get({ host: '127.0.0.1', port: puerto, path: conToken('/api/eventos', token) }, (res) => {
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

/** SEC-011: sin token no se sirve nada, asi que los helpers lo llevan siempre. */
function conToken(ruta, token) {
  if (!token) return ruta;
  return ruta + (ruta.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token);
}


/** GET crudo, con control total de las cabeceras: hace falta para falsear Host. */
function pedirCrudo(puerto, ruta, cabeceras = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: puerto, path: ruta, method: 'GET', headers: cabeceras
    }, (res) => {
      let cuerpo = '';
      res.on('data', c => { cuerpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, cuerpo }));
    });
    req.on('error', reject);
    req.end();
  });
}

function opciones(puerto, ruta) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method: 'OPTIONS' },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * FEAT-023. El visor lee el registro de agentes del home, asi que los tests le
 * pasan uno falso: sin eso mirarian los agentes reales del usuario y le
 * pegarian a su servicio de memoria.
 */
function levantarConHome(repo, slug, homeDir) {
  return new Promise((resolve) => {
    // `agyBin` apunta a un binario inexistente a proposito: es el escenario
    // "no se pudo consultar agy", que el tablero tiene que saber contar.
    const servidor = crearServidor(repo, slug, {
      intervaloMs: 40, homeDir, agyBin: 'agy-que-no-existe-xyz'
    });
    servidor.listen(0, '127.0.0.1', () => resolve({
      servidor, puerto: servidor.address().port, token: servidor.tokenAcceso
    }));
  });
}

function levantar(repo, slug) {
  return new Promise((resolve) => {
    const servidor = crearServidor(repo, slug, { intervaloMs: 40 });
    servidor.listen(0, '127.0.0.1', () => resolve({
      servidor,
      puerto: servidor.address().port,
      token: servidor.tokenAcceso
    }));
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

  await group('el JS de la página PARSEA (el punto ciego de los tests de servidor)', () => {
    // La página se arma dentro de un template literal, así que el servidor
    // levanta igual aunque su JavaScript esté roto: para Node es un string
    // válido. Ya pasó dos veces —un backtick en un comentario, y un \n que
    // se comió el literal de afuera dejando un salto de línea real en medio
    // de un string— con los 41 checks de servidor en verde y la página
    // muerta en el navegador. Esto lo agarra sin abrir un navegador.
    const html = paginaHtml('mi-lote');
    const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
    check('la página trae un bloque de script', typeof script === 'string' && script.length > 100);

    let error = null;
    try {
      // eslint-disable-next-line no-new-func
      new Function(script);
    } catch (err) {
      error = err.message;
    }
    check('el script del cliente es sintácticamente válido', error === null, String(error));

    // Mismo punto ciego para la página de agentes (FEAT-023): también vive
    // dentro de un template literal, también levantaría el servidor rota.
    const htmlAgentes = paginaAgentes('tok3n', true);
    const scriptAgentes = (htmlAgentes.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
    check('la página de agentes trae un bloque de script',
      typeof scriptAgentes === 'string' && scriptAgentes.length > 100);

    let errorAgentes = null;
    try {
      // eslint-disable-next-line no-new-func
      new Function(scriptAgentes);
    } catch (err) {
      errorAgentes = err.message;
    }
    check('el script de agentes es sintácticamente válido', errorAgentes === null, String(errorAgentes));

    // El token tiene que quedar como literal JS, no como el texto de la
    // interpolación sin resolver: fue exactamente el bug que tuvo esta página.
    check('el token se interpola de verdad en el script',
      scriptAgentes.includes('const TOKEN = "tok3n"'), scriptAgentes.slice(0, 120));
    check('y el link al fan-out lleva el token resuelto',
      htmlAgentes.includes('/?t=tok3n'));
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
      const { puerto, token } = lanzado;

      const pagina = await pedir(puerto, '/', token);
      check('GET / responde 200 html', pagina.status === 200 && /text\/html/.test(pagina.headers['content-type']));
      check('la página nombra el lote', pagina.cuerpo.includes('mi-lote'));
      check('trae el cliente SSE', pagina.cuerpo.includes("new EventSource('/api/eventos?t='"));
      check('la pagina lleva el token de la sesion', pagina.cuerpo.includes(token));
      check('no se cachea, porque lleva el token adentro',
        pagina.headers['cache-control'] === 'no-store');

      const noExiste = await pedir(puerto, '/no-existe', token);
      check('404 en rutas desconocidas', noExiste.status === 404);

      // Escuchar y, mientras tanto, generar actividad nueva.
      const escucha = escucharSse(puerto, 400, token);
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
      const { puerto, token } = lanzado;

      const primera = await escucharSse(puerto, 250, token);
      const segunda = await escucharSse(puerto, 250, token);

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
      const r = await pedir(lanzado.puerto, '/favicon.ico', lanzado.token);
      check('204, no 404', r.status === 204, String(r.status));
    } finally {
      if (servidor) await new Promise(r => servidor.close(r));
      borrar(repo);
    }
  });

  await group('ultimaSenal mira los logs, no solo `actualizado` (FEAT-016)', async () => {
    // El remedio que proponía la auditoría —comparar contra `actualizado`—
    // habría dado falso positivo en el caso más normal: una tarea que corre
    // diez minutos genera UN solo `marcar`, así que `actualizado` queda
    // congelado aunque el subagente esté escupiendo texto sin parar.
    const { ultimaSenal } = require('../mcp-server/fanout-watch.js');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-senal-'));
    try {
      const escritor = crearEscritorDeEstado(repo, 'lote-vivo', [{ id: 'a' }]);
      escritor.iniciar({ ramaBase: 'x', concurrencia: 1 });

      // Envejecer el archivo de estado a 30 minutos atrás: es lo que pasaría
      // con una tarea larga que ya fue marcada "corriendo" y nada más.
      const viejo = Date.now() - 30 * 60 * 1000;
      fs.utimesSync(rutaEstado(repo, 'lote-vivo'), new Date(viejo), new Date(viejo));

      const soloEstado = ultimaSenal(repo, 'lote-vivo', ['a']);
      check('sin log, la señal es la del archivo de estado (vieja)',
        Math.abs(soloEstado - viejo) < 5000, `${soloEstado} vs ${viejo}`);

      // Ahora el subagente escribe en su log: eso ES señal de vida.
      escribirEvento(repo, 'lote-vivo', 'a', { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'sigo trabajando' } });
      const conLog = ultimaSenal(repo, 'lote-vivo', ['a']);
      check('con log reciente, la señal se actualiza aunque el estado sea viejo',
        Date.now() - conLog < 5000, `hace ${Date.now() - conLog}ms`);
      check('y es más nueva que la del archivo de estado', conLog > soloEstado);
    } finally { borrar(repo); }
  });

  await group('servidor: el estado que viaja incluye ultimaSenal (FEAT-016)', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-fin-'));
    let servidor;
    try {
      const escritor = crearEscritorDeEstado(repo, 'lote-fin', [{ id: 'a' }]);
      escritor.iniciar({ ramaBase: 'x', concurrencia: 1 });
      escritor.marcar('a', { estado: 'ok', intentos: 1, fin: new Date().toISOString() });
      escritor.terminar();

      const lanzado = await levantar(repo, 'lote-fin');
      servidor = lanzado.servidor;
      const recibidos = await escucharSse(lanzado.puerto, 250, lanzado.token);
      const estado = recibidos.find(r => r.tipo === 'estado');

      check('el lote terminado informa `terminado`', typeof estado.datos.terminado === 'string', JSON.stringify(estado.datos.terminado));
      check('e `iniciado`, para poder calcular la duración total', typeof estado.datos.iniciado === 'string');
      check('y viaja la última señal para saber si sigue habiendo movimiento',
        typeof estado.datos.ultimaSenal === 'number' && estado.datos.ultimaSenal > 0, JSON.stringify(estado.datos.ultimaSenal));
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
      const { puerto, token } = lanzado;

      check('todavía no hay centinela', !fs.existsSync(rutaControl(repo, 'lote-stop', 'solo')));

      const r = await postear(puerto, '/api/detener', { taskId: 'solo' }, { token });
      check('responde 200 ok', r.status === 200 && JSON.parse(r.cuerpo).ok === true, r.cuerpo);
      check('el centinela quedó escrito donde FEAT-012 lo busca', fs.existsSync(rutaControl(repo, 'lote-stop', 'solo')));

      const contenido = JSON.parse(fs.readFileSync(rutaControl(repo, 'lote-stop', 'solo'), 'utf8'));
      check('deja constancia de que vino del visor', /watch/.test(contenido.motivo || ''), contenido.motivo);

      const malo = await postear(puerto, '/api/detener', { nada: true }, { token });
      check('400 si falta taskId', malo.status === 400, String(malo.status));

      // El taskId llega del navegador: no puede escaparse del directorio de
      // worktrees por más raro que venga. `rutaControl` lo pasa por
      // `idParaArchivo` (slugifica + sufijo hash), así que no hay separadores
      // de ruta que sobrevivan — pero conviene probarlo, no asumirlo.
      const dirWorktrees = path.join(repo, '.claude', 'worktrees');
      const antes = new Set(fs.readdirSync(dirWorktrees));
      const travesia = await postear(puerto, '/api/detener', { taskId: '../../../../evil' }, { token });
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


  // ------------------------------------------------------------------
  // SEC-011. El visor escucha en loopback, pero eso nunca protegió del
  // navegador del propio usuario: cualquier pestaña puede postear a
  // 127.0.0.1. Lo que se prueba acá es que el ataque falla, no que el camino
  // feliz anda (eso ya lo cubren las suites de arriba).
  // ------------------------------------------------------------------
  await group('SEC-011: el visor exige token y rechaza pedidos cruzados', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-sec-'));
    let servidor;
    let otro;
    try {
      crearEscritorDeEstado(repo, 'lote-sec', [{ id: 'solo' }]).iniciar({ ramaBase: 'x', concurrencia: 1 });
      const lanzado = await levantar(repo, 'lote-sec');
      servidor = lanzado.servidor;
      const { puerto, token } = lanzado;

      check('el servidor expone un token de sesión',
        typeof token === 'string' && token.length >= 32, String(token));

      const otroLanzado = await levantar(repo, 'lote-sec');
      otro = otroLanzado.servidor;
      check('cada visor tiene su propio token', otroLanzado.token !== token);

      // --- lectura ---
      check('GET / sin token es 403', (await pedir(puerto, '/')).status === 403);
      check('GET / con token equivocado es 403',
        (await pedir(puerto, '/', 'a'.repeat(token.length))).status === 403);
      check('GET / con el token de OTRO visor es 403',
        (await pedir(puerto, '/', otroLanzado.token)).status === 403);
      check('el 403 explica dónde está la URL buena',
        /t=/.test((await pedir(puerto, '/')).cuerpo));

      // El stream es lo que filtra prompts y código generado.
      check('GET /api/eventos sin token es 403',
        (await pedir(puerto, '/api/eventos')).status === 403);

      // --- DNS rebinding ---
      check('un Host que no es loopback es 403',
        (await pedirCrudo(puerto, '/?t=' + token, { host: 'malicioso.example.com' })).status === 403);
      check('Host loopback con puerto sí pasa',
        (await pedirCrudo(puerto, '/?t=' + token, { host: '127.0.0.1:' + puerto })).status === 200);

      // --- preflight ---
      // No responderlo es justamente lo que impide que otra pestaña mande la
      // cabecera x-lagrange-token.
      const pre = await opciones(puerto, '/api/detener');
      check('el preflight CORS no se responde', pre.status === 405, String(pre.status));

      // --- mutación ---
      const centinela = () => fs.existsSync(rutaControl(repo, 'lote-sec', 'solo'));
      check('parte sin centinela', !centinela());

      const sinToken = await postear(puerto, '/api/detener', { taskId: 'solo' });
      check('POST sin token es 403', sinToken.status === 403, String(sinToken.status));
      check('y no escribió el centinela', !centinela());

      // El caso que motiva la cabecera: un <form> hostil puede poner el token
      // en la query si alguna vez se filtró la URL, pero no puede mandar una
      // cabecera propia sin preflight.
      const soloQuery = await postear(puerto, '/api/detener?t=' + token, { taskId: 'solo' });
      check('POST con el token solo en la query es 403', soloQuery.status === 403, String(soloQuery.status));
      check('sigue sin centinela', !centinela());

      const origenAjeno = await postear(puerto, '/api/detener', { taskId: 'solo' },
        { token, cabeceras: { origin: 'https://malicioso.example.com' } });
      check('POST con token válido pero Origin ajeno es 403', origenAjeno.status === 403, String(origenAjeno.status));

      const cruzado = await postear(puerto, '/api/detener', { taskId: 'solo' },
        { token, cabeceras: { 'sec-fetch-site': 'cross-site' } });
      check('POST con Sec-Fetch-Site cross-site es 403', cruzado.status === 403, String(cruzado.status));

      const desdeOtroVisor = await postear(puerto, '/api/detener', { taskId: 'solo' },
        { token: otroLanzado.token });
      check('POST con el token de otro visor es 403', desdeOtroVisor.status === 403);

      check('ninguno de los rechazos escribió el centinela', !centinela());

      // Y el camino legítimo del navegador sigue funcionando.
      const legitimo = await postear(puerto, '/api/detener', { taskId: 'solo' }, {
        token,
        cabeceras: { origin: 'http://127.0.0.1:' + puerto, 'sec-fetch-site': 'same-origin' }
      });
      check('el POST del propio visor sí pasa', legitimo.status === 200, String(legitimo.status));
      check('y ahora sí escribió el centinela', centinela());
    } finally {
      if (servidor) await new Promise(r => servidor.close(r));
      if (otro) await new Promise(r => otro.close(r));
      borrar(repo);
    }
  });


  // ------------------------------------------------------------------
  // FEAT-023 — la vista de agentes persistidos. Lo que se prueba es lo que la
  // pagina promete y lo que NO: no hay decision gates (FEAT-019 se descarto) ni
  // estado "corriendo" (cast_agent es sincronico y no deja rastro en disco).
  // ------------------------------------------------------------------
  await group('FEAT-023: vista de agentes persistidos', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-ag-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-home-'));
    let servidor;
    try {
      // Un agente registrado, otro con hilo pero sin registro (huerfano).
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'antigravity-agents.json'), JSON.stringify({
        agents: { reviewer: { skill: 'agency-code-reviewer', read_only: true, tools: ['view_file'], project_id: null } }
      }), 'utf8');
      fs.writeFileSync(path.join(home, '.claude', 'antigravity-agents-state.json'), JSON.stringify({
        agents: {
          reviewer: { conversation_id: 'conv-abcdef123', casts: 3, ultimo_cast: '2026-09-10T05:00:00.000Z' },
          fantasma: { conversation_id: 'conv-viejo', casts: 1 }
        }
      }), 'utf8');

      crearEscritorDeEstado(repo, 'lote-ag', [{ id: 'solo' }]).iniciar({ ramaBase: 'x', concurrencia: 1 });
      const lanzado = await levantarConHome(repo, 'lote-ag', home);
      servidor = lanzado.servidor;
      const { puerto, token } = lanzado;

      // --- la pagina ---
      check('GET /agents sin token es 403', (await pedir(puerto, '/agents')).status === 403);

      const pagina = await pedir(puerto, '/agents', token);
      check('GET /agents con token responde html',
        pagina.status === 200 && /text\/html/.test(pagina.headers['content-type']));
      check('la página lleva el token', pagina.cuerpo.includes(token));
      check('con lote, ofrece volver a la vista de fan-out', pagina.cuerpo.includes('>fan-out</a>'));
      check('no promete decision gates, que ya no existen',
        !/decision gate/i.test(pagina.cuerpo) && !/aprobar/i.test(pagina.cuerpo));

      // --- la matriz ---
      check('GET /api/agentes sin token es 403', (await pedir(puerto, '/api/agentes')).status === 403);
      const matriz = JSON.parse((await pedir(puerto, '/api/agentes', token)).cuerpo);
      const porNombre = Object.fromEntries(matriz.agentes.map(a => [a.nombre, a]));

      check('lista los agentes del registro y del estado', matriz.agentes.length === 2);
      check('trae el SKILL del registrado', porNombre.reviewer.skill === 'agency-code-reviewer');
      check('marca read-only', porNombre.reviewer.readOnly === true);
      check('trae el hilo y la cuenta de casts',
        porNombre.reviewer.conversationId === 'conv-abcdef123' && porNombre.reviewer.casts === 3);
      check('un agente con hilo pero sin registro sale como huérfano',
        porNombre.fantasma.enRegistro === false && porNombre.fantasma.estado === 'huerfano');

      // Que no se pueda consultar agy no puede pintar a todos en rojo como si
      // no resolvieran: es una mentira alarmante. Se informa aparte.
      check('avisa que no se pudo consultar agy', matriz.agyDisponible === false);
      check('y explica por qué', typeof matriz.motivoAgy === 'string' && matriz.motivoAgy.length > 0);

      // --- el criterio ---
      check('GET /api/agentes/criterio sin token es 403',
        (await pedir(puerto, '/api/agentes/criterio?agente=reviewer')).status === 403);

      const malo = await pedir(puerto, '/api/agentes/criterio?agente=' + encodeURIComponent('../../evil'), token);
      check('rechaza un nombre de agente que se escapa', malo.status === 400, String(malo.status));

      // Sin servicio de memoria en el home falso, degrada en vez de romper.
      const criterio = JSON.parse((await pedir(puerto, '/api/agentes/criterio?agente=reviewer', token)).cuerpo);
      check('sin servicio de memoria responde ok:false, no un 500', criterio.ok === false);
      check('y dice por qué', /memoria/i.test(criterio.motivo || ''));
    } finally {
      if (servidor) await new Promise(r => servidor.close(r));
      borrar(repo);
      borrar(home);
    }
  });

  await group('FEAT-023: el visor arranca aunque no haya ningún lote de fan-out', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-sinlote-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-sinhome-'));
    let servidor;
    try {
      const lanzado = await levantarConHome(repo, null, home);
      servidor = lanzado.servidor;
      const { puerto, token } = lanzado;

      // Antes de FEAT-023 esto era imposible: main() salía con error sin lote,
      // así que la vista de agentes quedaba inalcanzable en un repo donde nunca
      // se corrió un fan-out.
      const raiz = await pedir(puerto, '/', token);
      check('sin lote, la raíz sirve directamente los agentes',
        raiz.status === 200 && raiz.cuerpo.includes('agentes persistidos'));
      check('y no ofrece una pestaña de fan-out que no existe',
        !raiz.cuerpo.includes('>fan-out</a>'));

      const matriz = JSON.parse((await pedir(puerto, '/api/agentes', token)).cuerpo);
      check('la matriz vacía no es un error', Array.isArray(matriz.agentes) && matriz.agentes.length === 0);
    } finally {
      if (servidor) await new Promise(r => servidor.close(r));
      borrar(repo);
      borrar(home);
    }
  });

  process.exit(report() ? 0 : 1);


}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
