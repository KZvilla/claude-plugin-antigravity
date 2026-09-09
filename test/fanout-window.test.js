/**
 * Construcción y secuenciación del comando `wt.exe` por subagente
 * (FEAT-010).
 *
 * `construirComandosWt` es pura — solo arma la secuencia de invocaciones,
 * no ejecuta nada — así que se prueba entera sin abrir una sola ventana
 * real. `abrirVentanaWt` sí spawnea, pero con `spawn` inyectado en los
 * tests: no hay forma segura de correr esto contra un `wt.exe` real
 * durante `npm test` sin abrir ventanas en la máquina de quien corra la
 * suite — y, según se confirmó en vivo el 2026-09-09, encadenar panes en
 * una sola invocación puede directamente crashear Windows Terminal
 * (`TerminalApp.dll`, `0xc0000005`), que es exactamente lo que este
 * módulo dejó de hacer.
 */
const { check, group, report } = require('./lib/assert');
const { construirComandosWt, abrirVentanaWt } = require('../mcp-server/fanout-window.js');

async function main() {
  await group('construirComandosWt — una entrada', () => {
    const comandos = construirComandosWt([
      { nombre: 'tarea-a', cwd: 'C:\\wt\\a', rutaLog: 'C:\\wt\\a.jsonl' }
    ]);

    check('devuelve un array con un solo comando', Array.isArray(comandos) && comandos.length === 1);
    const { bin, args } = comandos[0];
    check('bin es wt.exe', bin === 'wt.exe');
    check('arranca con -w new new-tab', args[0] === '-w' && args[1] === 'new' && args[2] === 'new-tab');
    check('nunca lleva ; ni split-pane (una sola entrada)', !args.includes(';') && !args.includes('split-pane'));
    check('lleva --title, -d, el binario de node y fanout-tail.js con log y nombre',
      args.includes('--title') && args.includes('tarea-a') &&
      args.includes('-d') && args.includes('C:\\wt\\a') &&
      args.includes(process.execPath) &&
      args.some(a => a.endsWith('fanout-tail.js')) &&
      args.includes('C:\\wt\\a.jsonl'));
  });

  await group('construirComandosWt — tres entradas: comandos SEPARADOS, nunca encadenados (mitigación del crash)', () => {
    const comandos = construirComandosWt([
      { nombre: 't1', cwd: 'C:\\wt\\1', rutaLog: 'C:\\wt\\1.jsonl' },
      { nombre: 't2', cwd: 'C:\\wt\\2', rutaLog: 'C:\\wt\\2.jsonl' },
      { nombre: 't3', cwd: 'C:\\wt\\3', rutaLog: 'C:\\wt\\3.jsonl' }
    ]);

    check('tres comandos, uno por pane', comandos.length === 3);
    check('ninguno lleva ; (nunca se encadenan — eso es lo que crasheaba WindowsTerminal.exe)',
      comandos.every(c => !c.args.includes(';')));
    check('ninguno lleva más de un split-pane (a lo sumo cero)',
      comandos.every(c => c.args.filter(a => a === 'split-pane').length <= 1));

    check('el primero abre ventana nueva', comandos[0].args[0] === '-w' && comandos[0].args[1] === 'new' && comandos[0].args[2] === 'new-tab');
    check('el segundo apunta a -w 0 con split-pane -H', comandos[1].args[0] === '-w' && comandos[1].args[1] === '0' &&
      comandos[1].args[2] === 'split-pane' && comandos[1].args[3] === '-H');
    check('el tercero apunta a -w 0 con split-pane -V', comandos[2].args[0] === '-w' && comandos[2].args[1] === '0' &&
      comandos[2].args[2] === 'split-pane' && comandos[2].args[3] === '-V');

    check('los tres nombres aparecen, uno por comando', comandos[0].args.includes('t1') && comandos[1].args.includes('t2') && comandos[2].args.includes('t3'));
  });

  await group('construirComandosWt — cuarta entrada en adelante sigue alternando -V', () => {
    const comandos = construirComandosWt([
      { nombre: 't1', cwd: 'c1', rutaLog: 'l1' },
      { nombre: 't2', cwd: 'c2', rutaLog: 'l2' },
      { nombre: 't3', cwd: 'c3', rutaLog: 'l3' },
      { nombre: 't4', cwd: 'c4', rutaLog: 'l4' }
    ]);
    check('4 comandos para 4 tareas', comandos.length === 4);
    check('todos menos el primero apuntan a -w 0', comandos.slice(1).every(c => c.args[0] === '-w' && c.args[1] === '0'));
    check('el segundo y tercer split (índices 1,2) son -V', comandos[2].args[3] === '-V' && comandos[3].args[3] === '-V');
  });

  await group('construirComandosWt — validación', () => {
    let lanzo = false;
    try { construirComandosWt([]); } catch { lanzo = true; }
    check('rechaza lista vacía', lanzo);

    lanzo = false;
    try { construirComandosWt(null); } catch { lanzo = true; }
    check('rechaza no-array', lanzo);

    lanzo = false;
    try { construirComandosWt([{ nombre: 'x', cwd: 'y' }]); } catch { lanzo = true; }
    check('exige rutaLog en cada entrada', lanzo);
  });

  await group('construirComandosWt — opciones nodeBin/fanoutTailPath son inyectables', () => {
    const comandos = construirComandosWt(
      [{ nombre: 't', cwd: 'c', rutaLog: 'l' }],
      { nodeBin: '/otro/node', fanoutTailPath: '/otro/fanout-tail.js' }
    );
    check('usa el nodeBin inyectado', comandos[0].args.includes('/otro/node'));
    check('usa el fanoutTailPath inyectado', comandos[0].args.includes('/otro/fanout-tail.js'));
  });

  await group('abrirVentanaWt — spawnea cada comando por separado, en secuencia, detached', async () => {
    const llamadas = [];
    const spawnFalso = (bin, args, opts) => {
      llamadas.push({ t: Date.now(), bin, args, opts });
      const child = { unref: () => { llamadas.push('unref'); }, on: () => {} };
      return child;
    };

    const entradas = [
      { nombre: 'a', cwd: 'ca', rutaLog: 'la' },
      { nombre: 'b', cwd: 'cb', rutaLog: 'lb' },
      { nombre: 'c', cwd: 'cc', rutaLog: 'lc' }
    ];
    const esperaMs = 20;
    const comandos = abrirVentanaWt(entradas, { spawn: spawnFalso, esperaEntreComandosMs: esperaMs });

    check('devuelve los 3 comandos de inmediato (fire-and-forget)', comandos.length === 3);
    check('todavía no spawneó los 3 de forma síncrona (la secuencia sigue en el fondo)',
      llamadas.filter(l => l && l.bin).length === 1, `spawns inmediatos = ${llamadas.filter(l => l && l.bin).length}`);

    // Esperar a que la secuencia completa termine de lanzarse.
    await new Promise(r => setTimeout(r, esperaMs * 3 + 100));

    const spawns = llamadas.filter(l => l && l.bin);
    check('terminó spawneando los 3, uno por uno', spawns.length === 3);
    check('cada spawn es detached, stdio ignore, shell false',
      spawns.every(s => s.opts.detached === true && s.opts.stdio === 'ignore' && s.opts.shell === false));
    check('hubo pausa real entre el primer y el segundo spawn', spawns[1].t - spawns[0].t >= esperaMs - 5, `${spawns[1].t - spawns[0].t}ms`);
    check('se llamó unref por cada spawn', llamadas.filter(l => l === 'unref').length === 3);
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
