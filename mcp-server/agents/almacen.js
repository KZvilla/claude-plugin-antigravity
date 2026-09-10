/**
 * Lectura y escritura de los JSON de los agentes persistidos.
 *
 * POR QUE ESTE MODULO EXISTE
 * --------------------------
 * `registry.js` y `estado.js` nacieron los dos con el mismo par de defectos, y
 * juntos borran datos en silencio:
 *
 *   1. La ruta temporal era estatica (`<archivo>.tmp`). Dos escrituras
 *      concurrentes colisionan en el mismo temporal, y en Windows el rename
 *      falla con EPERM/EBUSY si otro descriptor lo tiene tomado.
 *   2. La lectura hacia `catch { return { agents: {} } }`. O sea que un archivo
 *      a medio escribir se leia como "no hay ningun agente" — y el escritor,
 *      que hace read-modify-write, guardaba ese vacio encima. Un solo parseo
 *      fallido borraba los hilos de TODOS los agentes.
 *
 * Reproducido: con reviewer, security y planner registrados, truncar el archivo
 * y llamar a `registrarCast('planner')` dejaba solo a planner. Los otros dos
 * hilos desaparecian sin un solo mensaje.
 *
 * La correccion tiene dos mitades, y la segunda es la que importa:
 *
 *   - Temporal unico por escritura, con reintento para el rename en Windows.
 *   - **Un archivo ilegible no se pisa nunca.** Leer distingue "no existe"
 *     (arrancar vacio esta bien) de "existe y no se entiende" (algo hay ahi
 *     adentro). En el segundo caso el escritor primero lo aparta como
 *     `.corrupto-<timestamp>` y recien despues escribe. Se pierde el contenido
 *     de la sesion, pero queda en disco para recuperarlo a mano, y el fallo
 *     deja rastro en vez de evaporar datos.
 */

const fs = require('node:fs');
const path = require('node:path');

const REINTENTOS_RENAME = 5;

/**
 * Devuelve `{ datos, ilegible }`.
 *
 * `datos` es `null` cuando no hay nada utilizable. `ilegible` en `true`
 * significa "el archivo existe pero no se pudo interpretar": el llamador que
 * vaya a escribir tiene que tratarlo como contenido a preservar, no como
 * ausencia.
 */
function leerJson(ruta) {
  let crudo;
  try {
    crudo = fs.readFileSync(ruta, 'utf8');
  } catch (err) {
    // Que no exista es el caso normal la primera vez. Cualquier otro error
    // (permisos, archivo tomado) SI es un archivo que no queremos pisar.
    return { datos: null, ilegible: err.code !== 'ENOENT' };
  }

  if (!crudo.trim()) return { datos: null, ilegible: false };

  try {
    return { datos: JSON.parse(crudo), ilegible: false };
  } catch {
    return { datos: null, ilegible: true };
  }
}

/**
 * Escritura atomica que no destruye lo que no entiende.
 *
 * `ilegible` viene del `leerJson` que precedio a esta escritura: si es `true`,
 * el archivo actual se aparta antes de escribir el nuevo.
 */
function guardarJson(ruta, datos, { ilegible = false } = {}) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });

  if (ilegible && fs.existsSync(ruta)) {
    const respaldo = `${ruta}.corrupto-${Date.now()}`;
    try {
      fs.renameSync(ruta, respaldo);
      process.stderr.write(
        `[lagrange] ${path.basename(ruta)} era ilegible y se apartó como `
        + `${path.basename(respaldo)} en vez de sobrescribirlo.\n`
      );
    } catch {
      // Si ni siquiera se puede apartar, no se escribe: mejor fallar ruidoso
      // que borrar.
      throw new Error(
        `${ruta} es ilegible y no se pudo apartar. No se sobrescribe para no perder datos.`
      );
    }
  }

  // Temporal unico por escritura: con uno estatico, dos procesos concurrentes
  // se pisan el archivo intermedio.
  const temporal = `${ruta}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(temporal, JSON.stringify(datos, null, 2), 'utf8');

  // En Windows el rename sobre un destino que otro proceso tiene abierto tira
  // EPERM/EBUSY. Es transitorio: reintentar alcanza.
  let ultimoError;
  for (let intento = 0; intento < REINTENTOS_RENAME; intento++) {
    try {
      fs.renameSync(temporal, ruta);
      return;
    } catch (err) {
      ultimoError = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      // Espera activa corta: son milisegundos y no vale traer async hasta acá.
      const hasta = Date.now() + 20 * (intento + 1);
      while (Date.now() < hasta) { /* esperar */ }
    }
  }

  try { fs.unlinkSync(temporal); } catch {}
  throw ultimoError;
}

module.exports = { leerJson, guardarJson };
