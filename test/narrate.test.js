/**
 * agy_narrate y agy_say son dos herramientas con contratos distintos.
 *
 * Contexto: `agy_narrate` nacio como «una pequena narracion de la sesion»: no
 * recibe texto, lo deriva del log. Cuando hizo falta narrar un texto concreto,
 * la opcion facil era anadirle un `text` opcional — y eso degrada la seleccion
 * de herramienta, porque la mitad de los parametros quedan sin sentido en cada
 * modo y la descripcion tiene que decir «narra la sesion, salvo que pases
 * texto». Los modelos eligen leyendo esa descripcion.
 *
 * Esta suite fija las dos mitades del contrato: la separacion en la superficie
 * de herramientas, y el saneado determinista del texto hablado, que es donde
 * vive el riesgo real — ese texto se sintetiza, se manda al chat de Telegram y
 * queda escrito en daemon.log.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, REPO_ROOT } = require('./lib/mcp-client');
const { preprocessSessionLog } = require(path.join(__dirname, '..', 'mcp-server', 'session-log.js'));
const { check, group, report } = require('./lib/assert');
const {
  normalizeSpokenText,
  getPolishPrompt,
  SPOKEN_TEXT_LIMIT
} = require(path.join(REPO_ROOT, 'mcp-server', 'spoken-text.js'));

const FAKE_TOKEN = '1234567890:AAFakeTokenForTestingOnly_DoNotUse';

async function main() {
  // --- Superficie de herramientas ----------------------------------------
  const server = startServer({ cwd: REPO_ROOT });
  await server.initialize();
  const tools = (await server.listTools()).result.tools;
  const say = tools.find(t => t.name === 'agy_say');
  const narrate = tools.find(t => t.name === 'agy_narrate');

  await group('agy_say y agy_narrate son herramientas separadas', () => {
    check('agy_say esta en tools/list', !!say);
    check('agy_narrate sigue existiendo', !!narrate);
    check('agy_say exige `text`', say && JSON.stringify(say.inputSchema.required) === '["text"]');
    check('agy_say acepta `polish`', !!(say && say.inputSchema.properties.polish));
    // La razon de ser de la division: cada descripcion tiene que decir cuando
    // NO usarse, o el modelo elegira la equivocada.
    check('agy_say remite a agy_narrate para resumir la sesion', !!(say && /agy_narrate/.test(say.description)));
    check('agy_narrate declara que no recibe texto', !!(narrate && /takes no text/i.test(narrate.description)));
    check('agy_narrate NO acepta `text`', narrate && !narrate.inputSchema.properties.text);
    check('agy_say NO acepta `session_id`', say && !say.inputSchema.properties.session_id);
  });

  await group('telegram_bridge_status diagnostica el desfase entre copias', async () => {
    // Existe por una razon concreta: durante el desarrollo, el daemon y las
    // herramientas MCP pueden salir de copias distintas del bridge. No es un
    // fallo -el estado se comparte-, pero explica por que un cambio de codigo
    // solo lo ve una mitad, y sin esta herramienta hay que deducirlo a mano.
    const t = tools.find(x => x.name === 'telegram_bridge_status');
    check('esta en tools/list', !!t);
    check('no necesita argumentos', t && JSON.stringify(t.inputSchema.properties) === '{}');
    check('se describe como read-only', !!(t && /read-only/i.test(t.description)));
    check('nombra el sintoma que resuelve', !!(t && /telegram_ask/i.test(t.description)));

    const res = await server.callTool('telegram_bridge_status', {});
    const texto = res.result && res.result.content && res.result.content[0].text;
    check('no es un error', !(res.result && res.result.isError), texto);
    check('informa que codigo corre cada mitad', !!(texto && /Herramientas MCP/.test(texto)));
    check('informa el .env efectivo', !!(texto && /Credenciales/.test(texto)));
    check('informa el estado compartido', !!(texto && /Estado compartido/.test(texto)));
    check('nombra el directorio de datos', !!(texto && /antigravity-telegram-bridge/.test(texto)));
  });

  await group('agy_say rechaza una llamada sin texto util', async () => {
    const res = await server.callTool('agy_say', { text: '   ' });
    const texto = res.result && res.result.content && res.result.content[0].text;
    check('devuelve isError', !!(res.result && res.result.isError));
    check('explica que falta `text`', !!(texto && /text/.test(texto)));
  });

  server.stop();

  // --- Saneado del texto hablado -----------------------------------------
  await group('normalizeSpokenText redacta secretos SIEMPRE', () => {
    // Es lo que hace seguro aceptar texto libre: el resultado se sintetiza, se
    // manda como caption a Telegram y se escribe en daemon.log.
    const r = normalizeSpokenText(`El token es ${FAKE_TOKEN} y ya esta`);
    check('el token no sobrevive', !r.text.includes('AAFakeToken'), r.text);
    check('queda marcado como redactado', /\[REDACTED\]/.test(r.text), r.text);

    const url = normalizeSpokenText(`fallo en https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    check('tambien dentro de una URL de la API', !url.text.includes('AAFakeToken'), url.text);
  });

  await group('normalizeSpokenText produce texto decible', () => {
    const md = normalizeSpokenText('**Listo**: revisa `bot.js` y el [informe](https://ejemplo.com/x).');
    check('quita el enfasis', !/[*_~#]/.test(md.text), md.text);
    check('conserva el texto del enlace', /informe/.test(md.text), md.text);
    check('descarta la URL', !/ejemplo\.com/.test(md.text), md.text);

    const code = normalizeSpokenText('Antes del bloque\n```js\nconst x = 1;\n```\ndespues del bloque');
    check('elimina el bloque de codigo entero', !/const x/.test(code.text), code.text);
    check('conserva lo que lo rodea', /Antes del bloque/.test(code.text) && /despues del bloque/.test(code.text), code.text);

    const ruta = normalizeSpokenText('Se modifico C:\\vs work\\proyecto\\telegram-bridge\\bot.js hoy');
    check('deja solo el nombre del fichero', /bot\.js/.test(ruta.text) && !/telegram-bridge/.test(ruta.text), ruta.text);

    const emoji = normalizeSpokenText('✅ Deploy listo 🚀 sin incidencias');
    check('descarta los emoji', !/[✅🚀]/.test(emoji.text), emoji.text);
    check('conserva las palabras', /Deploy listo/.test(emoji.text) && /sin incidencias/.test(emoji.text), emoji.text);

    const espacios = normalizeSpokenText('  varias   lineas\n\n  y   espacios  ');
    check('colapsa el espacio en blanco', espacios.text === 'varias lineas y espacios', espacios.text);

    // Quitar el enfasis deja el hueco que ocupaba: «**Listo**:» daba «Listo :».
    const puntuacion = normalizeSpokenText('**Listo**: todo bien **ya** , de verdad ¿ seguro ?');
    check('la puntuacion queda pegada a su palabra', !/\s[,.;:!?]/.test(puntuacion.text), puntuacion.text);
    check('empieza por la palabra, no por el hueco', /^Listo:/.test(puntuacion.text), puntuacion.text);
  });

  await group('normalizeSpokenText acota la longitud', () => {
    const corto = normalizeSpokenText('Una frase corta.');
    check('un texto corto no se trunca', corto.truncated === false);
    check('informa la longitud original', corto.originalLength === 'Una frase corta.'.length);

    const largo = normalizeSpokenText(('Frase de relleno numero uno. ').repeat(200));
    check('un texto largo se marca truncado', largo.truncated === true);
    check('respeta el tope', largo.text.length <= SPOKEN_TEXT_LIMIT, String(largo.text.length));
    // Cortar a media palabra suena a fallo; cortar en un punto suena a final.
    check('corta en final de frase', /\.$/.test(largo.text), largo.text.slice(-40));

    const soloRuido = normalizeSpokenText('```\ncodigo\n```');
    check('un texto que era solo codigo queda vacio', soloRuido.text === '', soloRuido.text);
  });

  await group('el prompt de polish prohibe inventar', () => {
    // Un modelo que «mejora» anadiendo hechos convierte una nota de voz en una
    // fuente de datos falsos que suena igual de fiable que una correcta.
    const p = getPolishPrompt('Deploy hecho', 'es', { name: 'Diego Alvarez' });
    check('incluye el texto original', /Deploy hecho/.test(p));
    check('prohibe anadir hechos', /Do not add facts/i.test(p));
    check('prohibe inventar un estado', /Never invent a status/i.test(p));
    check('fija el idioma', /Spanish/.test(p));
    check('pide solo el texto final', /Output ONLY the final spoken text/i.test(p));

    const en = getPolishPrompt('x', 'en', { name: 'Emily' });
    check('respeta el ingles', /English/.test(en) && !/Spanish/.test(en));

    const persona = getPolishPrompt('x', 'es', { name: 'Emily', personality: 'calida' }, true);
    check('la persona no puede cambiar el mensaje', /never at the cost of changing what the message says/i.test(persona));
  });


  // --- extraccion del checkpoint -----------------------------------------
  //
  // Contexto: una narracion real afirmo "no automated tests have run" justo
  // despues de 35 tests en verde. No fue una alucinacion — el modelo recibio
  // overallTestStatus: NO_TESTS y lo dijo fielmente. El defecto estaba en el
  // extractor, en dos sitios distintos.

  const cp = require(path.join(REPO_ROOT, 'mcp-server', 'checkpoint.js'));

  await group('isTestExecution distingue ejecutar de mencionar', () => {
    // La version anterior era comando.includes('test'). Medido sobre 1141
    // comandos de 13 sesiones reales marcaba 281, con un 68% de falsos
    // positivos; el patron actual marca 102, todos ejecuciones de verdad.
    const ejecutan = [
      'npm test', 'npm test 2>&1', 'npm run bridge:test', 'npm run --silent test:mcp',
      'cd "/x" && npm test', 'node test/run.js', 'node test-bridge.js',
      'node test/daemon-platform.test.js 2>&1', 'pytest -q', 'npx vitest run',
      'cargo test --all', 'go test ./...', 'ctest', 'CI=1 npm test', 'timeout 60 npm test',
      'for i in 1 2 3; do r=$(npm test 2>&1); done'
    ];
    const noEjecutan = [
      'ls test/',
      'echo "npm test: $?"',
      'grep -n "test" foo.js',
      'sed -n "45,120p" test-bridge.js',
      "cat > policy.js <<'EOF'\nun comentario que menciona test",
      'node --check test-bridge.js',
      'TELEGRAM_BOT_TOKEN=1234567890:AAFakeTokenForTestingOnly node bot.js',
      'npm run validate',
      'npm run bridge:daemon:check'
    ];
    const fallanPositivos = ejecutan.filter(c => !cp.isTestExecution(c));
    const fallanNegativos = noEjecutan.filter(c => cp.isTestExecution(c));
    check('detecta las ejecuciones reales', fallanPositivos.length === 0, fallanPositivos.join(' | '));
    check('no confunde mencionar con ejecutar', fallanNegativos.length === 0, fallanNegativos.join(' | '));
    // Los dos casos concretos que rompian: el heredoc y el fichero leido.
    check('un heredoc con "test" dentro no es un test', !cp.isTestExecution("cat > x.js <<'EOF'\n// test\nEOF"));
    check('node --check solo parsea, no ejecuta', !cp.isTestExecution('node --check test-bridge.js'));

    // El primer arreglo del heredoc fue "mirar solo la primera linea", y estaba
    // mal: un bloque multilinea pone el `cd` arriba y el ejecutor abajo. Se vio
    // ejercitando el extractor sobre una sesion real, no aqui — de ahi que estos
    // tres casos existan.
    check('multilinea: cd arriba, npm test abajo',
      cp.isTestExecution('cd "C:/x"\nnpm test >/dev/null 2>&1; echo "npm test: $?"'));
    check('varias lineas de comandos',
      cp.isTestExecution('cd "/x"\nnpm run bridge:test >/dev/null 2>&1\nnpm run validate >/dev/null'));

    // Y el heredoc no fue el unico contenedor de texto: el payload de `node -e`
    // es PROGRAMA, no shell, asi que un "npm test" ahi dentro es una cadena.
    check('node -e con "npm test" como literal no es un test',
      !cp.isTestExecution('cd /x && node -e "const c=[[\'npm test\',true]]; console.log(c)"'));
    check('python -c tampoco', !cp.isTestExecution('python3 -c "print(\'npm test\')"'));
    // Pero `bash -c` SI es shell: el interprete decide, no la bandera.
    check('bash -c si ejecuta shell', cp.isTestExecution('bash -c "npm test"'));
  });

  await group('testFailed usa las dos senales, y no cuenta los ceros', () => {
    // is_error no basta: canalizar la salida (| tail, | grep, > fichero)
    // enmascara el codigo de salida. Medido sobre 91 ejecuciones reales, hubo 7
    // fallos autenticos que is_error no vio y la salida si delataba.
    check('is_error manda', cp.testFailed({ isError: true, content: 'lo que sea' }) === true);
    check('detecta fallo con la salida canalizada', cp.testFailed({ isError: false, content: '1/5 suites FAILED' }) === true);
    check('detecta "3 failing"', cp.testFailed({ isError: false, content: '3 failing' }) === true);
    check('todo verde no es fallo', cp.testFailed({ isError: false, content: 'all 5 suites passed' }) === false);
    // Y al reves: un recuento en cero no puede leerse como fallo.
    check('"0 failed" no es fallo', cp.testFailed({ isError: false, content: 'Tests: 0 failed, 42 passed' }) === false);
    check('"failures: 0" no es fallo', cp.testFailed({ isError: false, content: 'failures: 0' }) === false);
    check('sin resultado devuelve null', cp.testFailed(null) === null);
  });

  await group('la ventana retrocede cuando la peticion no trae trabajo', () => {
    // Reproduce el incidente: el usuario pide narrar en una frase normal, de
    // modo que la heuristica anterior (texto < 50 caracteres y contiene
    // "narra") no se disparaba y la ventana arrancaba en esa misma peticion,
    // donde por definicion no hay trabajo todavia.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cp-'));
    const log = path.join(dir, 's.jsonl');

    const usuario = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
    const bash = (id, comando) => JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: comando } }] }
    });
    const resultado = (id, texto, esError) => JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: texto, is_error: Boolean(esError) }] }
    });
    const edicion = (f) => JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: f } }] }
    });

    // Turno 1: trabajo de verdad. Turno 2: la peticion de narrar, sin trabajo.
    fs.writeFileSync(log, [
      usuario('corrige la documentacion y procede la implementacion'),
      edicion('/repo/telegram-bridge/policy.js'),
      bash('t1', 'cd /repo && npm test 2>&1'),
      resultado('t1', 'all 5 suites passed', false),
      usuario('ya corri el npm run bridge:daemon:install, hacemos una prueba antes de pushear? Usa lagrange narrative usando Emily para narrar un resumen de lo implementado')
    ].join('\n') + '\n');

    const r = cp.extractLastCheckpoint(log);
    check('retrocede un turno', r.turnsBack === 1, String(r.turnsBack));
    check('encuentra el trabajo', r.commandsCount === 1, String(r.commandsCount));
    check('encuentra los tests', r.testExecutions.length === 1, String(r.testExecutions.length));
    check('el estado ya no es NO_TESTS', r.overallTestStatus === 'PASSED', r.overallTestStatus);
    check('el objetivo es el turno con trabajo', /corrige la documentacion/.test(r.userGoal), r.userGoal);

    // Si el ultimo turno SI trae trabajo, no se retrocede.
    fs.appendFileSync(log, [
      bash('t2', 'cd /repo && npm run bridge:test'),
      resultado('t2', '36/36 ok', false)
    ].join('\n') + '\n');
    const r2 = cp.extractLastCheckpoint(log);
    check('no retrocede si hay trabajo en el ultimo turno', r2.turnsBack === 0, String(r2.turnsBack));
    check('y narra ese turno', /lagrange narrative/.test(r2.userGoal), r2.userGoal.slice(0, 60));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await group('un fallo en la ventana no lo tapa un verde posterior', () => {
    // Antes el estado global era el de la ULTIMA ejecucion detectada, asi que
    // arreglar y reejecutar borraba el rastro del fallo — y, peor, un `sed`
    // sobre un fichero de tests podia ser la "ultima ejecucion".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cp2-'));
    const log = path.join(dir, 's.jsonl');
    const usuario = (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
    const bash = (id, c) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: c } }] } });
    const res = (id, t, e) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: t, is_error: Boolean(e) }] } });

    fs.writeFileSync(log, [
      usuario('arregla el bug'),
      bash('a', 'npm test'), res('a', '1/5 suites FAILED', false),
      bash('b', 'npm test'), res('b', 'all 5 suites passed', false)
    ].join('\n') + '\n');

    const r = cp.extractLastCheckpoint(log);
    check('se detectan las dos ejecuciones', r.testExecutions.length === 2, String(r.testExecutions.length));
    check('el checkpoint refleja el fallo', r.overallTestStatus === 'FAILED', r.overallTestStatus);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await group('preprocessSessionLog preserva las salidas de herramientas', () => {
    // Regresion: la funcion ramificaba sobre obj.type === 'tool_result', un tipo
    // raiz que no existe en el JSONL de Claude Code, y aplanaba el contenido de
    // usuario con (c.text || c.type). Resultado: cada salida de herramienta se
    // reducia a la palabra literal "tool_result" y se perdia el grueso del log.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preprocess-'));
    const log = path.join(dir, 's.jsonl');

    const linea = (o) => JSON.stringify(o);
    const usuario = (t) => linea({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
    const toolUse = (id, name, input) => linea({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const resultado = (id, content, isError) => linea({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: Boolean(isError) }] } });

    const largo = 'X'.repeat(500);
    fs.writeFileSync(log, [
      usuario('corre los tests'),
      toolUse('a', 'Bash', { command: 'npm test' }),
      resultado('a', 'ESTA-SALIDA-DEBE-SOBREVIVIR: 71/71 checks passed', false),
      toolUse('b', 'Bash', { command: 'npm run lint' }),
      resultado('b', [{ type: 'text', text: 'SALIDA-EN-BLOQUES' }], true),
      toolUse('c', 'Read', { file_path: 'x.js' }),
      resultado('c', largo, false)
    ].join('\n') + '\n');

    const { transcript, totalTurns } = preprocessSessionLog(log);
    const cuenta = (re) => (transcript.match(re) || []).length;

    check('la salida de la herramienta sobrevive al preprocesado',
      transcript.includes('ESTA-SALIDA-DEBE-SOBREVIVIR: 71/71 checks passed'),
      transcript.slice(0, 300));
    check('el contenido no se degrada a la palabra literal "tool_result"',
      !/\[USER\][^\[]*\btool_result\b/.test(transcript),
      transcript.slice(0, 300));
    check('un evento user que solo trae tool_result no genera turno de usuario',
      cuenta(/\[USER\]/g) === 1, String(cuenta(/\[USER\]/g)));
    check('se emite un turno tool_result por cada resultado',
      cuenta(/\[TOOL_RESULT\]/g) === 3, String(cuenta(/\[TOOL_RESULT\]/g)));
    check('el content en bloques {type:text} se aplana a texto',
      transcript.includes('SALIDA-EN-BLOQUES'));
    check('is_error queda marcado en el turno', transcript.includes('[Result ERROR]'));
    check('las salidas largas se condensan a 300 chars',
      transcript.includes('X'.repeat(300) + '...') && !transcript.includes('X'.repeat(301)));
    check('los turnos contabilizados incluyen llamadas y resultados',
      totalTurns === 7, String(totalTurns));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
