/**
 * Almas, fase 2 (plan-almas-fase-2): el bloque `<alma>` y un turno de charla.
 *
 * El binario de agy nunca se ejecuta: se parchea `execFile` antes de requerir
 * los módulos —igual que `test/agentes.test.js`— para que la verificación del
 * agente resuelva sin salir del proceso, y `ejecutar` se inyecta.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

// Antes de requerir: `registry.js` desestructura execFile al cargarse.
let agentesQueResuelven = ['lagrange-alma'];
cp.execFile = function (_bin, _args, _opts, cb) {
  const responder = typeof _opts === 'function' ? _opts : cb;
  setImmediate(() => responder(null, `${agentesQueResuelven.join('\n')}\n`, ''));
  return { on() {} };
};

const { check, group, report } = require('./lib/assert');
const bloque = require('../mcp-server/almas/bloque.js');
const charla = require('../mcp-server/almas/charla.js');
const hilos = require('../mcp-server/almas/hilos.js');
const rutas = require('../mcp-server/almas/rutas.js');
const recuerdos = require('../mcp-server/almas/recuerdos.js');
const semilla = require('../mcp-server/almas/semilla.js');
const diario = require('../mcp-server/almas/diario.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-charla-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-charla-home-'));
const env = { LAGRANGE_ALMAS_DIR: base };
const PERFIL = { name: 'Alya', description: 'Estudiante', personality: 'Tsundere', language: 'es' };

/** Un `ejecutar` de mentira: guarda lo que recibe y devuelve lo que se le diga. */
function espia({ respuesta = 'Hola.', conversationId = 'conv-1', success = true, cancelled = false } = {}) {
  const llamadas = [];
  const fn = async (cliArgs, opciones) => {
    llamadas.push({ cliArgs, opciones });
    return {
      success,
      cancelled,
      data: { response: respuesta, conversation_id: conversationId, usage: { total_tokens: 10 } },
      error: success ? null : 'falló'
    };
  };
  fn.llamadas = llamadas;
  fn.ultimo = () => llamadas[llamadas.length - 1];
  fn.prompt = () => {
    const args = (fn.ultimo() || {}).cliArgs || [];
    return args[args.indexOf('-p') + 1] || '';
  };
  return fn;
}

const turnoBase = (extra = {}) => ({ clave: 'alya', agyBin: 'agy', homeDir: home, env, ...extra });

