/**
 * FEAT-041 — Almas: identidad y memoria de las voces del plugin.
 * Diseño en docs/future-implementations/almas.md (local, no versionado).
 *
 * Fase 0: capa de datos. Ninguna superficie la usa todavía; la tool
 * `agy_alma` permite verla y manejarla.
 */

module.exports = {
  rutas: require('./rutas.js'),
  archivos: require('./archivos.js'),
  escaneo: require('./escaneo.js'),
  recuerdos: require('./recuerdos.js'),
  diario: require('./diario.js'),
  semilla: require('./semilla.js'),
  agente: require('./agente.js'),
  contexto: require('./contexto.js'),
  bloque: require('./bloque.js'),
  hilos: require('./hilos.js'),
  charla: require('./charla.js'),
  consolidar: require('./consolidar.js')
};
