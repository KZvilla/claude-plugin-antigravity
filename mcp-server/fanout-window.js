/**
 * Paneo de Windows Terminal por subagente (FEAT-010, Windows only).
 *
 * En vez de un TUI propio, una terminal por subagente tileadas por `wt.exe`
 * en una ventana nueva y separada — ver
 * docs/future-implementations/subagentes-concurrentes-agy.md §7.1 (Bloque 2)
 * para el mecanismo completo y por qué se descartó un renderizador propio.
 *
 * `construirComandosWt` es la parte pura y testable: arma la SECUENCIA de
 * invocaciones de `wt.exe` — una por pane, nunca una sola invocación
 * encadenada con `;`. Esto es un cambio deliberado sobre el diseño
 * original (verificado en vivo el 2026-09-05, que sí encadenaba `new-tab ;
 * split-pane -H ; split-pane -V` en una sola llamada): reproducido en vivo
 * el 2026-09-09 que esa forma encadenada hace crashear a
 * `WindowsTerminal.exe` (`TerminalApp.dll`, `0xc0000005`, acceso inválido)
 * en cuanto hay DOS `split-pane` en la misma invocación — 1 pane
 * (`new-tab` solo) y 2 panes (`new-tab` + 1 `split-pane`) confirmados
 * estables en el mismo Event Viewer; 3 panes encadenados crashea
 * reproduciblemente. No es un bug de este módulo: es un bug de
 * `TerminalApp.dll` (build `1.24.11911.0`, la última disponible por
 * `winget` al momento de encontrarlo) al procesar dos comandos de split en
 * el mismo batch. La mitigación es lanzar cada split como una invocación
 * de `wt.exe` SEPARADA, apuntando a `-w 0` ("la última ventana usada" —
 * la que se acaba de abrir), espaciadas por una pausa breve para no
 * volver a golpear la misma condición de carrera.
 *
 * Detalles ya verificados y que no hay que reverificar:
 *
 *   1. Hace falta `-w new` en la PRIMERA invocación, o `wt` agrega
 *      pestañas a la ventana activa en vez de abrir una nueva (y le roba
 *      el foco). Las invocaciones siguientes usan `-w 0` para apuntar a
 *      esa misma ventana recién creada.
 *   2. `--title` no rotula cada pane — solo el título de la pestaña
 *      entera (y sigue al último pane con foco). El nombre del subagente
 *      lo tiene que imprimir el propio `fanout-tail.js` como primera
 *      línea de su salida, no confiarlo a este flag.
 *   3. Cada pane tiene que ser UN SOLO comando externo con argumentos
 *      simples (`node fanout-tail.js <log> <nombre>`), nunca un one-liner
 *      de shell con `;` adentro — un `-Command` de PowerShell
 *      multi-sentencia hizo que los `;` internos se mezclaran con los de
 *      `wt` y lanzara basura.
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUTA_FANOUT_TAIL = path.join(__dirname, 'fanout-tail.js');
const ESPERA_ENTRE_COMANDOS_MS = 400;

/**
 * @param {Array<{nombre:string, cwd:string, rutaLog:string}>} entradas
 * @param {object} [opciones]
 * @param {string} [opciones.nodeBin]         Default process.execPath.
 * @param {string} [opciones.fanoutTailPath]  Default mcp-server/fanout-tail.js.
 * @returns {Array<{bin:string, args:string[]}>} una entrada por comando, en
 *   el orden en que hay que lanzarlos (no en paralelo — ver abrirVentanaWt).
 */
function construirComandosWt(entradas, opciones = {}) {
  if (!Array.isArray(entradas) || entradas.length === 0) {
    throw new Error('construirComandosWt requiere al menos una entrada');
  }
  for (const e of entradas) {
    if (!e || !e.nombre || !e.cwd || !e.rutaLog) {
      throw new Error('cada entrada requiere nombre, cwd y rutaLog');
    }
  }

  const nodeBin = opciones.nodeBin || process.execPath;
  const fanoutTailPath = opciones.fanoutTailPath || RUTA_FANOUT_TAIL;

  return entradas.map((e, i) => {
    const args = [];
    if (i === 0) {
      args.push('-w', 'new', 'new-tab');
    } else {
      // Layout verificado en vivo para 3 (§7.1): el segundo pane parte la
      // ventana en dos (-H), el tercero parte el segundo (-V). Para más de
      // 3 no hay layout verificado todavía (§7.6 lo deja abierto a
      // propósito) — se sigue alternando -V desde el tercero en adelante,
      // una cascada razonable y honesta en vez de un algoritmo de grilla
      // sin probar en vivo.
      args.push('-w', '0', 'split-pane', i === 1 ? '-H' : '-V');
    }
    args.push('--title', e.nombre, '-d', e.cwd, nodeBin, fanoutTailPath, e.rutaLog, e.nombre);
    return { bin: 'wt.exe', args };
  });
}

/**
 * Lanza la secuencia, detached: no hay nada que esperar ni cuya salida haya
 * que capturar de ninguno de los comandos. `wt.exe` (cada invocación) le
 * pasa el pedido a la instancia de Windows Terminal que corresponda y
 * termina enseguida — el PID de `wt.exe` no es el de la ventana, así que no
 * hay nada que trackear de este lado ni limpiar si el usuario cierra un
 * pane.
 *
 * Los comandos se lanzan EN SECUENCIA, con una pausa entre cada uno
 * (`opciones.esperaEntreComandosMs`), no todos de una — ver el comentario
 * de arriba del módulo sobre por qué encadenarlos en una sola invocación
 * crashea `TerminalApp.dll`. Sigue siendo fire-and-forget desde la
 * perspectiva de quien llama: la función retorna de inmediato, la
 * secuenciación pasa en el fondo.
 *
 * `opciones.spawn` va inyectado para poder probar la construcción y la
 * secuencia sin abrir una ventana real durante los tests.
 *
 * El listener de `'error'` no es opcional: si `wt.exe` no está instalado,
 * `spawn` no tira de forma síncrona (así que un `try/catch` alrededor de
 * esta llamada no alcanza) — emite `'error'` en el próximo tick. Un
 * `EventEmitter` sin listener para `'error'` hace que Node lo trate como
 * excepción no capturada y tumbe **todo el proceso del servidor MCP**, no
 * solo este fan-out. Encontrado por auditoría adversarial (agy_audit,
 * 2026-09-09), reproducido de verdad apuntando `spawn` a un binario
 * inexistente.
 *
 * @returns {Array<{bin:string, args:string[]}>} los comandos, en el mismo
 *   orden en que se lanzaron (aunque el lanzamiento real siga en curso).
 */
function abrirVentanaWt(entradas, opciones = {}) {
  const comandos = construirComandosWt(entradas, opciones);
  const spawnFn = opciones.spawn || spawn;
  const esperaMs = opciones.esperaEntreComandosMs ?? ESPERA_ENTRE_COMANDOS_MS;

  const lanzar = (indice) => {
    if (indice >= comandos.length) return;
    const { bin, args } = comandos[indice];
    const child = spawnFn(bin, args, { detached: true, stdio: 'ignore', shell: false });
    child.on?.('error', (err) => {
      process.stderr.write(`[antigravity-mcp] No se pudo abrir/ampliar la ventana de wt (${bin}): ${err.message}\n`);
    });
    child.unref?.();

    if (indice + 1 < comandos.length) {
      const t = setTimeout(() => lanzar(indice + 1), esperaMs);
      t.unref?.();
    }
  };

  lanzar(0);
  return comandos;
}

module.exports = { construirComandosWt, abrirVentanaWt };
