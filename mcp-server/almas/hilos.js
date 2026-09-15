/**
 * FEAT-043 — El hilo de chat de cada alma.
 *
 * Un hilo dura mientras la charla siga viva: pasadas 6 h sin turnos se abre uno
 * nuevo. La continuidad larga no la da el hilo sino la memoria y el diario, que
 * se inyectan cuando el hilo nace (snapshot congelado, RFC §4.2).
 *
 * El archivo es JSON y se lee y escribe con `agents/almacen.js`, que aparta un
 * archivo ilegible en vez de pisarlo.
 */

const path = require('node:path');
const { leerJson, guardarJson } = require('../agents/almacen.js');
const { dirAlmas, validarClave } = require('./rutas.js');

const VENTANA_MS = 6 * 60 * 60 * 1000;

function rutaEstado(env = process.env) {
  return path.join(dirAlmas(env), 'estado.json');
}

function leerEstado(env) {
  const { datos, ilegible } = leerJson(rutaEstado(env));
  const estado = datos && typeof datos.almas === 'object' && datos.almas ? datos : { almas: {} };
  Object.defineProperty(estado, '_ilegible', { value: ilegible, enumerable: false });
  return estado;
}

function guardar(estado, env) {
  guardarJson(rutaEstado(env), { almas: estado.almas }, { ilegible: estado._ilegible });
}

/** El hilo vigente de un alma, o `null` si no hay o si venció la ventana. */
function hiloDe(clave, { ventanaMs = VENTANA_MS, ahora = Date.now(), env = process.env } = {}) {
  validarClave(clave);
  const entrada = leerEstado(env).almas[clave];
  if (!entrada || !entrada.conversation_id) return null;
  const ultimo = Date.parse(entrada.ultimo_turno || '');
  if (!Number.isFinite(ultimo)) return entrada.conversation_id;
  return ahora - ultimo > ventanaMs ? null : entrada.conversation_id;
}

/** Anota el turno y su hilo. Se llama aunque el turno haya fallado: perder el hilo obliga a empezar de cero. */
function registrarTurno(clave, { conversationId } = {}, env = process.env) {
  validarClave(clave);
  const estado = leerEstado(env);
  const previo = estado.almas[clave] || {};
  estado.almas[clave] = {
    ...previo,
    conversation_id: conversationId || previo.conversation_id || null,
    ultimo_turno: new Date().toISOString(),
    turnos: (previo.turnos || 0) + 1
  };
  guardar(estado, env);
  return estado.almas[clave];
}

/** Olvida el hilo (no la memoria): el próximo turno arranca limpio y relee el contexto. */
function olvidarHilo(clave, env = process.env) {
  validarClave(clave);
  const estado = leerEstado(env);
  const previo = estado.almas[clave];
  if (!previo || !previo.conversation_id) return false;
  estado.almas[clave] = { ...previo, conversation_id: null };
  guardar(estado, env);
  return true;
}

/**
 * ¿Este `conversation_id` es el hilo de un alma?
 *
 * La misma defensa que `castAgentes.esHiloDeAgente`: el bot se niega a retomar
 * un hilo así por una vía que no pase por `--agent`, porque correría con el
 * agente por defecto —con escritura— sobre un hilo que nació sin tools.
 */
function esHiloDeAlma(conversationId, env = process.env) {
  if (!conversationId) return false;
  return Object.values(leerEstado(env).almas).some(a => a && a.conversation_id === conversationId);
}

module.exports = { VENTANA_MS, rutaEstado, leerEstado, hiloDe, registrarTurno, olvidarHilo, esHiloDeAlma };
