/**
 * Validación del reparto de tareas atómicas (FEAT-004).
 *
 * El valor de este módulo está en lo que RECHAZA. Un validador que aprueba de
 * más es peor que ninguno: da confianza para lanzar un fan-out que va a chocar
 * en el merge, después de haber gastado la cuota. Así que la mayoría de los
 * checks son casos que deben fallar, no pasar.
 */
const { check, group, report } = require('./lib/assert');
const { validarReparto, explicarReparto, normalizarRuta, solapan } = require('../mcp-server/reparto.js');

const tarea = (id, archivos, extra = {}) => ({ id, prompt: `hacer ${id}`, archivos, ...extra });

async function main() {
  await group('reparto disjunto válido', () => {
    const r = validarReparto([
      tarea('a', ['src/auth.js', 'test/auth.test.js']),
      tarea('b', ['src/pagos.js']),
      tarea('c', ['docs/api.md'])
    ]);
    check('lo acepta', r.valido === true, JSON.stringify(r.errores.concat(r.conflictos.map(c => c.motivo))));
    check('sin conflictos', r.conflictos.length === 0);
    check('el resumen lo dice', /válido: 3 tarea/.test(explicarReparto(r)));
  });

  await group('detecta el mismo archivo en dos tareas', () => {
    const r = validarReparto([
      tarea('a', ['src/auth.js']),
      tarea('b', ['src/auth.js'])
    ]);
    check('lo rechaza', r.valido === false);
    check('reporta un conflicto', r.conflictos.length === 1, `hubo ${r.conflictos.length}`);
    check('nombra las dos tareas', r.conflictos[0].tareas.join() === 'a,b');
    check('el motivo es el archivo compartido', /mismo archivo/.test(r.conflictos[0].motivo));
    check('el texto explica por qué importa', /merge/.test(explicarReparto(r)));
  });

  await group('normaliza antes de comparar', () => {
    const mismos = [
      [['src/auth.js'], ['./src/auth.js'], 'prefijo ./'],
      [['src/auth.js'], ['src\\auth.js'], 'separador de Windows'],
      [['src/auth.js'], ['src//auth.js'], 'barra duplicada'],
      [['src/Auth.js'], ['src/auth.js'], 'diferencia de mayúsculas']
    ];
    for (const [a, b, etiqueta] of mismos) {
      const r = validarReparto([tarea('a', a), tarea('b', b)]);
      check(`detecta el choque pese a ${etiqueta}`, r.valido === false, `${a} vs ${b}`);
    }
  });

  await group('detecta subárbol que contiene a un archivo', () => {
    const r = validarReparto([
      tarea('a', ['src/']),
      tarea('b', ['src/auth.js'])
    ]);
    check('lo rechaza', r.valido === false);
    check('el motivo es la contención', /contiene a la otra/.test(r.conflictos[0].motivo));

    const anidado = validarReparto([
      tarea('a', ['src/api/']),
      tarea('b', ['src/api/v1/handler.js'])
    ]);
    check('también en profundidad', anidado.valido === false);
  });

  await group('no confunde prefijos de texto con jerarquía', () => {
    const r = validarReparto([
      tarea('a', ['src/api/']),
      tarea('b', ['src/apiario.js'])
    ]);
    check('src/apiario.js no está dentro de src/api/', r.valido === true,
      JSON.stringify(r.conflictos));

    const hermanos = validarReparto([
      tarea('a', ['src/auth.js']),
      tarea('b', ['src/authz.js'])
    ]);
    check('auth.js y authz.js son distintos', hermanos.valido === true);
  });

  await group('un archivo suelto no contiene a nadie', () => {
    // `src/auth.js` sin barra final es un archivo. Que otro declare
    // `src/auth.js/algo` es raro, pero no debe tratarse como contención de
    // subárbol por parte de un archivo.
    const r = validarReparto([
      tarea('a', ['src/auth.js']),
      tarea('b', ['src/otro.js'])
    ]);
    check('dos archivos distintos conviven', r.valido === true);
  });

  await group('rechaza rutas peligrosas', () => {
    const absolutas = validarReparto([tarea('a', ['/etc/passwd']), tarea('b', ['src/x.js'])]);
    check('rechaza ruta absoluta POSIX', absolutas.valido === false);
    check('explica que se saltaría el worktree', /worktree/.test(absolutas.errores.join(' ')));

    const win = validarReparto([tarea('a', ['C:\\Windows\\system32']), tarea('b', ['src/x.js'])]);
    check('rechaza ruta absoluta de Windows', win.valido === false);

    const traversal = validarReparto([tarea('a', ['../../secretos.env']), tarea('b', ['src/x.js'])]);
    check('rechaza traversal con ..', traversal.valido === false);
    check('lo nombra explícitamente', /\.\./.test(traversal.errores.join(' ')));
  });

  await group('valida la forma de cada tarea', () => {
    check('exige id', validarReparto([{ prompt: 'x', archivos: ['a.js'] }]).valido === false);
    check('exige prompt', validarReparto([{ id: 'a', archivos: ['a.js'] }]).valido === false);
    check('exige archivos', validarReparto([{ id: 'a', prompt: 'x' }]).valido === false);
    check('rechaza archivos vacío', validarReparto([{ id: 'a', prompt: 'x', archivos: [] }]).valido === false);

    const dupes = validarReparto([tarea('a', ['x.js']), tarea('a', ['y.js'])]);
    check('rechaza ids duplicados', dupes.valido === false);
    check('lo dice en el error', /duplicado/.test(dupes.errores.join(' ')));

    const effort = validarReparto([tarea('a', ['x.js'], { effort: 'xhigh' })]);
    check('rechaza effort inexistente (no hay xhigh)', effort.valido === false);
    check('lista los válidos', /low, medium, high/.test(effort.errores.join(' ')));

    check('acepta effort válido', validarReparto([tarea('a', ['x.js'], { effort: 'high' })]).valido === true);
  });

  await group('avisos que no invalidan', () => {
    const r = validarReparto([tarea('a', ['src/x.js', './src/x.js'])]);
    check('duplicar dentro de la misma tarea no rompe', r.valido === true, JSON.stringify(r.errores));
    check('pero deja aviso', r.avisos.length === 1, JSON.stringify(r.avisos));
  });

  await group('entradas degeneradas', () => {
    check('rechaza array vacío', validarReparto([]).valido === false);
    check('rechaza null', validarReparto(null).valido === false);
    check('rechaza no-array', validarReparto('tareas').valido === false);
  });

  await group('reporta todos los solapamientos, no solo el primero', () => {
    const r = validarReparto([
      tarea('a', ['src/x.js', 'src/y.js']),
      tarea('b', ['src/x.js']),
      tarea('c', ['src/y.js'])
    ]);
    check('encuentra los dos choques', r.conflictos.length === 2, `encontró ${r.conflictos.length}`);
    const texto = explicarReparto(r);
    check('los lista a ambos en el texto', /a ↔ b/.test(texto) && /a ↔ c/.test(texto), texto);
  });

  await group('primitivas expuestas', () => {
    check('normalizarRuta conserva la marca de subárbol', normalizarRuta('src/').esDirectorio === true);
    check('normalizarRuta limpia ./ y barras', normalizarRuta('./src//a.js').ruta === 'src/a.js');
    check('solapan compara por segmento',
      solapan(normalizarRuta('src/'), normalizarRuta('src/a.js')) === true);
    check('solapan no marca hermanos',
      solapan(normalizarRuta('src/a.js'), normalizarRuta('src/b.js')) === false);
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
