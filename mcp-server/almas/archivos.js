/**
 * FEAT-041 — Exclusión entre procesos y escritura atómica para los archivos
 * del alma.
 *
 * Varios procesos escriben estos archivos: el MCP, el bot de Telegram y el
 * consolidador desacoplado de la charla. `usuario.md` además es de todas las
 * almas. Hacen falta las dos protecciones, y ninguna alcanza sola:
 *
 *   - El lock cubre el ciclo leer-modificar-escribir. Sin él, dos procesos leen
 *     la misma versión y el segundo pisa lo que agregó el primero.
 *   - La escritura atómica (temporal + rename) evita que un lector vea un
 *     archivo a medio escribir.
 *
 * El lock es el mismo patrón que `acquireStateLock` en
 * `telegram-bridge/state.js`, con una diferencia deliberada: si vence la
 * espera, `state.js` escribe sin exclusión (un mal menor para su volcado
 * entero); acá se lanza `ErrorLock` y la función no corre. Escribir sin lock
 * sería perder recuerdos en silencio.
 */

const fs = require('node:fs');
const path = require('node:path');

const LOCK_ESPERA_MS = 2000;
const LOCK_OBSOLETO_MS = 5000;
const REINTENTOS_RENAME = 5;

class ErrorLock extends Error {
  constructor(ruta) {
    super(`Otro proceso está escribiendo ${path.basename(ruta)}. Reintentá en unos segundos.`);
    this.name = 'ErrorLock';
    this.code = 'ELOCK';
  }
}

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Corre `fn` (sincrónica) con el lock de `ruta` tomado. Lanza `ErrorLock` si
 * no lo consigue a tiempo; en ese caso `fn` no corre.
 */
function conLock(ruta, fn, opciones = {}) {
  const espera = opciones.esperaMs ?? LOCK_ESPERA_MS;
  const obsoleto = opciones.obsoletoMs ?? LOCK_OBSOLETO_MS;
  // Sin el directorio, openSync da ENOENT en un alma nueva.
  fs.mkdirSync(path.dirname(ruta), { recursive: true });

  const lock = `${ruta}.lock`;
  const limite = Date.now() + espera;
  let fd = null;

  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      // Un lock abandonado (proceso muerto a mitad de ciclo) no puede trabar
      // el alma para siempre. Un ciclo real dura milisegundos.
      if (Date.now() - fs.statSync(lock).mtimeMs > obsoleto) {
        fs.unlinkSync(lock);
        continue;
      }
    } catch {
      // El lock desapareció entre el open y el stat: reintentar ya.
      if (Date.now() < limite) continue;
    }
    if (Date.now() >= limite) throw new ErrorLock(ruta);
    dormir(20);
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

/** Temporal único y rename, con reintento ante los bloqueos transitorios de Windows. */
function escribirAtomico(ruta, texto) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const temporal = `${ruta}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(temporal, texto, 'utf8');

  let ultimoError;
  for (let intento = 0; intento < REINTENTOS_RENAME; intento++) {
    try {
      fs.renameSync(temporal, ruta);
      return;
    } catch (err) {
      ultimoError = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      dormir(20 * (intento + 1));
    }
  }
  try { fs.unlinkSync(temporal); } catch {}
  throw ultimoError;
}

/**
 * `''` si el archivo no existe. Cualquier otro error se propaga: un archivo que
 * no se pudo leer no se reescribe, porque reescribirlo lo borraría.
 */
function leerTexto(ruta) {
  try {
    return fs.readFileSync(ruta, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

module.exports = { LOCK_ESPERA_MS, LOCK_OBSOLETO_MS, ErrorLock, conLock, escribirAtomico, leerTexto };
