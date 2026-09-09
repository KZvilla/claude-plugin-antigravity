/**
 * Orquestador de fan-out (FEAT-005).
 *
 * El ejecutor va inyectado, así que se puede comprobar lo que de verdad importa
 * —el tope de concurrencia, el backoff solo ante cuota, el mapeo tarea→worktree
 * y que nada se lance si el reparto no valida— sin arrancar un proceso de agy ni
 * gastar un token. Los worktrees sí son reales: son la parte que se rompe de
 * formas que un stub no reproduce.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const { lanzarFanout, esErrorDeCuota, reglasDelSubagente } = require('../mcp-server/fanout.js');

function crearRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fan-')));
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'inicial');
  return dir;
}

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

const tarea = (id, archivos, extra = {}) => ({ id, prompt: `hacer ${id}`, archivos, ...extra });

/** Registrador de estado falso: junta la secuencia de marcas por tarea. */
function registradorFalso() {
  const llamadas = { iniciar: [], marcar: [], terminar: 0 };
  return {
    iniciar: (meta) => llamadas.iniciar.push(meta),
    marcar: (id, cambios) => llamadas.marcar.push({ id, ...cambios }),
    terminar: () => { llamadas.terminar++; },
    llamadas,
    estadosDe: (id) => llamadas.marcar.filter(m => m.id === id).map(m => m.estado)
  };
}

/** Ejecutor que registra las llamadas y permite programar fallos por id. */
function ejecutorFalso({ fallar = {}, registrarConcurrencia = false } = {}) {
  const llamadas = [];
  let enVuelo = 0;
  let picoConcurrencia = 0;

  const ejecutar = async (peticion) => {
    llamadas.push(peticion);
    if (registrarConcurrencia) {
      enVuelo++;
      picoConcurrencia = Math.max(picoConcurrencia, enVuelo);
      await new Promise(r => setTimeout(r, 15));
      enVuelo--;
    }
    // El id de la tarea viaja dentro del prompt, bajo la sección [TAREA].
    const id = (peticion.prompt.match(/hacer ([a-z0-9-]+)/) || [])[1];
    const plan = fallar[id];
    if (plan && plan.stopped) {
      plan.usadas = (plan.usadas || 0) + 1;
      return { success: false, error: 'Detenido por el usuario', stopped: true };
    }
    if (plan) {
      const restantes = plan.veces === undefined ? Infinity : plan.veces;
      plan.usadas = (plan.usadas || 0) + 1;
      if (plan.usadas <= restantes) {
        return { success: false, error: plan.error };
      }
    }
    return { success: true, conversation_id: `conv-${id}` };
  };

  return { ejecutar, llamadas, pico: () => picoConcurrencia };
}

