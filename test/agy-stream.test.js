/**
 * executeAgyStreaming (FEAT-009) — invocación de agy en modo fan-out
 * (un turno vía `-p`, NO stdin) con la salida NDJSON parseada a medida que
 * llega. Se prueba contra `process.execPath -e "<script>"` en vez de un
 * `agy` real: un proceso Node de verdad, así que ejercita el spawn, el
 * readline sobre stdout y los timers tal como el código de producción los
 * usa — sin depender de que `agy` esté instalado en la máquina que corre
 * los tests. `crearAcumuladorStream` (el parser NDJSON en sí) ya tiene su
 * propia cobertura en narrate.test.js con líneas sintéticas; acá se prueba
 * el spawn wrapper: onLine en vivo, stopCheck (FEAT-012) y los caminos de
 * error.
 */
const { check, group, report } = require('./lib/assert');
const { executeAgyStreaming } = require('../mcp-server/agy-stream.js');

// Imprime una lista de eventos NDJSON, uno por línea, con un delay opcional
// antes de cada uno — para poder simular un subagente "lento" sin depender
// de sleeps largos reales.
function scriptQueImprime(eventos, delayMsPorLinea = 0) {
  const payload = JSON.stringify(eventos);
  return `
    const eventos = ${payload};
    let i = 0;
    function siguiente() {
      if (i >= eventos.length) return;
      console.log(JSON.stringify(eventos[i]));
      i++;
      setTimeout(siguiente, ${delayMsPorLinea});
    }
    siguiente();
  `;
}

async function main() {
  await group('camino feliz: mismo contrato de retorno que executeAgy', async () => {
    const cid = 'cid-feliz';
    const eventos = [
      { event: 'init', conversation_id: cid, init: {} },
      { event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'hola' } },
      { event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'hola', duration_seconds: 0.1, usage: { total_tokens: 3 } } }
    ];

    const r = await executeAgyStreaming(process.execPath, ['-e', scriptQueImprime(eventos), '--', '--output-format', 'ignorado-por-node'], { timeoutMinutes: 1 });

    check('success true', r.success === true, JSON.stringify(r));
    check('data.response trae el texto', r.data.response === 'hola', JSON.stringify(r.data));
    check('data.conversation_id', r.data.conversation_id === cid);
    check('data.usage', r.data.usage && r.data.usage.total_tokens === 3);
  });

  await group('onLine se llama por cada línea, en orden, antes del cierre', async () => {
    const eventos = [
      { event: 'init', conversation_id: 'x', init: {} },
      { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'a' } },
      { event: 'result', result: { status: 'SUCCESS', response: 'a' } }
    ];

    const recibidas = [];
    const r = await executeAgyStreaming(process.execPath, ['-e', scriptQueImprime(eventos, 5), '--', '--output-format', 'ignorado-por-node'], {
      timeoutMinutes: 1,
      onLine: (linea) => recibidas.push(JSON.parse(linea).event)
    });

    check('resolvió bien', r.success === true, JSON.stringify(r));
    check('recibió las 3 líneas en orden', recibidas.join(',') === 'init,step_update,result', recibidas.join(','));
  });

  await group('error del result (status ERROR)', async () => {
    const eventos = [{ event: 'result', result: { status: 'ERROR', error: 'se rompió adentro' } }];
    const r = await executeAgyStreaming(process.execPath, ['-e', scriptQueImprime(eventos), '--', '--output-format', 'ignorado-por-node'], { timeoutMinutes: 1 });

    check('success false', r.success === false);
    check('el error del result queda en el mensaje', /se rompió adentro/.test(r.error), r.error);
  });

  await group('falla al spawnear (binario inexistente)', async () => {
    const r = await executeAgyStreaming('binario-que-no-existe-xyz', [], { timeoutMinutes: 1 });
    check('success false', r.success === false);
    check('no revienta el proceso de test', typeof r.error === 'string' && r.error.length > 0);
  });

  await group('stopCheck (FEAT-012) mata antes de que el script termine solo', async () => {
    // El script espera 3s antes de imprimir nada — de sobra para que un
    // sondeo de 30ms dispare varias veces antes.
    const script = `setTimeout(() => { console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'tarde'}})); }, 3000);`;

    let consultas = 0;
    const stopCheck = () => { consultas++; return consultas >= 2 ? 'porque sí' : false; };

    let matado = false;
    const terminate = (child) => { matado = true; try { child.kill('SIGKILL'); } catch {} };

    const inicio = Date.now();
    const r = await executeAgyStreaming(process.execPath, ['-e', script, '--', '--output-format', 'ignorado-por-node'], {
      timeoutMinutes: 1,
      stopCheck,
      stopCheckIntervalMs: 30,
      terminate
    });
    const elapsedMs = Date.now() - inicio;

    check('resuelve mucho antes de los 3s del script', elapsedMs < 1000, `elapsed = ${elapsedMs}ms`);
    check('success false, stopped true', r.success === false && r.stopped === true, JSON.stringify(r));
    check('propaga el motivo', r.motivo === 'porque sí', r.motivo);
    check('llamó a terminate', matado === true);
  });

  await group('sin stopCheck no cambia nada (no-op por defecto)', async () => {
    const eventos = [{ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }];
    const r = await executeAgyStreaming(process.execPath, ['-e', scriptQueImprime(eventos), '--', '--output-format', 'ignorado-por-node'], { timeoutMinutes: 1 });
    check('funciona igual sin stopCheck', r.success === true && r.data.response === 'ok');
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
