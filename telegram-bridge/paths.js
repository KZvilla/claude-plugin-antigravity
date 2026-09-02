/**
 * Ubicación canónica de los datos vivos del bridge (estado y lockfile).
 *
 * El problema que resuelve
 * -----------------------
 * `state.json` y `bridge.lock` se resolvían como `path.join(__dirname, ...)`,
 * es decir, relativos a la carpeta del código que los abre. Eso da por supuesto
 * que solo existe una copia del bridge en la máquina, y no es cierto: el plugin
 * se instala en `~/.claude/plugins/marketplaces/<marketplace>/` mientras que el
 * desarrollo ocurre en el checkout del repositorio. Los dos procesos del bridge
 * no tienen por qué salir de la misma carpeta:
 *
 *   - `bot.js` lo lanza la tarea programada, que apunta al directorio desde el
 *     que se ejecutó `daemon.ps1 install`.
 *   - `notify.js` lo lanza el servidor MCP por spawn, relativo a SU propio
 *     `__dirname`, el del plugin instalado.
 *
 * Con dos `state.json` distintos, el human-in-the-loop no puede funcionar:
 * `telegram_ask` registra la pregunta en un fichero y `bot.js` resuelve el botón
 * contra otro, así que la espera nunca se desbloquea. Y con dos `bridge.lock`
 * distintos, el candado de instancia única deja de valer: ambas copias se creen
 * la primera y Telegram devuelve 409 Conflict a las dos.
 *
 * La invariante correcta no es «un bridge por carpeta» sino «un bridge por
 * máquina y por token», así que estos ficheros pasan a vivir en un directorio
 * de usuario, no junto al código.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Directorio de datos del bridge. Precedencia:
 *   1. `TELEGRAM_BRIDGE_DATA_DIR` (explícito).
 *   2. `%LOCALAPPDATA%\antigravity-telegram-bridge` en Windows.
 *   3. `$XDG_STATE_HOME/antigravity-telegram-bridge` o
 *      `~/.local/state/antigravity-telegram-bridge` en el resto.
 *
 * Se crea si no existe. Si no se puede crear —permisos, disco lleno— se cae al
 * directorio indicado por `fallbackDir`, que es el comportamiento anterior:
 * peor tener el estado partido que no tener bridge.
 */
export function resolveBridgeDataDir(fallbackDir = null) {
  const explicito = (process.env.TELEGRAM_BRIDGE_DATA_DIR || '').trim();

  let dir;
  if (explicito) {
    dir = path.resolve(explicito);
  } else if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    dir = path.join(base, 'antigravity-telegram-bridge');
  } else {
    const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    dir = path.join(base, 'antigravity-telegram-bridge');
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    if (fallbackDir) {
      console.error(`[paths] No se pudo usar ${dir} (${err.message}). Se cae a ${fallbackDir}.`);
      return fallbackDir;
    }
    throw err;
  }
}

/**
 * Devuelve la ruta canónica de un fichero de datos, migrando una sola vez el
 * que hubiera junto al código.
 *
 * La migración es deliberadamente conservadora: solo mueve si el destino NO
 * existe. Si ya hay estado canónico, el fichero antiguo se deja intacto en su
 * sitio en lugar de fusionarlo o pisarlo — dos `state.json` con historiales
 * distintos no se pueden reconciliar automáticamente sin arriesgar perder
 * conversaciones, y el usuario puede inspeccionar el sobrante.
 *
 * @param {string} nombre nombre del fichero (`state.json`, `bridge.lock`)
 * @param {string} legacyDir carpeta del módulo llamante, donde vivía antes
 */
export function resolveDataFile(nombre, legacyDir) {
  const dataDir = resolveBridgeDataDir(legacyDir);
  const destino = path.join(dataDir, nombre);

  if (dataDir === legacyDir) return destino;

  const legacy = path.join(legacyDir, nombre);
  if (fs.existsSync(legacy) && !fs.existsSync(destino)) {
    try {
      fs.renameSync(legacy, destino);
      console.log(`[paths] ${nombre} migrado de ${legacyDir} a ${dataDir}.`);
    } catch (err) {
      // `rename` entre volúmenes distintos falla con EXDEV; copiar y borrar sí
      // funciona. Si tampoco se puede, se sigue con el destino vacío: es estado
      // recuperable, no vale tumbar el bridge por ello.
      try {
        fs.copyFileSync(legacy, destino);
        fs.unlinkSync(legacy);
        console.log(`[paths] ${nombre} copiado de ${legacyDir} a ${dataDir}.`);
      } catch (err2) {
        console.error(`[paths] No se pudo migrar ${legacy}: ${err2.message}. Se parte de cero en ${destino}.`);
      }
    }
  }

  return destino;
}

/**
 * Rutas heredadas del mismo fichero, para los casos en que hay que seguir
 * mirando la ubicación antigua aunque ya no se escriba en ella. El lockfile lo
 * necesita: durante el despliegue puede haber un bot de la versión anterior
 * todavía vivo sujetando el lock antiguo, y arrancar ignorándolo daría dos
 * `getUpdates` concurrentes y 409 Conflict — justo lo que el lock evita.
 */
export function legacyDataFile(nombre, legacyDir) {
  return path.join(legacyDir, nombre);
}
