/**
 * Construcción del comando `wt.exe` por subagente (FEAT-010).
 *
 * `construirComandoWt` es pura — solo arma el array de argumentos, no lo
 * ejecuta — así que se prueba entera sin abrir una sola ventana real.
 * `abrirVentanaWt` sí spawnea, pero con `spawn` inyectado en los tests: no
 * hay forma segura de correr esto contra un `wt.exe` real durante `npm
 * test` sin abrir ventanas en la máquina de quien corra la suite.
 */
const { check, group, report } = require('./lib/assert');
const { construirComandoWt, abrirVentanaWt } = require('../mcp-server/fanout-window.js');

async function main() {
  await group('construirComandoWt — una entrada', () => {
    const { bin, args } = construirComandoWt([
      { nombre: 'tarea-a', cwd: 'C:\\wt\\a', rutaLog: 'C:\\wt\\a.jsonl' }
    ]);

    check('bin es wt.exe', bin === 'wt.exe');
    check('arranca con -w new', args[0] === '-w' && args[1] === 'new');
    check('un único new-tab, sin ; ni split-pane', args[2] === 'new-tab' && !args.includes('split-pane'));
    check('lleva --title, -d, el binario de node y fanout-tail.js con log y nombre',
      args.includes('--title') && args.includes('tarea-a') &&
      args.includes('-d') && args.includes('C:\\wt\\a') &&
      args.includes(process.execPath) &&
      args.some(a => a.endsWith('fanout-tail.js')) &&
      args.includes('C:\\wt\\a.jsonl'));
  });

  await group('construirComandoWt — tres entradas (layout verificado en vivo)', () => {
    const { args } = construirComandoWt([
      { nombre: 't1', cwd: 'C:\\wt\\1', rutaLog: 'C:\\wt\\1.jsonl' },
      { nombre: 't2', cwd: 'C:\\wt\\2', rutaLog: 'C:\\wt\\2.jsonl' },
      { nombre: 't3', cwd: 'C:\\wt\\3', rutaLog: 'C:\\wt\\3.jsonl' }
    ]);

    const iSemicolon1 = args.indexOf(';');
    const iSemicolon2 = args.indexOf(';', iSemicolon1 + 1);
    check('dos separadores ; (uno por split-pane extra)', iSemicolon1 > 0 && iSemicolon2 > iSemicolon1);
    check('el primer split es -H', args[iSemicolon1 + 1] === 'split-pane' && args[iSemicolon1 + 2] === '-H');
    check('el segundo split es -V', args[iSemicolon2 + 1] === 'split-pane' && args[iSemicolon2 + 2] === '-V');
    check('los tres nombres aparecen', ['t1', 't2', 't3'].every(n => args.includes(n)));
    check('las tres rutas de log aparecen', ['1.jsonl', '2.jsonl', '3.jsonl'].every(suf => args.some(a => a.endsWith(suf))));
  });

  await group('construirComandoWt — cuarta entrada en adelante sigue alternando -V', () => {
    const { args } = construirComandoWt([
      { nombre: 't1', cwd: 'c1', rutaLog: 'l1' },
      { nombre: 't2', cwd: 'c2', rutaLog: 'l2' },
      { nombre: 't3', cwd: 'c3', rutaLog: 'l3' },
      { nombre: 't4', cwd: 'c4', rutaLog: 'l4' }
    ]);
    const splits = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'split-pane') splits.push(args[i + 1]);
    }
    check('3 splits para 4 tareas', splits.length === 3, splits.join(','));
    check('el segundo y tercer split (índice 1,2 dentro de splits) son -V', splits[1] === '-V' && splits[2] === '-V', splits.join(','));
  });

  await group('construirComandoWt — validación', () => {
    let lanzo = false;
    try { construirComandoWt([]); } catch { lanzo = true; }
    check('rechaza lista vacía', lanzo);

    lanzo = false;
    try { construirComandoWt(null); } catch { lanzo = true; }
    check('rechaza no-array', lanzo);

    lanzo = false;
    try { construirComandoWt([{ nombre: 'x', cwd: 'y' }]); } catch { lanzo = true; }
    check('exige rutaLog en cada entrada', lanzo);
  });

  await group('construirComandoWt — opciones nodeBin/fanoutTailPath son inyectables', () => {
    const { args } = construirComandoWt(
      [{ nombre: 't', cwd: 'c', rutaLog: 'l' }],
      { nodeBin: '/otro/node', fanoutTailPath: '/otro/fanout-tail.js' }
    );
    check('usa el nodeBin inyectado', args.includes('/otro/node'));
    check('usa el fanoutTailPath inyectado', args.includes('/otro/fanout-tail.js'));
  });

  await group('abrirVentanaWt — spawnea con el comando de construirComandoWt, detached', () => {
    const llamadas = [];
    const spawnFalso = (bin, args, opts) => {
      llamadas.push({ bin, args, opts });
      return { unref: () => { llamadas.push('unref'); } };
    };

    const entradas = [{ nombre: 'sola', cwd: 'c', rutaLog: 'l' }];
    const resultado = abrirVentanaWt(entradas, { spawn: spawnFalso });

    check('llamó a spawn una vez', llamadas.filter(l => l && l.bin).length === 1);
    check('con wt.exe', llamadas[0].bin === 'wt.exe');
    check('detached y stdio ignore', llamadas[0].opts.detached === true && llamadas[0].opts.stdio === 'ignore');
    check('shell false (nunca por una shell)', llamadas[0].opts.shell === false);
    check('llamó a unref', llamadas.includes('unref'));
    check('devuelve el mismo comando que construirComandoWt', resultado.bin === 'wt.exe' && Array.isArray(resultado.args));
  });

  await group('abrirVentanaWt — un binario faltante no tumba el proceso (regresión de auditoría adversarial)', async () => {
    // agy_audit (2026-09-09) reprodujo que spawn('wt.exe', ...) sin listener
    // de 'error' tumba TODO el proceso del servidor MCP cuando wt.exe no
    // está instalado — `spawn` no tira de forma síncrona ante ENOENT, emite
    // 'error' en el próximo tick, y un EventEmitter sin listener para eso
    // es una excepción no capturada para Node. Acá se reproduce con el
    // spawn REAL de Node (no un mock) apuntado a un binario que seguro no
    // existe, para ejercitar el mismo camino asincrónico que reventó en el
    // audit — si el fix no estuviera, este test ni siquiera llegaría a los
    // checks de abajo: el proceso entero de la suite moriría acá.
    const { spawn: spawnReal } = require('node:child_process');
    const entradas = [{ nombre: 'sola', cwd: process.cwd(), rutaLog: 'no-importa.jsonl' }];

    let logueoAlgo = false;
    const stderrOriginal = process.stderr.write;
    process.stderr.write = (chunk) => { logueoAlgo = true; return true; };

    try {
      abrirVentanaWt(entradas, {
        spawn: (bin, args, opts) => spawnReal('binario-definitivamente-inexistente-xyz123', args, opts)
      });
      // Dar tiempo a que el 'error' asincrónico de spawn dispare de verdad.
      await new Promise(r => setTimeout(r, 300));
    } finally {
      process.stderr.write = stderrOriginal;
    }

    check('el proceso de test sigue vivo (si no, esto nunca se ejecuta)', true);
    check('el fallo se loguea en vez de quedar silencioso', logueoAlgo);
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
