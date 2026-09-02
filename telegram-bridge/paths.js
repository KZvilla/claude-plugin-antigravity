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
 * Ruta del directorio de datos, SIN tocar el disco. Precedencia:
 *   1. `TELEGRAM_BRIDGE_DATA_DIR` (explícito).
 *   2. `%LOCALAPPDATA%\antigravity-telegram-bridge` en Windows.
 *   3. `$XDG_STATE_HOME/antigravity-telegram-bridge` o
 *      `~/.local/state/antigravity-telegram-bridge` en el resto.
 *
 * Separada de `resolveBridgeDataDir` porque hay un caso que solo necesita LEER:
 * la busqueda del `.env`, que ocurre en el cuerpo del modulo. Crear directorios
 * ahi convertiria un `import` en una escritura en disco.
 */
export function bridgeDataDirPath() {
  const explicito = (process.env.TELEGRAM_BRIDGE_DATA_DIR || '').trim();
  if (explicito) return path.resolve(explicito);

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'antigravity-telegram-bridge');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'antigravity-telegram-bridge');
}

/**
 * Como `bridgeDataDirPath`, pero garantizando que el directorio existe.
 *
 * Si no se puede crear —permisos, disco lleno— se cae al directorio indicado
 * por `fallbackDir`, que es el comportamiento anterior: peor tener el estado
 * partido que no tener bridge.
 */
export function resolveBridgeDataDir(fallbackDir = null) {
  const dir = bridgeDataDirPath();
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

// ==============================================================================
// Carga de credenciales (.env)
// ==============================================================================

/**
 * Rutas donde se busca el `.env`, en orden de precedencia.
 *
 * El motivo del ultimo candidato: `claude plugin update` instala cada version
 * en su PROPIO directorio (`cache/<market>/<plugin>/<version>/`) y no arrastra
 * los ficheros que no estan en git. Un `.env` colocado junto al plugin
 * desaparece en cada actualizacion, y el sintoma no es un error de arranque
 * sino una herramienta que un dia responde «No hay usuarios configurados»: las
 * credenciales estaban dentro de un directorio versionado.
 *
 * Es la misma correccion que se hizo con `state.json` y `bridge.lock`: lo que
 * dura mas que una version no puede vivir junto al codigo.
 *
 * El orden preserva exactamente el comportamiento anterior —primero el `.env`
 * del bridge, luego el de la raiz del plugin— y solo AÑADE el duradero al
 * final, para que ninguna instalacion existente cambie de fichero.
 */
export function bridgeEnvCandidates(moduleDir) {
  const explicito = (process.env.TELEGRAM_BRIDGE_ENV_FILE || '').trim();
  const candidatos = [];
  if (explicito) candidatos.push(path.resolve(explicito));
  candidatos.push(path.join(moduleDir, '.env'));
  candidatos.push(path.join(moduleDir, '..', '.env'));
  candidatos.push(path.join(bridgeDataDirPath(), '.env'));
  return candidatos;
}

/**
 * Carga el primer `.env` que exista. Solo lee; nunca crea nada.
 *
 * Deliberadamente NO copia el `.env` a la ubicacion duradera por su cuenta.
 * El proyecto sostiene que ningun canal de instalacion debe mover credenciales
 * sin que el usuario lo pida, y un fichero de secretos duplicandose solo por
 * arrancar el proceso seria justo eso. Lo que si hace es decir donde ha mirado
 * cuando no encuentra nada, que es lo que faltaba para diagnosticarlo.
 *
 * @returns {{ loaded: string|null, searched: string[] }}
 */
export function loadBridgeEnv(moduleDir) {
  const searched = bridgeEnvCandidates(moduleDir);
  if (typeof process.loadEnvFile !== 'function') return { loaded: null, searched };

  for (const file of searched) {
    if (!fs.existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      return { loaded: file, searched };
    } catch (err) {
      console.error(`[paths] No se pudo leer ${file}: ${err.message}. Se prueba el siguiente.`);
    }
  }

  return { loaded: null, searched };
}

/**
 * Mensaje de diagnostico para cuando faltan credenciales. Enumerar donde se ha
 * buscado convierte un «no hay usuarios configurados» en algo accionable.
 */
export function describeEnvSearch(searched) {
  const duradero = path.join(bridgeDataDirPath(), '.env');
  return [
    'No se encontró ningún .env. Se buscó, en este orden:',
    ...searched.map((f, i) => `  ${i + 1}. ${f}`),
    '',
    `Para que las credenciales sobrevivan a "claude plugin update", colócalas en:`,
    `  ${duradero}`,
    '(cada versión del plugin se instala en su propio directorio, así que un .env',
    ' junto al código desaparece en la siguiente actualización).'
  ].join('\n');
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
