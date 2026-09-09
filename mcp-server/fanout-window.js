/**
 * Paneo de Windows Terminal por subagente (FEAT-010, Windows only).
 *
 * En vez de un TUI propio, una terminal por subagente tileadas por `wt.exe`
 * en una ventana nueva y separada — ver
 * docs/future-implementations/subagentes-concurrentes-agy.md §7.1 (Bloque 2)
 * para el mecanismo completo y por qué se descartó un renderizador propio.
 *
 * `construirComandoWt` es la parte pura y testable: arma el array de
 * argumentos exacto que se le pasa a `spawn('wt.exe', args, { shell: false
 * })` — verificado en vivo el 2026-09-05 que `wt` interpreta el `;` como
 * separador de sub-comandos EN SU PROPIO parser cuando llega como elemento
 * de array literal, sin pelearse con el escapado de ninguna shell. Tres
 * detalles que ya costaron una vuelta de verificación y no hay que repetir:
 *
 *   1. Hace falta `-w new` antes del subcomando, o `wt` agrega pestañas a la
 *      ventana activa en vez de abrir una nueva (y le roba el foco).
 *   2. `--title` no rotula cada pane — solo el título de la pestaña entera
 *      (y sigue al último pane con foco). El nombre del subagente lo tiene
 *      que imprimir el propio `fanout-tail.js` como primera línea de su
 *      salida, no confiarlo a este flag.
 *   3. Cada pane tiene que ser UN SOLO comando externo con argumentos
 *      simples (`node fanout-tail.js <log> <nombre>`), nunca un one-liner de
 *      shell con `;` adentro — un `-Command` de PowerShell multi-sentencia
 *      hizo que los `;` internos se mezclaran con los de `wt` y lanzara
 *      basura.
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUTA_FANOUT_TAIL = path.join(__dirname, 'fanout-tail.js');

/**
 * @param {Array<{nombre:string, cwd:string, rutaLog:string}>} entradas
 * @param {object} [opciones]
 * @param {string} [opciones.nodeBin]         Default process.execPath.
 * @param {string} [opciones.fanoutTailPath]  Default mcp-server/fanout-tail.js.
 * @returns {{bin:string, args:string[]}}
 */
function construirComandoWt(entradas, opciones = {}) {
  if (!Array.isArray(entradas) || entradas.length === 0) {
    throw new Error('construirComandoWt requiere al menos una entrada');
  }
  for (const e of entradas) {
    if (!e || !e.nombre || !e.cwd || !e.rutaLog) {
      throw new Error('cada entrada requiere nombre, cwd y rutaLog');
    }
  }

  const nodeBin = opciones.nodeBin || process.execPath;
  const fanoutTailPath = opciones.fanoutTailPath || RUTA_FANOUT_TAIL;

  const args = ['-w', 'new'];
  entradas.forEach((e, i) => {
    if (i === 0) {
      args.push('new-tab');
    } else {
      // Verificado para 3 (§7.1): el segundo pane parte la ventana en dos
      // (-H), el tercero parte el segundo (-V), dando una fila arriba y dos
      // columnas abajo. Para más de 3 no hay layout verificado todavía
      // (§7.6 lo deja abierto a propósito) — acá se seguir alternando -V
      // desde el tercero en adelante, una cascada razonable y honesta en
      // vez de inventar un algoritmo de grilla sin haberlo probado en vivo.
      args.push(';', 'split-pane', i === 1 ? '-H' : '-V');
    }
    args.push('--title', e.nombre, '-d', e.cwd, nodeBin, fanoutTailPath, e.rutaLog, e.nombre);
  });

  return { bin: 'wt.exe', args };
}

/**
 * Lanza la ventana, detached: no hay nada que esperar ni cuya salida haya
 * que capturar. `wt.exe` (el comando que lanzamos) le pasa el pedido a la
 * instancia de Windows Terminal que ya esté corriendo (o arranca una) y
 * termina enseguida — su PID no es el de la ventana, así que no hay nada
 * que trackear de este lado ni limpiar si el usuario cierra el pane.
 *
 * `opciones.spawn` va inyectado para poder probar la construcción del
 * comando sin abrir una ventana real durante los tests.
 *
 * El listener de `'error'` no es opcional: si `wt.exe` no está instalado,
 * `spawn` no tira de forma síncrona (así que un `try/catch` alrededor de
 * esta llamada no alcanza) — emite `'error'` en el próximo tick. Un
 * `EventEmitter` sin listener para `'error'` hace que Node lo trate como
 * excepción no capturada y tumbe **todo el proceso del servidor MCP**, no
 * solo este fan-out. Encontrado por auditoría adversarial (agy_audit,
 * 2026-09-09), reproducido de verdad apuntando `spawn` a un binario
 * inexistente.
 */
function abrirVentanaWt(entradas, opciones = {}) {
  const { bin, args } = construirComandoWt(entradas, opciones);
  const spawnFn = opciones.spawn || spawn;
  const child = spawnFn(bin, args, { detached: true, stdio: 'ignore', shell: false });
  child.on?.('error', (err) => {
    process.stderr.write(`[antigravity-mcp] No se pudo abrir la ventana de wt (${bin}): ${err.message}\n`);
  });
  child.unref?.();
  return { bin, args };
}

module.exports = { construirComandoWt, abrirVentanaWt };
