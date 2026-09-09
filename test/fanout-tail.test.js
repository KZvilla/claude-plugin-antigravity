/**
 * Contenido de cada pane de wt (FEAT-010): formateo de línea y seguimiento
 * incremental de un log que crece por apéndice.
 *
 * `formatearLinea` y `crearSeguidor().leerNuevas()` son funciones puras —
 * sin timers, sin spawns — así que se prueban directo, sin depender del
 * loop de `setInterval` que usa `seguir()` en producción.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { check, group, report } = require('./lib/assert');
const { formatearLinea, interpretarEvento, crearSeguidor, seguir } = require('../mcp-server/fanout-tail.js');

/**
 * Secuencia REAL capturada de `agy` v1.1.28 el 2026-09-09
 * (`agy -p "cuenta del 1 al 5..." --output-format stream-json --mode plan`).
 * Se guarda literal a propósito: el demo con el que se validó FEAT-013
 * emitía un delta prolijo por "pensamiento" y por eso escondió que la prosa
 * viene partida A MITAD DE PALABRA. Los tests se hacen contra esto, no
 * contra datos inventados que quedan lindos.
 */
const CAPTURA_REAL = [
  { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', duration_seconds: 2.59, usage: { total_tokens: 18406 } } },
  { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: 'C:\\brain\\plan_conteo.md' } } } },
  { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', duration_seconds: 0.035, tool_info: { name: 'write_to_file', parameters: { TargetFile: 'C:\\brain\\plan_conteo.md' } } } },
  { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'He creado el plan' } },
  { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: ' de implementación en e' } },
  { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'l artefacto [plan_conteo' } },
  { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '.md](file:///C:/brain/' } },
  { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'plan_conteo.md).\n\nPor favor, revisa el plan.' } }
].map(e => JSON.stringify(e));

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

