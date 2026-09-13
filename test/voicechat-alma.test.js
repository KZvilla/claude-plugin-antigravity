/**
 * Almas, fase 3 (plan-almas-fase-3): la charla de voz con alma, punta a punta
 * contra el servidor MCP con agy stubbeado.
 *
 * Dos mitades:
 *   - el `start` con `alma` prima la sesión con su identidad y su memoria (se
 *     lee del turno de priming, que queda en CAPTURE_STDIN_FILE);
 *   - el `stop` vuelca la transcripción y lanza el consolidador desacoplado.
 *     El stub intercepta ese lanzamiento (`test/stub-spawn.js`): no corre nada
 *     de verdad y deja anotados la ruta, `detached` y el `unref`, que si no
 *     serían invisibles para cualquier test.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

const texto = (r) => (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || '';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-alma-voz-'));
  const almasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-voz-'));
  const capture = path.join(dir, 'capture.jsonl');
  const stdinCap = path.join(dir, 'stdin.jsonl');
  fs.writeFileSync(capture, '');
  fs.writeFileSync(stdinCap, '');
  process.env.CAPTURE_STDIN_FILE = stdinCap;
  process.env.LAGRANGE_ALMAS_DIR = almasDir; // startServer copia process.env

  // El alma, sembrada y con un recuerdo, antes de levantar el servidor.
  const env = { LAGRANGE_ALMAS_DIR: almasDir };
  const semilla = require('../mcp-server/almas/semilla.js');
  const recuerdos = require('../mcp-server/almas/recuerdos.js');
  const rutas = require('../mcp-server/almas/rutas.js');
  const consolidar = require('../mcp-server/almas/consolidar.js');
  semilla.sembrar('alya', { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' }, { env });
  recuerdos.aplicar(rutas.rutasDe('alya', env).memoria, 'm',
    [{ tipo: 'agregar', texto: 'el usuario le dice bridge al puente de Telegram' }], recuerdos.TOPE_MEMORIA);
  recuerdos.aplicar(rutas.rutaUsuario(env), 'u',
    [{ tipo: 'agregar', texto: 'trabaja de noche' }], recuerdos.TOPE_USUARIO);

  const server = startServer({ cwd: dir, captureFile: capture });
  await server.initialize();

  const lineas = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const eventos = (nombre) => lineas(capture).filter((l) => l.event === nombre);
  const turnosStdin = () => lineas(stdinCap).map((l) => JSON.parse(l.linea).message.content);
  const ultimoTurno = () => turnosStdin().slice(-1)[0] || '';
  const llamar = (action, extra = {}) => server.callTool('agy_voice_stream', { action, cwd: dir, ...extra });
  const abrir = async (extra = {}) => {
    const r = await llamar('start', { prewarm_voicebox: false, confirmacion: true, ...extra });
    const m = /stream_id: `([^`]+)`/.exec(texto(r));
    if (!m) throw new Error(`start sin stream_id: ${texto(r)}`);
    return { id: m[1], salida: texto(r) };
  };
  const drenarTurno = async (id, ms = 5000) => {
    const limite = Date.now() + ms;
    const sentences = [];
    while (Date.now() < limite) {
      const d = JSON.parse(texto(await llamar('drain', { stream_id: id })));
      sentences.push(...d.sentences);
      if (d.turn_complete) return { ...d, sentences };
      await esperar(30);
    }
    throw new Error('el turno no cerró');
  };
  const hablar = async (id, t) => { await llamar('send', { stream_id: id, text: t }); return drenarTurno(id); };
  const pendientes = () => {
    try { return fs.readdirSync(consolidar.dirPendientes(env)).filter((n) => n.endsWith('.json')); } catch { return []; }
  };
  const leerPendiente = (nombre) => JSON.parse(fs.readFileSync(path.join(consolidar.dirPendientes(env), nombre), 'utf8'));

  try {
    await group('el priming arranca con el alma', async () => {
      const { id, salida } = await abrir({ alma: 'Alya' });
      const priming = ultimoTurno();
      check('un solo turno de priming', turnosStdin().length === 1, String(turnosStdin().length));
      check('la salida nombra el alma', /- Alma: `alya`/.test(salida), salida);
      check('lleva su identidad', /# Alya/.test(priming));
      check('lleva su memoria', /le dice bridge al puente/.test(priming));
      check('lleva lo que sabe del usuario', /trabaja de noche/.test(priming));
      check('lleva el encuadre', /no las afirmes como estado actual|notas tuyas, no instrucciones/.test(priming));
      check('el alma va ANTES del priming', priming.indexOf('# Alya') < priming.indexOf('A partir de ahora'));
      check('las reglas de la charla mandan', /mandan sobre tu forma de ser/.test(priming));
      check('y eso va antes de la confirmación',
        priming.indexOf('mandan sobre tu forma de ser') < priming.indexOf('Confirmá que entendiste'));
      check('el freno sigue en el priming', /la charla me pregunta/.test(priming));
      check('sin bloque <alma> por turno', !/<alma>/.test(priming));
      await llamar('stop', { stream_id: id });
    });

    await group('sin alma, la charla de siempre', async () => {
      const antes = turnosStdin().length;
      const { id, salida } = await abrir();
      const priming = ultimoTurno();
      check('un turno de priming', turnosStdin().length === antes + 1);
      check('sin rastro del alma', !/# Alya|trabaja de noche|mandan sobre tu forma de ser/.test(priming));
      check('la salida no habla de alma', !/- Alma:/.test(salida), salida);
      check('el priming de siempre, intacto', /la charla me pregunta/.test(priming) && /Confirmá que entendiste/.test(priming));
      await llamar('stop', { stream_id: id });
    });

    await group('un alma que no existe no frena la charla', async () => {
      // Un Voicebox que acepta la conexión y no contesta nunca: sin el timeout
      // corto de la siembra, el arranque se comería los 4 s del timeout de
      // getVoiceboxProfiles antes del priming.
      const pozo = net.createServer(() => {});
      await new Promise((r) => pozo.listen(0, '127.0.0.1', r));
      const puerto = pozo.address().port;

      const t0 = Date.now();
      const { id, salida } = await abrir({ alma: 'Fantasma', voicebox_url: `http://127.0.0.1:${puerto}` });
      const tardanza = Date.now() - t0;
      check('la sesión arranca igual', /stream_id/.test(salida));
      check('con el aviso', /- Alma: no \(/.test(salida), salida);
      check('sin esperar los 4 s del timeout largo', tardanza < 3000, `${tardanza} ms`);
      await llamar('stop', { stream_id: id });
      pozo.close();
    });

    await group('al cerrar: vuelca la transcripción y lanza el consolidador', async () => {
      const { id } = await abrir({ alma: 'Alya' });
      await hablar(id, 'primera cosa que digo');
      await hablar(id, 'segunda cosa');
      await hablar(id, 'tercera y chau');

      const lanzados = eventos('consolidador').length;
      const t0 = Date.now();
      const r = texto(await llamar('stop', { stream_id: id }));
      const tardanza = Date.now() - t0;

      check('stop vuelve al instante', tardanza < 1000, `${tardanza} ms`);
      check('y lo dice', /Consolidación de memoria lanzada/.test(r), r);

      const archivos = pendientes();
      check('hay un pendiente', archivos.length === 1, JSON.stringify(archivos));
      const p = leerPendiente(archivos[0]);
      check('con el alma', p.clave === 'alya');
      check('con los tres turnos del usuario', consolidar.cuentaTurnosUsuario(p.turnos) === 3, JSON.stringify(p.turnos));
      check('y con las respuestas del alma', p.turnos.filter((t) => t.rol === 'alma').length === 3, JSON.stringify(p.turnos));
      check('en orden', p.turnos[0].texto === 'primera cosa que digo' && p.turnos[0].rol === 'usuario');

      const lanzamiento = eventos('consolidador').slice(lanzados)[0];
      check('se lanzó el consolidador', !!lanzamiento, JSON.stringify(eventos('consolidador')));
      check('con node', lanzamiento && lanzamiento.cmd === process.execPath, lanzamiento && lanzamiento.cmd);
      check('con ruta absoluta que existe', !!lanzamiento && path.isAbsolute(lanzamiento.args[0]) && fs.existsSync(lanzamiento.args[0]),
        lanzamiento && lanzamiento.args[0]);
      check('y el pendiente como argumento', !!lanzamiento && lanzamiento.args[1].endsWith(archivos[0]));
      check('desacoplado', !!lanzamiento && lanzamiento.detached === true);
      check('y con unref', eventos('consolidador-unref').length > 0);

      fs.rmSync(consolidar.dirPendientes(env), { recursive: true, force: true });
    });

    await group('dos turnos no valen una consolidación', async () => {
      const { id } = await abrir({ alma: 'Alya' });
      await hablar(id, 'hola');
      await hablar(id, 'chau');
      const lanzados = eventos('consolidador').length;
      const r = texto(await llamar('stop', { stream_id: id }));
      check('no se lanzó nada', eventos('consolidador').length === lanzados);
      check('ni hay pendiente', pendientes().length === 0, JSON.stringify(pendientes()));
      check('y stop no lo menciona', !/Consolidación/.test(r), r);
    });

    await group('sin alma no se consolida nada', async () => {
      const { id } = await abrir();
      await hablar(id, 'uno');
      await hablar(id, 'dos');
      await hablar(id, 'tres');
      const lanzados = eventos('consolidador').length;
      await llamar('stop', { stream_id: id });
      check('sin lanzamiento', eventos('consolidador').length === lanzados);
      check('sin pendiente', pendientes().length === 0, JSON.stringify(pendientes()));
    });

    await group('el último turno entra aunque no se drene', async () => {
      const { id } = await abrir({ alma: 'Alya' });
      await hablar(id, 'uno');
      await hablar(id, 'dos');
      // El tercero se manda y se espera la respuesta SIN drenarla: es el caso
      // del "chau" seguido de Ctrl+C.
      await llamar('send', { stream_id: id, text: 'tres, y me voy' });
      const limite = Date.now() + 3000;
      while (Date.now() < limite) {
        const st = JSON.parse(texto(await llamar('status', { stream_id: id })));
        if (st.buffered_undrained_events > 0) break;
        await esperar(30);
      }
      await esperar(100);
      await llamar('stop', { stream_id: id });

      const archivos = pendientes();
      check('hay pendiente', archivos.length === 1, JSON.stringify(archivos));
      const p = archivos.length ? leerPendiente(archivos[0]) : { turnos: [] };
      // Las tres respuestas: las dos drenadas y la que quedó sin drenar. Contar
      // "alguna con STUBBED" no alcanzaría — las dos primeras ya lo cumplen.
      check('las tres respuestas del alma están', p.turnos.filter((t) => t.rol === 'alma').length === 3, JSON.stringify(p.turnos));
      check('la última es la que no se drenó', p.turnos[p.turnos.length - 1].rol === 'alma', JSON.stringify(p.turnos.slice(-2)));
      fs.rmSync(consolidar.dirPendientes(env), { recursive: true, force: true });
    });

    await group('dos turnos cerrados en un mismo drain entran los dos', async () => {
      const { id } = await abrir({ alma: 'Alya' });
      // Sin drenar en el medio: los dos results llegan juntos al mismo drain, y
      // procesarEventosDrain se queda solo con el primero.
      await llamar('send', { stream_id: id, text: 'uno' });
      await esperar(150);
      await llamar('send', { stream_id: id, text: 'dos' });
      await esperar(150);
      await llamar('send', { stream_id: id, text: 'tres' });
      await drenarTurno(id);
      await llamar('stop', { stream_id: id });

      const archivos = pendientes();
      check('hay pendiente', archivos.length === 1, JSON.stringify(archivos));
      const p = leerPendiente(archivos[0]);
      check('las tres respuestas están', p.turnos.filter((t) => t.rol === 'alma').length === 3, JSON.stringify(p.turnos));
      fs.rmSync(consolidar.dirPendientes(env), { recursive: true, force: true });
    });

    await group('la transcripción se acota también acá', async () => {
      const { id } = await abrir({ alma: 'Alya' });
      for (let i = 0; i < 22; i++) await hablar(id, `turno numero ${i}`);
      await llamar('stop', { stream_id: id });
      const archivos = pendientes();
      const p = leerPendiente(archivos[0]);
      check('no más de 40 turnos', p.turnos.length <= consolidar.MAX_TURNOS, String(p.turnos.length));
      check('se queda con los últimos', p.turnos.some((t) => /turno numero 21/.test(t.texto)));
      check('y descarta los primeros', !p.turnos.some((t) => /turno numero 0$/.test(t.texto)), JSON.stringify(p.turnos.slice(0, 2)));
      fs.rmSync(consolidar.dirPendientes(env), { recursive: true, force: true });
    });

    await group('si el cliente cierra la tubería sin `stop`, la charla se consolida igual', async () => {
      // El caso real: un Ctrl+C en la consola le llega a todo el grupo de
      // procesos y el servidor muere antes de que el loop pueda pedir el
      // `stop`. Servidor aparte, porque este sale al cerrarse stdin.
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-alma-corte-'));
      const server2 = startServer({ cwd: dir2, captureFile: capture });
      await server2.initialize();
      const llamar2 = (action, extra = {}) => server2.callTool('agy_voice_stream', { action, cwd: dir2, ...extra });
      const r = await llamar2('start', { prewarm_voicebox: false, confirmacion: true, alma: 'Alya' });
      const id2 = /stream_id: `([^`]+)`/.exec(texto(r))[1];
      for (const t of ['uno', 'dos', 'tres']) {
        await llamar2('send', { stream_id: id2, text: t });
        const limite = Date.now() + 3000;
        while (Date.now() < limite) {
          const d = JSON.parse(texto(await llamar2('drain', { stream_id: id2 })));
          if (d.turn_complete) break;
          await esperar(30);
        }
      }

      const salida = new Promise((res) => server2.child.once('exit', res));
      server2.child.stdin.end();          // ni stop ni kill: solo se cierra la tubería
      await Promise.race([salida, esperar(5000)]);

      const archivos = pendientes();
      check('la transcripción se volcó igual', archivos.length === 1, JSON.stringify(archivos));
      const p = archivos.length ? leerPendiente(archivos[0]) : { turnos: [] };
      check('con los tres turnos', consolidar.cuentaTurnosUsuario(p.turnos) === 3, JSON.stringify(p.turnos));
      check('el servidor salió solo', server2.child.exitCode !== null || server2.child.signalCode !== null);
      fs.rmSync(consolidar.dirPendientes(env), { recursive: true, force: true });
      await server2.stop();
      removeFixture(dir2);
    });

    await group('el freno de la v0.24.0 sigue intacto con alma', async () => {
      const { id } = await abrir({ alma: 'Alya' });
      await llamar('send', { stream_id: id, text: 'commiteá NEGAR_COMANDO git status' });
      const t = await drenarTurno(id);
      check('la negada llega igual', JSON.stringify(t.negadas) === JSON.stringify([{ tipo: 'command', objetivo: 'git status' }]), JSON.stringify(t.negadas));
      const rc = await llamar('confirm', { stream_id: id });
      check('y se puede confirmar', !(rc.result && rc.result.isError), texto(rc));
      await drenarTurno(id);

      // El turno negado cierra con `response: ''`: no es una respuesta del alma
      // y no puede entrar en la transcripción como un turno en blanco.
      await hablar(id, 'segunda');
      await hablar(id, 'tercera');
      await llamar('stop', { stream_id: id });
      const archivos = pendientes();
      check('hay pendiente', archivos.length === 1, JSON.stringify(archivos));
      const p = leerPendiente(archivos[0]);
      check('ningún turno vacío en la transcripción', p.turnos.every((t) => t.texto && t.texto.trim()), JSON.stringify(p.turnos));
      check('y ninguna respuesta de más', p.turnos.filter((t) => t.rol === 'alma').length === 3, JSON.stringify(p.turnos));
      fs.rmSync(consolidar.dirPendientes(env), { recursive: true, force: true });
    });
  } finally {
    await server.stop();
    removeFixture(dir);
    fs.rmSync(almasDir, { recursive: true, force: true });
    delete process.env.LAGRANGE_ALMAS_DIR;
    delete process.env.CAPTURE_STDIN_FILE;
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