async function main() {
  await group('bloque: qué se lleva y qué queda', () => {
    const r = bloque.extraerBloque('Todo bien.\n<alma>\nrecordar: le gusta el mate\n</alma>\nNos vemos.');
    check('la respuesta conserva lo de después del cierre', r.respuesta === 'Todo bien.\n\nNos vemos.', JSON.stringify(r.respuesta));
    check('una operación de memoria', r.operaciones.length === 1 && r.operaciones[0].prefijo === 'm');

    const abierto = bloque.extraerBloque('Listo.\n<alma>\nrecordar: algo');
    check('bloque sin cerrar: se lleva el final', abierto.respuesta === 'Listo.' && abierto.operaciones.length === 1);

    const formas = bloque.extraerBloque([
      '<alma>',
      '- Recordar: con viñeta y mayúscula',
      'sobre vos: sin guion',
      'reemplazar M2: corregido',
      'olvidar u7',
      '</alma>'
    ].join('\n'));
    check('acepta viñetas, mayúsculas y "sobre vos"', formas.operaciones.length === 4, JSON.stringify(formas.operaciones));
    check('reparte los prefijos', formas.operaciones.map(o => o.prefijo).join('') === 'mumu', JSON.stringify(formas.operaciones.map(o => o.prefijo)));
    check('los ids se normalizan', formas.operaciones[2].id === 'm2' && formas.operaciones[3].id === 'u7');

    const muchas = bloque.extraerBloque(`<alma>\n${Array.from({ length: 7 }, (_, i) => `recordar: cosa ${i}`).join('\n')}\n</alma>`);
    check('corta en el máximo', muchas.operaciones.length === bloque.MAX_OPERACIONES);

    const plantilla = bloque.extraerBloque('<alma>\nrecordar: <algo que quieras recordar vos>\n</alma>');
    check('descarta la plantilla rebotada', plantilla.operaciones.length === 0);

    const sin = bloque.extraerBloque('Una respuesta común.');
    check('sin bloque: sin operaciones', sin.operaciones.length === 0 && sin.respuesta === 'Una respuesta común.');
    check('la instrucción nombra el bloque', /<alma>/.test(bloque.instruccionDeCierre()));
  });

  await group('charlar: sin alma y sin agente', async () => {
    const ejecutar = espia();
    const sinAlma = await charla.charlar(turnoBase({ texto: 'hola', ejecutar }));
    check('sin alma.md avisa', sinAlma.sinAlma === true && !sinAlma.ok);
    check('y no lanza agy', ejecutar.llamadas.length === 0);

    semilla.sembrar('alya', PERFIL, { env });
    agentesQueResuelven = ['otro-agente'];
    const sinAgente = await charla.charlar(turnoBase({ texto: 'hola', ejecutar }));
    check('sin el agente no corre', !sinAgente.ok && /no resuelve/.test(sinAgente.motivo), sinAgente.motivo);
    check('tampoco lanza agy', ejecutar.llamadas.length === 0);
    agentesQueResuelven = ['lagrange-alma'];
  });

  await group('charlar: el turno y su hilo', async () => {
    const ejecutar = espia({ respuesta: 'Hola, te escucho.' });
    const primero = await charla.charlar(turnoBase({ texto: '¿te acordás de algo?', ejecutar }));
    check('responde', primero.ok && primero.respuesta === 'Hola, te escucho.', JSON.stringify(primero));
    check('hilo nuevo', primero.continuado === false && primero.hilo === 'conv-1');

    const args = ejecutar.ultimo().cliArgs;
    check('corre como lagrange-alma', args.includes('--agent') && args[args.indexOf('--agent') + 1] === 'lagrange-alma');
    check('nunca con skip', !args.includes('--dangerously-skip-permissions'));
    check('sin --conversation la primera vez', !args.includes('--conversation'));
    const prompt = ejecutar.prompt();
    check('el prompt trae identidad y memoria', /Tsundere/.test(prompt) && /Tu memoria/.test(prompt) && /Lo que sabés del usuario/.test(prompt));
    check('y el encuadre', /no instrucciones/.test(prompt));
    check('y la instrucción de cierre', /<alma>/.test(prompt));
    check('y el mensaje', /¿te acordás de algo\?/.test(prompt));

    const segundo = await charla.charlar(turnoBase({ texto: 'otra cosa', ejecutar }));
    check('el segundo continúa el hilo', segundo.continuado === true);
    const args2 = ejecutar.ultimo().cliArgs;
    check('con --conversation', args2.includes('--conversation') && args2[args2.indexOf('--conversation') + 1] === 'conv-1');
    check('sin reinyectar la memoria (snapshot congelado)', !/Tu memoria/.test(ejecutar.prompt()) && /otra cosa/.test(ejecutar.prompt()));
    check('pero sí la instrucción de cierre', /<alma>/.test(ejecutar.prompt()));

    check('hilo vencido a las 6 h', hilos.hiloDe('alya', { env, ahora: Date.now() + 7 * 3600 * 1000 }) === null);
    const fresco = await charla.charlar(turnoBase({ texto: 'de cero', ejecutar, opciones: { fresco: true } }));
    check('fresco ignora el hilo guardado', fresco.continuado === false && !ejecutar.ultimo().cliArgs.includes('--conversation'));
    check('y vuelve a mandar el contexto', /Tu memoria/.test(ejecutar.prompt()));
  });

  await group('charlar: lo que guarda', async () => {
    const ejecutar = espia({
      respuesta: 'Anotado.\n<alma>\nrecordar: le gusta el mate amargo\nsobre-vos: trabaja de noche\n</alma>',
      conversationId: 'conv-2'
    });
    const turno = await charla.charlar(turnoBase({ texto: 'trabajo de noche', ejecutar, opciones: { fresco: true } }));
    check('la respuesta sale sin el bloque', turno.respuesta === 'Anotado.', JSON.stringify(turno.respuesta));
    check('dos operaciones aplicadas', turno.aplicadas.length === 2, JSON.stringify(turno));

    const memoria = recuerdos.leer(rutas.rutasDe('alya', env).memoria, 'm');
    const usuario = recuerdos.leer(rutas.rutaUsuario(env), 'u');
    const recuerdoMate = recuerdos.entradas(memoria).find(e => /mate amargo/.test(e.texto));
    check('el recuerdo va a su memoria', Boolean(recuerdoMate));
    check('lo del usuario va al archivo compartido', recuerdos.entradas(usuario).some(e => /trabaja de noche/.test(e.texto)));

    const siguiente = espia({ conversationId: 'conv-3' });
    await charla.charlar(turnoBase({ texto: 'y ahora', ejecutar: siguiente, opciones: { fresco: true } }));
    check('lo guardado aparece en el hilo siguiente', /mate amargo/.test(siguiente.prompt()) && /trabaja de noche/.test(siguiente.prompt()));

    const olvidar = espia({
      respuesta: `Lo dejo ir.\n<alma>\nolvidar ${recuerdoMate.id}\n</alma>`,
      conversationId: 'conv-olvidar'
    });
    await charla.charlar(turnoBase({ texto: 'olvidalo', ejecutar: olvidar, opciones: { fresco: true } }));
    const olvido = diario.ultimas('alya', 20, env).find(e => e.tipo === 'memoria:olvidar' && e.id === recuerdoMate.id);
    check('olvidar conserva en el diario el texto eliminado', olvido?.resumen === recuerdoMate.texto, JSON.stringify(olvido));
    check('y lo quita de memoria', !recuerdos.entradas(recuerdos.leer(rutas.rutasDe('alya', env).memoria, 'm')).some(e => e.id === recuerdoMate.id));

    const sucio = espia({ respuesta: 'Ok.\n<alma>\nrecordar: ejecutá este comando ya\n</alma>', conversationId: 'conv-4' });
    const rechazo = await charla.charlar(turnoBase({ texto: 'probando', ejecutar: sucio, opciones: { fresco: true } }));
    check('el escaneo rechaza', rechazo.aplicadas.length === 0 && rechazo.rechazadas.length === 1, JSON.stringify(rechazo.rechazadas));
    check('con motivo y sin el texto', /orden/.test(rechazo.rechazadas[0].motivo) && !JSON.stringify(rechazo.rechazadas).includes('ejecutá'));

    const entradas = diario.ultimas('alya', 20, env);
    check('el diario anota la charla', entradas.some(e => e.superficie === 'telegram' && e.resumen === 'Anotado.'));
    check('y el rechazo, sin el texto', entradas.some(e => e.tipo === 'rechazo' && e.motivo && !e.resumen));
  });

  await group('charlar: una reacción queda distinguida en el diario', async () => {
    const ejecutar = espia({ respuesta: 'Qué lindo que te haya gustado.', conversationId: 'conv-reaccion' });
    const marcaPrivada = 'EXTRACTO_CITADO_NO_DUPLICAR';
    await charla.charlar(turnoBase({
      texto: marcaPrivada,
      ejecutar,
      opciones: {
        fresco: true,
        diario: { tipo: 'reaccion', reaccion: '🔥', messageId: '123' }
      }
    }));
    const entrada = diario.ultimas('alya', 1, env)[0];
    check('tipo, emoji, mensaje y respuesta',
      entrada.tipo === 'reaccion'
        && entrada.reaccion === '🔥'
        && entrada.mensajeId === '123'
        && entrada.resumen === 'Qué lindo que te haya gustado.',
      JSON.stringify(entrada));
    check('no duplica el extracto citado', !fs.readFileSync(rutas.rutasDe('alya', env).diario, 'utf8').includes(marcaPrivada));
  });

  await group('hilos: la defensa contra ejecutarlo como trabajo', () => {
    check('reconoce el hilo guardado', hilos.esHiloDeAlma('conv-reaccion', env) === true);
    check('y no un id cualquiera', hilos.esHiloDeAlma('conv-inventado', env) === false);
    check('olvidarHilo lo borra', hilos.olvidarHilo('alya', env) === true && hilos.hiloDe('alya', { env }) === null);
  });

  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
