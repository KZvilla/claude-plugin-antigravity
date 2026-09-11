/**
 * Puente MCP → `telegram-bridge/notify.js` (mcp-server/telegram-cli.js).
 *
 * Contexto: todo `telegram_ask` respondido volvía como «Process exited with
 * code 0». El hijo terminaba bien, pero un aviso de diagnóstico se colaba en
 * stdout antes del JSON y el parse exigía que stdout fuera solo ese JSON. Y con
 * el daemon caído, la pregunta salía igual con botones que nadie podía
 * atender. Esta suite fija las dos mitades: el parse tolerante y el fallar
 * rápido, este último de punta a punta contra el servidor MCP real.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, REPO_ROOT } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');
const { invokeTelegramBridge, parsearSalidaJson } = require(path.join(REPO_ROOT, 'mcp-server', 'telegram-cli.js'));

/** notify.js falso: lee el payload por stdin y responde según MODO. */
function scriptFalso(dir, modo) {
  const archivo = path.join(dir, `notify-${modo}.js`);
  fs.writeFileSync(archivo, `
    let entrada = '';
    process.stdin.on('data', (d) => { entrada += d; });
    process.stdin.on('end', () => {
      const payload = JSON.parse(entrada || '{}');
      const modo = ${JSON.stringify(modo)};
      if (modo === 'log-y-json') {
        console.log('[notify] Esperando respuesta...');
        console.log(JSON.stringify({ ok: true, answered: true, selected: 'Commit', eco: payload.question }));
      } else if (modo === 'sin-json') {
        console.log('nada parseable');
      } else if (modo === 'json-con-error') {
        console.log(JSON.stringify({ ok: true }));
        process.exitCode = 1;
      } else if (modo === 'stderr') {
        console.error('Error enviando a Telegram: fallo de red');
        process.exitCode = 1;
      }
    });
  `);
  return archivo;
}

async function main() {
  await group('parsearSalidaJson: la última línea que sea un objeto', () => {
    const conLog = parsearSalidaJson('[notify] Esperando…\n{"ok":true,"answered":true,"selected":"Commit"}\n');
    check('un log antes del JSON no lo tapa', conLog && conLog.selected === 'Commit', JSON.stringify(conLog));
    check('JSON solo', parsearSalidaJson('{"ok":true}')?.ok === true);
    check('con dos JSON gana el último', parsearSalidaJson('{"n":1}\n{"n":2}')?.n === 2);
    for (const malo of ['texto', '', '[1,2]', '42', null]) {
      check(`${JSON.stringify(malo)} → null`, parsearSalidaJson(malo) === null);
    }
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tgcli-'));
  await group('invokeTelegramBridge con un notify.js falso', async () => {
    const bien = await invokeTelegramBridge('--ask-json', { question: 'q' }, { notifyScript: scriptFalso(dir, 'log-y-json') });
    check('log + JSON con código 0 → ok', bien.ok === true && bien.selected === 'Commit' && bien.eco === 'q', JSON.stringify(bien));

    const sinJson = await invokeTelegramBridge('--ask-json', {}, { notifyScript: scriptFalso(dir, 'sin-json') });
    check('sin JSON → ok:false con un error que lo dice', sinJson.ok === false && /no trae JSON/.test(sinJson.error), JSON.stringify(sinJson));
    check('el error nuevo no es el engañoso «Process exited with code 0»', !/Process exited/.test(sinJson.error));

    const jsonConError = await invokeTelegramBridge('--ask-json', {}, { notifyScript: scriptFalso(dir, 'json-con-error') });
    check('JSON válido pero código 1 → ok:false', jsonConError.ok === false, JSON.stringify(jsonConError));

    const conStderr = await invokeTelegramBridge('--ask-json', {}, { notifyScript: scriptFalso(dir, 'stderr') });
    check('el error sale de stderr', conStderr.ok === false && /fallo de red/.test(conStderr.error), JSON.stringify(conStderr));

    const noExiste = await invokeTelegramBridge('--ask-json', {}, { notifyScript: path.join(dir, 'no-existe.js') });
    check('notify.js inexistente → ok:false', noExiste.ok === false);
  });

  // De punta a punta: el servidor MCP real, con un directorio de datos SIN
  // lock. El ask tiene que volver como error enseguida, sin esperar su timeout
  // ni salir a la red (el token es falso).
  await group('telegram_ask sin daemon falla rápido', async () => {
    const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tgask-'));
    const previo = {
      TELEGRAM_BRIDGE_DATA_DIR: process.env.TELEGRAM_BRIDGE_DATA_DIR,
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
      ALLOWED_USER_IDS: process.env.ALLOWED_USER_IDS
    };
    process.env.TELEGRAM_BRIDGE_DATA_DIR = datos;
    process.env.TELEGRAM_BOT_TOKEN = '1234567890:AAFakeTokenForTestingOnly_DoNotUse';
    process.env.ALLOWED_USER_IDS = '1';
    const server = startServer({ cwd: REPO_ROOT });
    try {
      await server.initialize();
      const inicio = Date.now();
      const res = await server.callTool('telegram_ask', { question: '¿Sigo?', timeout_seconds: 120 }, 60000);
      const segundos = (Date.now() - inicio) / 1000;
      const texto = res.result?.content?.[0]?.text || '';
      check('vuelve como error', res.result?.isError === true, texto.slice(0, 200));
      check('dice que el bot no está corriendo', /no está corriendo/.test(texto), texto.slice(0, 200));
      check('en segundos, no tras el timeout del ask', segundos < 15, `${segundos}s`);
    } finally {
      // `stop` espera la salida real: en Windows el proceso retiene su cwd
      // hasta morir, y el temporal de abajo no se podría borrar.
      await server.stop();
      for (const [k, v] of Object.entries(previo)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(datos, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