async function main() {
  await group('clasificación de errores de cuota', () => {
    check('detecta 429', esErrorDeCuota('HTTP 429 Too Many Requests') === true);
    check('detecta quota', esErrorDeCuota('QUOTA EXCEEDED') === true);
    check('detecta rate limit', esErrorDeCuota('rate-limit reached') === true);
    check('no marca un error de código', esErrorDeCuota('SyntaxError: unexpected token') === false);
    check('tolera vacío', esErrorDeCuota(undefined) === false);
  });

  await group('reglas inyectadas al subagente', () => {
    const texto = reglasDelSubagente(tarea('a', ['src/x.js']));
    check('prohíbe testear', /NO escribas ni ejecutes tests/.test(texto));
    check('prohíbe mergear y cambiar de rama', /NO hagas merge/.test(texto));
    check('prohíbe anidar subagentes', /NO invoques subagentes/.test(texto));
    check('declara el alcance de archivos', /src\/x\.js/.test(texto));
    check('pide commit al final', /commiteá/i.test(texto));
    check('la tarea original sigue presente', /hacer a/.test(texto));
  });

  let repo = crearRepo();
  try {
    await group('rechaza sin lanzar nada si el reparto no valida', async () => {
      const eje = ejecutorFalso();
      const r = await lanzarFanout({
        repoPath: repo,
        slug: 'choque',
        tareas: [tarea('a', ['src/x.js']), tarea('b', ['src/x.js'])]
      }, { ejecutar: eje.ejecutar });

      check('no lanza', r.lanzado === false);
      check('el motivo es el reparto', r.motivo === 'reparto inválido');
      check('no llamó al ejecutor ni una vez', eje.llamadas.length === 0, `llamó ${eje.llamadas.length}`);
      check('no creó worktrees',
        !fs.existsSync(path.join(repo, '.claude', 'worktrees')) ||
        fs.readdirSync(path.join(repo, '.claude', 'worktrees')).length === 0);
      check('sigue en main (no tocó la rama)',
        execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim() === 'main');
      check('el detalle explica el choque', /merge/.test(r.detalle));
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('camino feliz', async () => {
      const eje = ejecutorFalso();
      const r = await lanzarFanout({
        repoPath: repo,
        slug: 'Reparto Feliz',
        tareas: [tarea('a', ['src/a.js']), tarea('b', ['src/b.js']), tarea('c', ['src/c.js'])],
        modelo: 'gemini-3.8-flash',
        effort: 'high'
      }, { ejecutar: eje.ejecutar });

      check('lanza', r.lanzado === true);
      check('creó rama base desde main', r.ramaBase === 'feat/reparto-feliz' && r.ramaBaseCreada === true, r.ramaBase);
      check('una llamada por tarea', eje.llamadas.length === 3, `hubo ${eje.llamadas.length}`);
      check('todas exitosas', r.resumen.exitosas === 3 && r.resumen.fallidas === 0);

      check('cada subagente corre en su propio worktree',
        new Set(eje.llamadas.map(l => l.cwd)).size === 3);
      check('los cwd son los worktrees creados',
        eje.llamadas.every(l => l.cwd.includes('agy-reparto-feliz-')), eje.llamadas.map(l => l.cwd).join(' '));
      check('cada resultado trae su rama distinta',
        new Set(r.resultados.map(x => x.rama)).size === 3);
      check('propaga modelo y effort del lote',
        eje.llamadas.every(l => l.model === 'gemini-3.8-flash' && l.effort === 'high'));
      check('modo de escritura por defecto',
        eje.llamadas.every(l => l.mode === 'accept-edits'));
      check('devuelve el conversation_id de cada uno',
        r.resultados.every(x => /^conv-/.test(x.conversation_id)));
      check('recuerda que auditar y testear no es suyo', /no testean ni mergean/.test(r.siguientePaso));
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('overrides por tarea', async () => {
      const eje = ejecutorFalso();
      await lanzarFanout({
        repoPath: repo,
        slug: 'overrides',
        tareas: [
          tarea('a', ['src/a.js'], { modelo: 'gemini-3.1-pro', effort: 'low' }),
          tarea('b', ['src/b.js'], { soloLectura: true })
        ],
        modelo: 'gemini-3.8-flash',
        effort: 'high'
      }, { ejecutar: eje.ejecutar });

      const porId = Object.fromEntries(eje.llamadas.map(l => [(l.prompt.match(/hacer ([a-z]+)/) || [])[1], l]));
      check('la tarea pisa el modelo del lote', porId.a.model === 'gemini-3.1-pro');
      check('la tarea pisa el effort del lote', porId.a.effort === 'low');
      check('soloLectura se traduce a mode plan (el único read-only real)',
        porId.b.mode === 'plan');
      check('la otra sigue en accept-edits', porId.a.mode === 'accept-edits');
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('tope de concurrencia', async () => {
      const eje = ejecutorFalso({ registrarConcurrencia: true });
      const tareas = Array.from({ length: 7 }, (_, i) => tarea(`t${i}`, [`src/f${i}.js`]));

      const r = await lanzarFanout({
        repoPath: repo, slug: 'lotes', tareas, concurrencia: 2
      }, { ejecutar: eje.ejecutar });

      check('ejecuta las 7', r.resumen.total === 7);
      check('nunca supera el tope', eje.pico() <= 2, `pico = ${eje.pico()}`);
      check('reporta los lotes', r.lotes === 4, `lotes = ${r.lotes}`);
      check('el tope queda registrado', r.concurrencia === 2);
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('backoff solo ante cuota', async () => {
      const esperas = [];
      const alDormir = async ms => { esperas.push(ms); };

      // `a` falla dos veces por cuota y a la tercera pasa; `b` falla por un
      // error de código, que no se debe reintentar.
      const eje = ejecutorFalso({
        fallar: {
          a: { error: 'HTTP 429 quota exceeded', veces: 2 },
          b: { error: 'TypeError: x is not a function' }
        }
      });

      const r = await lanzarFanout({
        repoPath: repo,
        slug: 'cuota',
        tareas: [tarea('a', ['src/a.js']), tarea('b', ['src/b.js'])],
        concurrencia: 1,
        esperaBaseMs: 1000
      }, { ejecutar: eje.ejecutar, alDormir });

      const porId = Object.fromEntries(r.resultados.map(x => [x.id, x]));
      check('reintenta la de cuota hasta que pasa', porId.a.exito === true, JSON.stringify(porId.a));
      check('registra los 3 intentos', porId.a.intentos === 3, `intentos = ${porId.a.intentos}`);
      check('el backoff es exponencial', esperas.join(',') === '1000,2000', esperas.join(','));

      check('no reintenta un error de código', porId.b.exito === false);
      check('lo marca como no-cuota', porId.b.porCuota === false);
      check('un solo intento para el error de código', porId.b.intentos === 1, `intentos = ${porId.b.intentos}`);

      check('el resumen cuenta la fallida', r.resumen.fallidas === 1 && r.resumen.exitosas === 1);
      check('distingue las fallidas por cuota', r.resumen.fallidasPorCuota === 0);
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('detención pedida a mano (FEAT-012)', async () => {
      const eje = ejecutorFalso({ fallar: { a: { stopped: true } } });
      const registrador = registradorFalso();

      const r = await lanzarFanout({
        repoPath: repo,
        slug: 'con-stop',
        tareas: [tarea('a', ['src/a.js']), tarea('b', ['src/b.js'])],
        concurrencia: 2
      }, { ejecutar: eje.ejecutar, registrarEstado: registrador });

      check('la petición lleva su propio taskId',
        eje.llamadas.every(l => typeof l.taskId === 'string' && l.taskId.length > 0));

      const porId = Object.fromEntries(r.resultados.map(x => [x.id, x]));
      check('no se reintenta (un solo intento)', porId.a.intentos === 1, `intentos = ${porId.a.intentos}`);
      check('queda marcada como detenida, no como error genérico', porId.a.detenido === true);
      check('no se confunde con una falla de cuota', porId.a.porCuota === false);
      check('la otra tarea sigue su curso normal', porId.b.exito === true && porId.b.detenido === false);

      check('el resumen distingue las detenidas', r.resumen.fallidasDetenidas === 1);
      check('y las cuenta aparte de las de cuota', r.resumen.fallidasPorCuota === 0);
      check('registrarEstado también ve `detenido`',
        registrador.llamadas.marcar.some(m => m.id === 'a' && m.estado === 'error' && m.detenido === true));
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('limpiarControlPrevio corre una sola vez por tarea, antes de cualquier ejecutar (FEAT-012)', async () => {
      // Regresión de la auditoría adversarial (agy_audit, 2026-09-09): la
      // primera versión limpiaba el centinela DENTRO de `ejecutar`, en cada
      // intento — lo que borraba un pedido de detención legítimo escrito
      // mientras una tarea esperaba turno, o durante el backoff de un
      // reintento por cuota. Acá se prueba la garantía de orden que lo evita:
      // el barrido pasa una sola vez, antes de que arranque el primer lote.
      const eventos = [];
      const limpiarControlPrevio = (taskId) => eventos.push(`limpiar:${taskId}`);
      const eje = ejecutorFalso({ fallar: { a: { error: 'HTTP 429 quota exceeded', veces: 2 } } });
      const ejecutarConLog = async (peticion) => {
        const id = (peticion.prompt.match(/hacer ([a-z0-9-]+)/) || [])[1];
        eventos.push(`ejecutar:${id}`);
        return eje.ejecutar(peticion);
      };

      await lanzarFanout({
        repoPath: repo,
        slug: 'con-orden',
        tareas: [tarea('a', ['src/a.js']), tarea('b', ['src/b.js'])],
        esperaBaseMs: 1
      }, { ejecutar: ejecutarConLog, alDormir: async () => {}, limpiarControlPrevio });

      const ultimaLimpieza = Math.max(eventos.indexOf('limpiar:a'), eventos.indexOf('limpiar:b'));
      const primerEjecutar = Math.min(
        eventos.indexOf('ejecutar:a'),
        eventos.indexOf('ejecutar:b') === -1 ? Infinity : eventos.indexOf('ejecutar:b')
      );
      check('ambas limpiezas ocurren antes de cualquier ejecutar', ultimaLimpieza < primerEjecutar, eventos.join(','));

      check('a se reintenta 3 veces por cuota pero se limpia una sola vez',
        eventos.filter(e => e === 'ejecutar:a').length === 3 &&
        eventos.filter(e => e === 'limpiar:a').length === 1,
        eventos.join(','));
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('sin limpiarControlPrevio no cambia nada (no-op por defecto)', async () => {
      const eje = ejecutorFalso();
      const r = await lanzarFanout({
        repoPath: repo, slug: 'sin-limpieza', tareas: [tarea('a', ['src/a.js'])]
      }, { ejecutar: eje.ejecutar });
      check('funciona igual sin limpiarControlPrevio', r.lanzado === true && r.resumen.exitosas === 1);
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('limpiarProgresoPrevio corre una sola vez por tarea, antes de cualquier ejecutar (FEAT-009)', async () => {
      // Mismo patrón que limpiarControlPrevio (FEAT-012): un barrido único
      // antes del primer lote, no por intento — evita mezclar el log de una
      // corrida anterior con el mismo slug/taskId.
      const eventos = [];
      const limpiarProgresoPrevio = (taskId) => eventos.push(`limpiar:${taskId}`);
      const eje = ejecutorFalso({ fallar: { a: { error: 'HTTP 429 quota exceeded', veces: 1 } } });
      const ejecutarConLog = async (peticion) => {
        const id = (peticion.prompt.match(/hacer ([a-z0-9-]+)/) || [])[1];
        eventos.push(`ejecutar:${id}`);
        return eje.ejecutar(peticion);
      };

      await lanzarFanout({
        repoPath: repo,
        slug: 'con-orden-log',
        tareas: [tarea('a', ['src/a.js']), tarea('b', ['src/b.js'])],
        esperaBaseMs: 1
      }, { ejecutar: ejecutarConLog, alDormir: async () => {}, limpiarProgresoPrevio });

      const ultimaLimpieza = Math.max(eventos.indexOf('limpiar:a'), eventos.indexOf('limpiar:b'));
      const primerEjecutar = Math.min(eventos.indexOf('ejecutar:a'), eventos.indexOf('ejecutar:b'));
      check('ambas limpiezas ocurren antes de cualquier ejecutar', ultimaLimpieza < primerEjecutar, eventos.join(','));
      check('a se reintenta 2 veces por cuota pero se limpia una sola vez',
        eventos.filter(e => e === 'ejecutar:a').length === 2 &&
        eventos.filter(e => e === 'limpiar:a').length === 1,
        eventos.join(','));
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('sin limpiarProgresoPrevio no cambia nada (no-op por defecto)', async () => {
      const eje = ejecutorFalso();
      const r = await lanzarFanout({
        repoPath: repo, slug: 'sin-limpieza-log', tareas: [tarea('a', ['src/a.js'])]
      }, { ejecutar: eje.ejecutar });
      check('funciona igual sin limpiarProgresoPrevio', r.lanzado === true && r.resumen.exitosas === 1);
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('alArrancar (FEAT-010) se llama una sola vez, con el reparto completo, antes del primer lote', async () => {
      const llamadas = [];
      const alArrancar = (asignacion) => llamadas.push({ momento: 'alArrancar', asignacion });
      const eje = ejecutorFalso();
      const ejecutarConLog = async (peticion) => {
        llamadas.push({ momento: 'ejecutar' });
        return eje.ejecutar(peticion);
      };

      await lanzarFanout({
        repoPath: repo,
        slug: 'con-ventana',
        tareas: [tarea('a', ['src/a.js']), tarea('b', ['src/b.js'])]
      }, { ejecutar: ejecutarConLog, alArrancar });

      check('se llamó exactamente una vez', llamadas.filter(l => l.momento === 'alArrancar').length === 1, JSON.stringify(llamadas.map(l => l.momento)));

      const iAlArrancar = llamadas.findIndex(l => l.momento === 'alArrancar');
      const iPrimerEjecutar = llamadas.findIndex(l => l.momento === 'ejecutar');
      check('corre antes de cualquier ejecutar', iAlArrancar < iPrimerEjecutar, JSON.stringify(llamadas.map(l => l.momento)));

      const asignacionRecibida = llamadas.find(l => l.momento === 'alArrancar').asignacion;
      check('recibe las 2 tareas con su tarea y worktree', asignacionRecibida.length === 2 &&
        asignacionRecibida.every(a => a.tarea && a.tarea.id && a.worktree && a.worktree.ruta));
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('sin alArrancar no cambia nada (no-op por defecto)', async () => {
      const eje = ejecutorFalso();
      const r = await lanzarFanout({
        repoPath: repo, slug: 'sin-ventana', tareas: [tarea('a', ['src/a.js'])]
      }, { ejecutar: eje.ejecutar });
      check('funciona igual sin alArrancar', r.lanzado === true && r.resumen.exitosas === 1);
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('engancha el estado de orquestación (FEAT-005 V1)', async () => {
      const eje = ejecutorFalso({ fallar: { a: { error: 'HTTP 429 quota exceeded', veces: 1 } } });
      const registrador = registradorFalso();

      const r = await lanzarFanout({
        repoPath: repo,
        slug: 'con-estado',
        tareas: [tarea('a', ['src/a.js']), tarea('b', ['src/b.js'])],
        concurrencia: 2,
        esperaBaseMs: 1
      }, { ejecutar: eje.ejecutar, alDormir: async () => {}, registrarEstado: registrador });

      check('lanza igual que sin registrador', r.lanzado === true);
      check('iniciar() se llama una vez con la ramaBase y concurrencia resueltas',
        registrador.llamadas.iniciar.length === 1 &&
        registrador.llamadas.iniciar[0].ramaBase === r.ramaBase &&
        registrador.llamadas.iniciar[0].concurrencia === 2);

      check('la tarea sin fricción va corriendo→ok',
        registrador.estadosDe('b').join('>') === 'corriendo>ok');
      check('la de cuota pasa por reintentando antes de cerrar en ok',
        registrador.estadosDe('a').join('>') === 'corriendo>reintentando>ok',
        registrador.estadosDe('a').join('>'));

      check('terminar() se llama exactamente una vez', registrador.llamadas.terminar === 1);
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('sin registrador de estado no cambia nada (no-op por defecto)', async () => {
      const eje = ejecutorFalso();
      // Mismo camino feliz que arriba, pero sin deps.registrarEstado: no debe
      // explotar ni cambiar el resultado — es exactamente el comportamiento
      // previo a FEAT-005 V1.
      const r = await lanzarFanout({
        repoPath: repo, slug: 'sin-registrador', tareas: [tarea('a', ['src/a.js'])]
      }, { ejecutar: eje.ejecutar });
      check('funciona igual sin registrarEstado', r.lanzado === true && r.resumen.exitosas === 1);
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('cuota que no cede', async () => {
      const eje = ejecutorFalso({ fallar: { a: { error: '429 rate limit' } } });
      const r = await lanzarFanout({
        repoPath: repo,
        slug: 'sin-cuota',
        tareas: [tarea('a', ['src/a.js'])],
        esperaBaseMs: 1
      }, { ejecutar: eje.ejecutar, alDormir: async () => {} });

      check('acaba fallando', r.resultados[0].exito === false);
      check('la marca como fallo por cuota', r.resultados[0].porCuota === true);
      check('el resumen la contabiliza aparte', r.resumen.fallidasPorCuota === 1);
      check('agotó los reintentos previstos', r.resultados[0].intentos === 3, `intentos = ${r.resultados[0].intentos}`);
    });
  } finally { borrar(repo); }

  repo = crearRepo();
  try {
    await group('respeta una rama de trabajo existente', async () => {
      execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'develop'], { stdio: 'ignore' });
      const eje = ejecutorFalso();
      const r = await lanzarFanout({
        repoPath: repo, slug: 'sobre-develop', tareas: [tarea('a', ['src/a.js'])]
      }, { ejecutar: eje.ejecutar });

      check('usa develop como base sin crear nada', r.ramaBase === 'develop' && r.ramaBaseCreada === false, r.ramaBase);
    });
  } finally { borrar(repo); }

  await group('validación de argumentos', async () => {
    const repoTmp = crearRepo();
    try {
      let lanzo = false;
      try {
        await lanzarFanout({ repoPath: repoTmp, slug: 'x', tareas: [tarea('a', ['a.js'])], concurrencia: 0 },
          { ejecutar: async () => ({ success: true }) });
      } catch { lanzo = true; }
      check('rechaza concurrencia 0', lanzo);

      let sinEjecutor = false;
      try {
        await lanzarFanout({ repoPath: repoTmp, slug: 'x', tareas: [tarea('a', ['a.js'])] }, {});
      } catch { sinEjecutor = true; }
      check('exige un ejecutor', sinEjecutor);
    } finally { borrar(repoTmp); }
  });

  await group('cableado de la tool MCP agy_fanout', async () => {
    const { startServer, removeFixture } = require('./lib/mcp-client');
    const repoTmp = crearRepo();
    const capturas = path.join(repoTmp, 'cap.jsonl');
    fs.writeFileSync(capturas, '');
    const s = startServer({ cwd: repoTmp, captureFile: capturas });

    try {
      await s.initialize();

      const listado = await s.listTools();
      const nombres = listado.result.tools.map(t => t.name);
      check('la tool está publicada', nombres.includes('agy_fanout'), nombres.join(', '));

      const def = listado.result.tools.find(t => t.name === 'agy_fanout');
      check('exige slug y tareas',
        def.inputSchema.required.includes('slug') && def.inputSchema.required.includes('tareas'));
      check('no expone sandbox (rompe el aislamiento)',
        !JSON.stringify(def.inputSchema).includes('sandbox'));
      check('cada tarea exige declarar archivos',
        def.inputSchema.properties.tareas.items.required.includes('archivos'));

      // Un reparto con solapamiento debe rebotar sin lanzar agy ni tocar git.
      const r = await s.callTool('agy_fanout', {
        slug: 'cableado',
        tareas: [
          { id: 'a', prompt: 'x', archivos: ['src/x.js'] },
          { id: 'b', prompt: 'y', archivos: ['src/x.js'] }
        ]
      });

      check('devuelve isError ante reparto inválido', r.result.isError === true);
      check('explica el solapamiento', /a ↔ b/.test(r.result.content[0].text), r.result.content[0].text);
      check('nunca lanzó agy', fs.readFileSync(capturas, 'utf8').trim() === '');
      check('no dejó el repo fuera de main',
        execFileSync('git', ['-C', repoTmp, 'branch', '--show-current'], { encoding: 'utf8' }).trim() === 'main');
    } finally {
      await s.stop();
      removeFixture(repoTmp);
    }
  });

  await group('agy_fanout mata un subagente en vuelo vía centinela (FEAT-012)', async () => {
    const { startServer, removeFixture } = require('./lib/mcp-client');
    const { marcarDetencion } = require('../mcp-server/fanout-estado.js');
    const repoTmp = crearRepo();
    const capturas = path.join(repoTmp, 'cap.jsonl');
    fs.writeFileSync(capturas, '');

    // Sondeo rápido para que el test no tenga que esperar los 2s de producción,
    // y un stub que se queda "corriendo" 2.5s para poder demostrar que se lo
    // mata ANTES de que termine solo, no que casualmente coincida con el cierre.
    fs.mkdirSync(path.join(repoTmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repoTmp, '.claude', 'antigravity.json'),
      JSON.stringify({ fanout_stop_check_interval_ms: 50 }));

    const previoHold = process.env.STUB_HOLD_MS;
    process.env.STUB_HOLD_MS = '2500';
    const s = startServer({ cwd: repoTmp, captureFile: capturas });

    try {
      await s.initialize();

      const inicio = Date.now();
      const promesa = s.callTool('agy_fanout', {
        slug: 'con-stop',
        tareas: [{ id: 'solo', prompt: 'hacer algo', archivos: ['src/solo.js'] }],
        concurrencia: 1
      }, 15000);

      // Reescribe el centinela cada 25ms hasta que la tool call resuelva, en
      // vez de un único write cronometrado a mano. La primera versión de este
      // test escribía una sola vez tras un `setTimeout(200)`, apostando a que
      // ya hubiera pasado el barrido de centinelas viejos del lado del
      // servidor (preparar rama base + crear worktrees, variable e
      // independiente de este proceso) — una auditoría adversarial
      // (agy_audit, 2026-09-09) lo reprodujo como flaky en un entorno donde
      // esa preparación tardó más que el margen elegido. Reescribir en loop
      // hasta que la promesa resuelva es correcto para cualquier timing: el
      // servidor solo barre centinelas ANTES del primer lote (fanout.js,
      // `limpiarControlPrevio`) y nunca más durante la corrida, así que
      // cualquier escritura nuestra posterior a ese barrido sobrevive hasta
      // que `stopCheck` la consuma.
      let sigueEscribiendo = true;
      const reescribir = async () => {
        while (sigueEscribiendo) {
          marcarDetencion(repoTmp, 'con-stop', 'solo', 'se fue por las ramas');
          await new Promise(r => setTimeout(r, 25));
        }
      };
      const loopEscritura = reescribir();

      const r = await promesa;
      const elapsedMs = Date.now() - inicio;
      sigueEscribiendo = false;
      await loopEscritura;

      check('resuelve bien antes de los 2.5s del hold', elapsedMs < 2000, `elapsed = ${elapsedMs}ms`);
      check('no devuelve isError', r.result.isError !== true, JSON.stringify(r.result));
      const texto = r.result.content[0].text;
      check('la tabla marca la tarea como detenida', /\bdetenida\b/.test(texto), texto);
      check('el resumen cuenta 1 detenida', /1 detenidas/.test(texto), texto);

      const eventos = fs.readFileSync(capturas, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      check('efectivamente se invocó kill() sobre el proceso', eventos.some(e => e.event === 'kill'), JSON.stringify(eventos));
    } finally {
      await s.stop();
      removeFixture(repoTmp);
      if (previoHold === undefined) delete process.env.STUB_HOLD_MS;
      else process.env.STUB_HOLD_MS = previoHold;
    }
  });

  await group('agy_fanout escribe el log NDJSON por subagente (FEAT-009)', async () => {
    const { startServer, removeFixture } = require('./lib/mcp-client');
    const { rutaProgreso } = require('../mcp-server/fanout-estado.js');
    const repoTmp = crearRepo();
    const capturas = path.join(repoTmp, 'cap.jsonl');
    fs.writeFileSync(capturas, '');
    const s = startServer({ cwd: repoTmp, captureFile: capturas });

    try {
      await s.initialize();

      const r = await s.callTool('agy_fanout', {
        slug: 'con-log',
        tareas: [{ id: 'solo', prompt: 'hacer algo', archivos: ['src/solo.js'] }],
        concurrencia: 1
      }, 15000);

      check('no devuelve isError', r.result.isError !== true, JSON.stringify(r.result));

      const ruta = rutaProgreso(repoTmp, 'con-log', 'solo');
      check('el log quedó escrito en disco', fs.existsSync(ruta), ruta);

      const lineas = fs.readFileSync(ruta, 'utf8').trim().split('\n').filter(Boolean);
      const eventosLog = lineas.map(l => JSON.parse(l));
      check('trae las 3 líneas que emite el stub, sin bufferear', eventosLog.length === 3, JSON.stringify(eventosLog));
      check('en el mismo orden en que las emite agy', eventosLog.map(e => e.event).join(',') === 'init,step_update,result',
        eventosLog.map(e => e.event).join(','));

      check('el texto de respuesta menciona dónde está el log',
        /\.agy-progress-con-log-<taskId>\.jsonl/.test(r.result.content[0].text), r.result.content[0].text);
    } finally {
      await s.stop();
      removeFixture(repoTmp);
    }
  });

  await group('agy_fanout respeta fanout_progress_log: false (FEAT-009)', async () => {
    const { startServer, removeFixture } = require('./lib/mcp-client');
    const { rutaProgreso } = require('../mcp-server/fanout-estado.js');
    const repoTmp = crearRepo();
    fs.mkdirSync(path.join(repoTmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repoTmp, '.claude', 'antigravity.json'), JSON.stringify({ fanout_progress_log: false }));
    const capturas = path.join(repoTmp, 'cap.jsonl');
    fs.writeFileSync(capturas, '');
    const s = startServer({ cwd: repoTmp, captureFile: capturas });

    try {
      await s.initialize();

      const r = await s.callTool('agy_fanout', {
        slug: 'sin-log',
        tareas: [{ id: 'solo', prompt: 'hacer algo', archivos: ['src/solo.js'] }],
        concurrencia: 1
      }, 15000);

      check('igual funciona sin el log', r.result.isError !== true, JSON.stringify(r.result));
      check('no escribe el archivo', !fs.existsSync(rutaProgreso(repoTmp, 'sin-log', 'solo')));
      check('no menciona el log en el resumen', !/agy-progress/.test(r.result.content[0].text));
    } finally {
      await s.stop();
      removeFixture(repoTmp);
    }
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