async function main() {
  await group('formatearLinea — eventos conocidos', () => {
    check('init con conversation_id',
      /▶ iniciado \(abcd1234\)/.test(formatearLinea(JSON.stringify({ event: 'init', conversation_id: 'abcd1234-resto-truncado' }))));

    check('init sin conversation_id no revienta',
      /▶ iniciado/.test(formatearLinea(JSON.stringify({ event: 'init' }))));

    const step = formatearLinea(JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', text_delta: 'hola   mundo' }
    }));
    check('step_update de agent_response muestra el delta, espacios colapsados', /hola mundo/.test(step), step);

    check('step_update sin texto no muestra nada (null)',
      formatearLinea(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: '' } })) === null);

    check('step_update que NO es agent_response (eco del prompt) se descarta',
      formatearLinea(JSON.stringify({ event: 'step_update', step_update: { step_type: 'user_input', text_delta: 'PROMPT ECO' } })) === null);

    const okResult = formatearLinea(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', duration_seconds: 1.234 } }));
    check('result exitoso marca ✔ con duración', /✔ terminado 1\.2s/.test(okResult), okResult);

    const errResult = formatearLinea(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'se rompió' } }));
    check('result con error marca ✘ e incluye el mensaje', /✘ terminado.*se rompió/.test(errResult), errResult);
  });

  await group('interpretarEvento — la captura real de agy (FEAT-014)', () => {
    const eventos = CAPTURA_REAL.map(interpretarEvento);

    check('el eco del prompt (user_input) no se muestra', eventos[0] === null);
    check('un agent_response que cierra en DONE sin texto tampoco (paso de "pensamiento")', eventos[1] === null);

    check('el paso `tool` ACTIVE sí se muestra — antes se descartaba entero',
      eventos[2] && eventos[2].tipo === 'tool', JSON.stringify(eventos[2]));
    check('resume la herramienta con su parámetro', /write_to_file → .*plan_conteo\.md/.test(eventos[2].texto), eventos[2].texto);
    check('el DONE de la misma herramienta no repite la línea', eventos[3] === null);

    const prosa = eventos.slice(4);
    check('los 5 deltas salen TODOS, sin retener ninguno', prosa.every(e => e && e.tipo === 'prosa'), JSON.stringify(prosa));
    check('todos comparten el mismo stepIndex (la clave para unirlos al pintar)',
      prosa.every(e => e.stepIndex === 3), JSON.stringify(prosa.map(e => e.stepIndex)));

    // Lo que importa: concatenados dan la frase entera, sin palabras partidas.
    const unido = prosa.map(e => e.texto).join('');
    check('concatenados reconstruyen el texto original',
      unido.startsWith('He creado el plan de implementación en el artefacto'), unido);
    check('no se pierde el final', /Por favor, revisa el plan\.$/.test(unido), unido);
    check('conserva los saltos de línea (no los aplasta como la CLI)', unido.includes('\n\n'));
  });

  await group('interpretarEvento — un paso sin DONE se muestra igual (regresión del plan rechazado)', () => {
    // El plan original acumulaba hasta el `DONE` del paso. Si a un subagente
    // lo matan (FEAT-012), ese DONE nunca llega: todo lo acumulado se habría
    // perdido. Acá se comprueba que un paso truncado a mitad igual entrega
    // todo lo que alcanzó a llegar.
    const truncado = CAPTURA_REAL.slice(4, 7).map(interpretarEvento);
    check('los 3 deltas del paso inconcluso se entregan', truncado.every(e => e && e.tipo === 'prosa'));
    check('con su texto completo hasta donde llegó',
      truncado.map(e => e.texto).join('') === 'He creado el plan de implementación en el artefacto [plan_conteo',
      truncado.map(e => e.texto).join(''));
  });

  await group('interpretarEvento — herramientas con formas de parámetro distintas', () => {
    const conCommandLine = interpretarEvento(JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 5, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'npm test' } } }
    }));
    check('run_command usa su propio parámetro, no TargetFile', /run_command → npm test/.test(conCommandLine.texto), conCommandLine.texto);

    const desconocida = interpretarEvento(JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 6, state: 'ACTIVE', step_type: 'tool', tool_name: 'herramienta_nueva', tool_info: { parameters: { ParametroRaro: 'x' } } }
    }));
    check('una herramienta desconocida degrada al nombre solo, nunca a "undefined"',
      desconocida.texto === 'herramienta_nueva', desconocida.texto);

    const payload = interpretarEvento(JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 7, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: 'a.js', CodeContent: 'x'.repeat(50000) } } }
    }));
    check('no vuelca el payload de kilobytes', payload.texto.length < 200, `largo = ${payload.texto.length}`);
    check('pero sí muestra el archivo', /a\.js/.test(payload.texto), payload.texto);

    const rutaLarga = interpretarEvento(JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 8, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/muy/'.repeat(80) + 'final.js' } } }
    }));
    check('trunca un parámetro largo con elipsis', rutaLarga.texto.length < 200 && rutaLarga.texto.includes('…'), rutaLarga.texto);
  });

  await group('formatearLinea (CLI) sigue siendo una línea por evento', () => {
    // La CLI no puede volver atrás a unir lo ya impreso, así que ahí sí se
    // aplasta a una sola línea. El contrato viejo no se rompe.
    const lineas = CAPTURA_REAL.map(c => formatearLinea(c, { conHora: false })).filter(l => l !== null);
    check('sigue habiendo una línea por evento mostrable', lineas.length === 6, String(lineas.length));
    check('la prosa va aplastada a una línea', lineas.every(l => !l.includes('\n')), JSON.stringify(lineas));
    check('la herramienta aparece con su marca', lineas.some(l => l.startsWith('🔧')), JSON.stringify(lineas));
  });

  await group('formatearLinea — resiliencia (no tira excepción)', () => {
    let lanzo = false;
    let r;
    try { r = formatearLinea('esto no es json'); } catch { lanzo = true; }
    check('JSON corrupto no revienta', !lanzo);
    check('lo muestra crudo con marca de desconocido', /？/.test(r), r);

    lanzo = false;
    try { r = formatearLinea(JSON.stringify({ event: 'algo_nunca_visto' })); } catch { lanzo = true; }
    check('evento desconocido no revienta', !lanzo);
    check('lo señala como desconocido', /？ evento: algo_nunca_visto/.test(r), r);

    lanzo = false;
    try { formatearLinea(''); } catch { lanzo = true; }
    check('línea vacía no revienta', !lanzo);
  });

  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-tail-'));
  try {
    await group('crearSeguidor — lee solo lo nuevo desde la última llamada', () => {
      const ruta = path.join(dir, 'log.jsonl');
      const seguidor = crearSeguidor(ruta);

      check('sin archivo, no revienta y no hay nada', JSON.stringify(seguidor.leerNuevas()) === '[]');

      fs.writeFileSync(ruta, JSON.stringify({ event: 'init' }) + '\n');
      const primera = seguidor.leerNuevas();
      check('primera lectura trae la línea', primera.length === 1);

      const segunda = seguidor.leerNuevas();
      check('segunda lectura no repite lo ya leído', segunda.length === 0);

      fs.appendFileSync(ruta, JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } }) + '\n');
      const tercera = seguidor.leerNuevas();
      check('solo trae la línea nueva, no la vieja de nuevo', tercera.length === 1 && JSON.parse(tercera[0]).event === 'result');
    });

    await group('crearSeguidor — línea partida entre dos escrituras', () => {
      const ruta = path.join(dir, 'partida.jsonl');
      const seguidor = crearSeguidor(ruta);

      const linea = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'entera' } });
      fs.writeFileSync(ruta, linea.slice(0, 10)); // a medio escribir, sin \n
      check('un fragmento sin salto de línea no se entrega todavía', seguidor.leerNuevas().length === 0);

      fs.appendFileSync(ruta, linea.slice(10) + '\n'); // se completa
      const completas = seguidor.leerNuevas();
      check('se entrega entera una vez que llega el resto', completas.length === 1 && completas[0] === linea, completas[0]);
    });

    await group('crearSeguidor — el archivo se reinicia (corrida nueva con el mismo path)', () => {
      const ruta = path.join(dir, 'reinicio.jsonl');
      fs.writeFileSync(ruta, JSON.stringify({ event: 'init' }) + '\n'.repeat(1) + JSON.stringify({ event: 'result', result: {} }) + '\n');
      const seguidor = crearSeguidor(ruta);
      check('lee las 2 líneas iniciales', seguidor.leerNuevas().length === 2);

      // Una corrida nueva trunca y reescribe más corto que lo ya leído.
      fs.writeFileSync(ruta, JSON.stringify({ event: 'init' }) + '\n');
      const trasReinicio = seguidor.leerNuevas();
      check('detecta el achique y vuelve a leer desde el principio', trasReinicio.length === 1, JSON.stringify(trasReinicio));
    });

    await group('seguir() imprime el nombre como primera línea (no depende de --title)', () => {
      const ruta = path.join(dir, 'seguir.jsonl');
      const impresas = [];
      const timer = seguir(ruta, 'mi-subagente', { escribir: (l) => impresas.push(l) });
      clearInterval(timer);

      check('primera línea es el nombre', impresas[0] === 'SUBAGENTE: mi-subagente');
      check('menciona la ruta del log', impresas.some(l => l.includes(ruta)));
    });
  } finally {
    borrar(dir);
  }

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
