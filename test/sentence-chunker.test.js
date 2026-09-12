/**
 * SentenceChunker (plan-chunker-punto-interno): un punto pegado a texto no
 * corta la oración, y la oración se lleva sus comillas y paréntesis de cierre.
 */
const { check, group, report } = require('./lib/assert');
const { SentenceChunker } = require('../mcp-server/lib/sentence-chunker');

// Todas las oraciones de un turno: cada delta por push y el flush del cierre.
function turno(...deltas) {
  const c = new SentenceChunker();
  const out = [];
  for (const d of deltas) out.push(...c.push(d));
  return out.concat(c.flush());
}

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  await group('punto interno: no corta', () => {
    for (const t of [
      'Ya creé el archivo prueba-freno.txt con el texto.',
      'Entrá a example.com para ver el título.',
      'Revisá el index.js del servidor MCP.',
      'Revisá el archivo .gitignore del repo.',
      'Mirá la función foo(bar.)baz ahora.'
    ]) {
      const r = turno(t);
      check(t, igual(r, [t]), JSON.stringify(r));
    }
  });

  await group('delta partido en el punto interno', () => {
    const r = turno('Ya creé el archivo prueba-freno.', 'txt con el texto.');
    check('una sola oración', igual(r, ['Ya creé el archivo prueba-freno.txt con el texto.']), JSON.stringify(r));
  });

  await group('punto al final del buffer: espera', () => {
    const c = new SentenceChunker();
    check('el push no la emite', c.push('Primera oración de prueba.').length === 0);
    const r = c.push(' Segunda oración acá.');
    check('sale con el push siguiente', igual(r, ['Primera oración de prueba.']), JSON.stringify(r));
    check('el flush emite la última', igual(c.flush(), ['Segunda oración acá.']));
  });

  await group('cierres: la oración se los lleva', () => {
    const a = turno('Dijo "todo bien." Luego se fue.');
    check('comilla tras el punto', igual(a, ['Dijo "todo bien."', 'Luego se fue.']), JSON.stringify(a));
    const b = turno('Eso dice el texto (según el informe.)');
    check('paréntesis al final del turno', igual(b, ['Eso dice el texto (según el informe.)']), JSON.stringify(b));
    const c = turno('¡Ya quedó listo!" Sigo con lo otro.');
    check('comilla tras el signo de exclamación', igual(c, ['¡Ya quedó listo!"', 'Sigo con lo otro.']), JSON.stringify(c));
    const d = turno('Dijo "todo bien.', '" Luego se fue.');
    check('cierre en el delta siguiente', igual(d, ['Dijo "todo bien."', 'Luego se fue.']), JSON.stringify(d));
    check('nada sale como puntuación suelta', [a, b, c, d].flat().every(s => /\p{L}/u.test(s)));
  });

  await group('menos de minWords: sale en el flush', () => {
    check('OK.', igual(turno('OK.'), ['OK.']));
  });

  await group('regresión', () => {
    check('número decimal', igual(turno('Pi vale 3.14 más o menos.'), ['Pi vale 3.14 más o menos.']));
    check('abreviatura', igual(turno('Hablé con el Dr. Pérez ayer.'), ['Hablé con el Dr. Pérez ayer.']));
    check('elipsis', igual(turno('Bueno... no sé qué decirte.'), ['Bueno... no sé qué decirte.']));
    const q = turno('¿Cómo te fue hoy? Bien.');
    check('pregunta y respuesta', igual(q, ['¿Cómo te fue hoy?', 'Bien.']), JSON.stringify(q));
    const e = turno('Hola, soy Alya y te escucho. Pregunta', ' lo que quieras.');
    check('dos oraciones entre deltas', igual(e, ['Hola, soy Alya y te escucho.', 'Pregunta lo que quieras.']), JSON.stringify(e));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
