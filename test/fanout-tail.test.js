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
const { formatearLinea, crearSeguidor, seguir } = require('../mcp-server/fanout-tail.js');

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
