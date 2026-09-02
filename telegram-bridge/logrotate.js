/**
 * Rotación de `daemon.log` desde dentro del proceso del bot.
 *
 * El problema y por qué el método obvio no sirve
 * ---------------------------------------------
 * El daemon arranca como `wscript.exe daemon-hidden.vbs`, que a su vez lanza
 * `cmd.exe /c "node bot.js >> daemon.log 2>&1"`. Quien tiene abierto el fichero
 * es CMD, no Node, y lo abrió antes de que `bot.js` ejecutara su primera línea.
 * De ahí que renombrar el log desde aquí no funcione:
 *
 *   1. En Windows el `rename` falla con EBUSY/EPERM, porque la redirección de
 *      CMD no comparte el permiso de borrado (`FILE_SHARE_DELETE`).
 *   2. Y si llegara a funcionar, el manejador de CMD seguiría apuntando al
 *      fichero renombrado: todo el log posterior acabaría dentro de
 *      `daemon.log.old` y `daemon.log` no volvería a crearse.
 *
 * Lo que sí funciona es copiar y TRUNCAR. La redirección `>>` abre en modo
 * append: cada escritura se coloca al final del fichero en el momento de
 * escribir, no en un desplazamiento memorizado. Al truncar a cero, la siguiente
 * línea se escribe en la posición 0 del mismo fichero, sin manejadores rotos y
 * sin cooperación de CMD.
 *
 * El otro desajuste que se corrige
 * --------------------------------
 * Rotar solo al arrancar no acota nada en el escenario que motiva esto: un
 * daemon que lleva meses en marcha sin reiniciarse. Por eso la comprobación es
 * periódica mientras el proceso vive, no un chequeo único de arranque.
 */

import fs from 'node:fs';

export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB, igual que daemon.ps1
export const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000; // media hora

/**
 * Rota el log si supera el tamaño máximo. Idempotente y sin lanzar nunca: un
 * fallo de rotación no puede tumbar el bot.
 *
 * @returns {boolean} true si se rotó
 */
export function rotateIfNeeded(logFile, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  try {
    if (!fs.existsSync(logFile)) return false;
    const { size } = fs.statSync(logFile);
    if (size <= maxBytes) return false;

    // Se conserva una generación. La ventana entre la copia y el truncado puede
    // perder alguna línea escrita justo en ese instante; es un precio aceptable
    // frente a un log que crece sin tope.
    fs.copyFileSync(logFile, `${logFile}.old`);
    fs.truncateSync(logFile, 0);
    console.log(`[logrotate] daemon.log superaba ${Math.round(maxBytes / 1024 / 1024)} MB (${size} bytes). Rotado a daemon.log.old.`);
    return true;
  } catch (err) {
    console.error(`[logrotate] No se pudo rotar ${logFile}: ${err.message}`);
    return false;
  }
}

/**
 * Programa la comprobación periódica. El temporizador va `unref`ado: la
 * rotación no debe ser motivo para que el proceso siga vivo.
 *
 * @returns {() => void} función para detener la vigilancia
 */
export function startLogRotation(logFile, {
  maxBytes = DEFAULT_MAX_LOG_BYTES,
  intervalMs = DEFAULT_CHECK_INTERVAL_MS
} = {}) {
  rotateIfNeeded(logFile, maxBytes);
  const timer = setInterval(() => rotateIfNeeded(logFile, maxBytes), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
