/**
 * FEAT-043 — Un turno de charla con un alma.
 *
 * Es la primera superficie donde el alma escribe su memoria, y por eso es la
 * más estricta con el aislamiento: corre SIEMPRE como `lagrange-alma`, el
 * agente sin tools, y si ese agente no resuelve no se lanza nada. No hay
 * camino de respaldo, a diferencia de las narraciones (fase 1): allá el prompt
 * lleva un `alma.md` que escribe el usuario; acá lleva memoria escrita por un
 * modelo, que es el vector de inyección persistente del RFC §6. Degradar al
 * agente por defecto pondría `write_to_file` del otro lado de ese texto.
 *
 * `ejecutar` se inyecta, como en `agents/cast.js`: el bot pasa `runAgyArgs` y
 * los tests un doble, así que este módulo se prueba sin lanzar agy.
 */

const fs = require('node:fs');
const os = require('node:os');
const rutas = require('./rutas.js');
const contexto = require('./contexto.js');
const recuerdos = require('./recuerdos.js');
const diario = require('./diario.js');
const bloque = require('./bloque.js');
const hilos = require('./hilos.js');
const agente = require('./agente.js');

/**
 * Snapshot congelado (RFC §4.2): el contexto entero va solo cuando el hilo
 * nace. En un hilo continuado, agy ya tiene los turnos previos; reinyectar la
 * memoria en cada vuelta duplica tokens y deja conviviendo la versión vieja y
 * la nueva de un recuerdo que se reemplazó a mitad de la charla.
 */
function armarPrompt({ clave, mensaje, hilo, env }) {
  const cierre = bloque.instruccionDeCierre();
  if (hilo) return `${mensaje}\n${cierre}`;
  const ctx = contexto.componerContexto(clave, { conMemoria: true }, env);
  return `${ctx}\n\n---\n\n${mensaje}\n${cierre}`;
}

/**
 * Las operaciones van por archivo: `recuerdos.aplicar` trabaja sobre uno por
 * llamada. Lo comparte la consolidación de la charla de voz (`consolidar.js`):
 * es el mismo reparto entre `memoria.md` y `usuario.md`, con los mismos topes.
 */
function aplicarOperaciones(clave, operaciones, env) {
  const aplicadas = [];
  const rechazadas = [];
  const porArchivo = [
    { prefijo: 'm', ruta: rutas.rutasDe(clave, env).memoria, tope: recuerdos.TOPE_MEMORIA },
    { prefijo: 'u', ruta: rutas.rutaUsuario(env), tope: recuerdos.TOPE_USUARIO }
  ];

  for (const { prefijo, ruta, tope } of porArchivo) {
    const ops = operaciones.filter(o => o.prefijo === prefijo);
    if (!ops.length) continue;
    try {
      const r = recuerdos.aplicar(ruta, prefijo, ops, tope);
      aplicadas.push(...r.aplicadas.map(a => ({ ...a, prefijo })));
      rechazadas.push(...r.rechazadas.map(x => ({ ...x, prefijo })));
    } catch (err) {
      // Un lock ocupado o un archivo ilegible no puede costar la respuesta.
      rechazadas.push({ op: { prefijo }, motivo: err.message });
    }
  }
  return { aplicadas, rechazadas };
}

function anotarEnDiario(clave, { respuesta, rechazadas }, env) {
  try {
    diario.anotar(clave, { superficie: 'telegram', resumen: respuesta }, env);
    for (const r of rechazadas) {
      diario.anotar(clave, { superficie: 'telegram', tipo: 'rechazo', motivo: r.motivo }, env);
    }
  } catch (err) {
    process.stderr.write(`[almas] No se pudo anotar el diario de ${clave}: ${err.message}\n`);
  }
}

/**
 * Un turno. Nunca lanza por un fallo de la charla: devuelve `{ok: false, …}`.
 * Solo lanza por un error de programación del llamante (falta `agyBin` o
 * `ejecutar`), porque sin `agyBin` no se puede verificar el agente y seguir sin
 * verificar es el fail-open que este módulo existe para evitar.
 */
async function charlar({ clave, texto, agyBin, ejecutar, homeDir = os.homedir(), env = process.env, opciones = {} }) {
  if (!agyBin) throw new Error('charlar: falta `agyBin`, sin él no se puede verificar el agente.');
  if (typeof ejecutar !== 'function') throw new Error('charlar: falta `ejecutar`.');
  rutas.validarClave(clave);

  const mensaje = String(texto || '').trim();
  if (!mensaje) return { ok: false, motivo: 'el mensaje está vacío' };
  if (!fs.existsSync(rutas.rutasDe(clave, env).alma)) return { ok: false, sinAlma: true };

  try {
    agente.asegurarAgente(homeDir);
  } catch (err) {
    return { ok: false, motivo: `no se pudo instalar su agent.md (${err.message})` };
  }
  const verificacion = await agente.verificar(agyBin);
  if (!verificacion.ok) return { ok: false, motivo: verificacion.motivo };

  const hilo = opciones.fresco ? null : hilos.hiloDe(clave, { env });
  const prompt = armarPrompt({ clave, mensaje, hilo, env });
  const cliArgs = [
    ...agente.argsBase({ modelo: opciones.model, esfuerzo: opciones.effort }),
    ...(hilo ? ['--conversation', hilo] : []),
    '-p', prompt
  ];

  const inicio = Date.now();
  const resultado = await ejecutar(cliArgs, {
    cwd: opciones.cwd,
    timeoutMinutes: opciones.timeoutMinutes || 5,
    onSpawn: opciones.onSpawn
  });
  const duracion = (Date.now() - inicio) / 1000;

  const datos = resultado.data || {};
  const hiloNuevo = datos.conversation_id || hilo || null;
  if (hiloNuevo) hilos.registrarTurno(clave, { conversationId: hiloNuevo }, env);

  const base = { clave, hilo: hiloNuevo, continuado: Boolean(hilo), duracion, usage: datos.usage || null };
  if (resultado.cancelled) return { ...base, ok: false, cancelled: true, motivo: resultado.error || 'Charla cancelada.' };
  if (!resultado.success) return { ...base, ok: false, motivo: resultado.error || 'La charla falló sin detalle.' };

  const crudo = datos.response || resultado.rawOutput || '';
  const { respuesta, operaciones } = bloque.extraerBloque(crudo);
  const { aplicadas, rechazadas } = aplicarOperaciones(clave, operaciones, env);
  anotarEnDiario(clave, { respuesta, rechazadas }, env);

  return { ...base, ok: true, respuesta: respuesta || '(se quedó sin palabras)', aplicadas, rechazadas };
}

module.exports = { charlar, armarPrompt, aplicarOperaciones };
