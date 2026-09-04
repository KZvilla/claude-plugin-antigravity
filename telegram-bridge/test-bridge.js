import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// El estado de test vive en un fichero temporal: nunca se toca el state.json real
// del usuario. Debe fijarse ANTES de importar state.js, de ahí los import dinámicos.
const TEST_STATE_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-test-')),
  'state.json'
);
process.env.TELEGRAM_BRIDGE_STATE_FILE = TEST_STATE_FILE;

const FAKE_TOKEN = '1234567890:AAFakeTokenForTestingOnly_DoNotUse';

const { resolveAgyBin, getAgyStatus, loadPolicy, resolveWorkspace, resolveExtraDirs } = await import('./executor.js');
const { splitMessage, markdownToTelegramHtml, escapeHtml, formatElapsed, finalProgressLabel } = await import('./formatter.js');
const state = await import('./state.js');
const queue = await import('./queue.js');
const { Api, Context } = await import('grammy');
const claudeLauncher = await import('./claude-launcher.js');

console.log('--- 🧪 Iniciando Verificación de telegram-bridge ---');
console.log(`    (estado de test en ${TEST_STATE_FILE})`);

// Test 1: Resolución de binario agy
const bin = resolveAgyBin();
console.log('✔ Test 1: resolveAgyBin() ->', bin);
assert(bin && bin.length > 0, 'El binario de agy no debe ser nulo');

// Test 2: Estado de agy
const status = getAgyStatus();
console.log('✔ Test 2: getAgyStatus() ->', status.version);
assert(status.binPath, 'Debe retornar binPath');
assert(Array.isArray(status.denyCommands), 'Debe tener denyCommands');

// Test 3: división de mensajes. La aserción anterior (`chunks[0].includes('```')`)
// pasaba trivialmente porque el propio texto de prueba lleva fences: lo que
// importa es que TODO trozo quede con los fences equilibrados y dentro del límite.
const shortText = 'Hola mundo!';
assert.strictEqual(splitMessage(shortText, 50).length, 1, 'Texto corto no se divide');

const fencesEquilibrados = (chunk) => ((chunk.match(/```/g) || []).length % 2) === 0;
const sinTrozosVacios = (cs) => cs.every((c) => c.replace(/```[^\n]*/g, '').trim().length > 0);

const casosSplit = {
  // El fence de apertura es justo la línea que desborda: cerrar el trozo
  // anterior dejaría un fence huérfano de un bloque que nunca se abrió.
  'apertura desborda': ['x'.repeat(35) + '\n```js\ncode aqui\n```\nfin', 40],
  // Una sola línea más larga que el límite, dentro de un bloque.
  'linea gigante': ['```js\n' + 'z'.repeat(120) + '\n```', 50],
  // El texto termina dentro de un bloque sin cerrar.
  'termina abierto': ['a'.repeat(30) + '\n```js\n' + 'b'.repeat(30), 40],
  'texto plano largo': [Array.from({ length: 12 }, (_, i) => `Linea ${i} con algo de texto.`).join('\n'), 60]
};

for (const [nombre, [texto, limite]] of Object.entries(casosSplit)) {
  const cs = splitMessage(texto, limite);
  assert(cs.length >= 2, `${nombre}: debe dividirse`);
  assert(cs.every(fencesEquilibrados), `${nombre}: todo trozo con fences equilibrados`);
  assert(cs.every((c) => c.length <= limite), `${nombre}: ningún trozo supera el límite`);
  assert(sinTrozosVacios(cs), `${nombre}: sin trozos que sean solo un bloque vacío`);
}
console.log(`✔ Test 3: splitMessage equilibra fences en ${Object.keys(casosSplit).length} casos límite`);

// Test 4: Persistencia de estado
const testChatId = 999999999;
state.setConversationId(testChatId, 'test-conv-12345', { test: true });
assert.strictEqual(state.getConversationId(testChatId), 'test-conv-12345', 'Debe recuperar el conversationId');

state.clearConversationId(testChatId);
assert.strictEqual(state.getConversationId(testChatId), null, 'Debe borrar conversationId tras clear');
console.log('✔ Test 4: Persistencia de estado validada');

// Test 5: Cola de tareas en memoria (concurrency 1)
assert.strictEqual(queue.getQueueLength(), 0, 'La cola arranca vacía');
assert.strictEqual(queue.enqueueTask({ id: 'task-1', prompt: 'test' }), 1, 'Debe devolver la posición');
assert.strictEqual(queue.getQueueLength(), 1, 'Cola debe incrementar');
const dequeued = queue.dequeueTask();
assert.strictEqual(dequeued.id, 'task-1', 'Debe desencolar la tarea');
assert.strictEqual(queue.dequeueTask(), null, 'Cola vacía devuelve null');
console.log('✔ Test 5: Cola de ejecución (concurrency 1) validada');

// Test 6 (regresión): un Context vivo de grammY sobrevive al paso por la cola.
// Antes la cola se serializaba a state.json y el Context volvía como objeto plano:
// `ctx.replyWithChatAction is not a function` tumbaba el bot en cada /run.
const api = new Api(FAKE_TOKEN);
const update = {
  update_id: 1,
  message: {
    message_id: 10,
    date: Math.floor(Date.now() / 1000),
    chat: { id: testChatId, type: 'private' },
    from: { id: testChatId, is_bot: false, first_name: 'Test' },
    text: '/run algo'
  }
};
const ctx = new Context(update, api, { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' });

// El modo de fallo que se está previniendo, documentado como aserción:
const roundTripped = JSON.parse(JSON.stringify({ ctx }));
assert.strictEqual(typeof roundTripped.ctx.reply, 'undefined', 'Un Context serializado pierde sus métodos');

queue.enqueueTask({ ctx, chatId: testChatId, prompt: 'algo', mode: 'plan', conversationId: null });
const liveTask = queue.dequeueTask();
assert.strictEqual(liveTask.ctx, ctx, 'La cola debe devolver la misma referencia de Context');
for (const method of ['reply', 'replyWithChatAction', 'answerCallbackQuery', 'editMessageReplyMarkup']) {
  assert.strictEqual(typeof liveTask.ctx[method], 'function', `ctx.${method} debe seguir siendo invocable`);
}
assert.strictEqual(liveTask.chatId, testChatId, 'Los datos de la tarea deben conservarse');
assert.strictEqual(liveTask.mode, 'plan', 'El modo debe conservarse');
console.log('✔ Test 6: el Context vivo sobrevive a encolar/desencolar');

// Test 7: la vista serializable de la cola no arrastra handles ni secretos
queue.enqueueTask({ ctx, chatId: testChatId, prompt: 'x'.repeat(500), mode: 'plan' });
const snapshot = queue.getQueueSnapshot();
const snapshotJson = JSON.stringify(snapshot);
assert.strictEqual(snapshot.length, 1, 'El snapshot refleja la cola');
assert.strictEqual(snapshot[0].ctx, undefined, 'El snapshot no expone el Context');
assert(!snapshotJson.includes(FAKE_TOKEN), 'El snapshot no debe contener el token del bot');
assert(snapshot[0].promptPreview.length <= 80, 'El prompt se recorta en el snapshot');
queue.clearQueue();
console.log('✔ Test 7: getQueueSnapshot() es serializable y sin secretos');

// Test 8: el estado persistido nunca contiene el token del bot.
// Un ask pendiente es lo más parecido a la ruta que filtraba el secreto.
state.registerPendingAsk('ask-test-1', {
  question: '¿Continuar?',
  options: ['Sí', 'No'],
  chatId: testChatId,
  messageId: 42
});
state.setConversationId(testChatId, 'conv-abc');
const persisted = fs.readFileSync(TEST_STATE_FILE, 'utf8');
assert(!persisted.includes(FAKE_TOKEN), 'state.json NO debe contener el TELEGRAM_BOT_TOKEN');
assert(!persisted.includes('"token"'), 'state.json NO debe contener ningún campo token');
assert(!persisted.includes('"queue"'), 'state.json ya no persiste la cola de tareas');
assert.strictEqual(typeof state.enqueueTask, 'undefined', 'state.js ya no debe exponer la cola');
console.log('✔ Test 8: el estado en disco está libre de secretos');

// Test 9: la política se carga de .claude/antigravity.json con la misma
// precedencia que el servidor MCP, y el entorno la sobreescribe.
const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-policy-'));
fs.mkdirSync(path.join(policyDir, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(policyDir, '.claude', 'antigravity.json'),
  JSON.stringify({ permissions: { deny_commands: ['docker *'], sandbox: true } }),
  'utf8'
);

const basePolicy = loadPolicy(policyDir);
assert.deepStrictEqual(basePolicy.denyCommands, ['docker *'], 'deny_commands sale del fichero de política');
assert.strictEqual(basePolicy.sandbox, true, 'sandbox sale del fichero de política');
assert(basePolicy.denyPaths.includes('.env*'), 'Las claves ausentes conservan el valor por defecto');
assert.strictEqual(
  basePolicy.configFile,
  path.join(policyDir, '.claude', 'antigravity.json'),
  'Debe reportar de dónde salió la política'
);

process.env.AGY_SANDBOX = 'false';
assert.strictEqual(loadPolicy(policyDir).sandbox, false, 'AGY_SANDBOX debe ganar sobre el fichero');
delete process.env.AGY_SANDBOX;
fs.rmSync(policyDir, { recursive: true, force: true });

// El sandbox va INACTIVO por defecto: medido, no limita rutas (la herramienta
// de escritura sale del workspace igual) y convierte cada comando de terminal
// en un UAC de elevación. Activarlo por defecto no añadiría frontera.
const dirSinPolitica = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-nopol-'));
assert.strictEqual(
  loadPolicy(dirSinPolitica).sandbox,
  false,
  'Sin fichero de política ni AGY_SANDBOX, el sandbox va inactivo'
);
fs.rmSync(dirSinPolitica, { recursive: true, force: true });
console.log('✔ Test 9: loadPolicy() respeta fichero y entorno');

// Test 10: getAgyStatus distingue lo que se aplica de lo que solo se sugiere.
// Es lo que impide que /status vuelva a prometer una protección inexistente.
assert.strictEqual(status.enforcement.denyCommands, 'prompt', 'deny_commands solo se sugiere al modelo');
assert.strictEqual(status.enforcement.denyPaths, 'prompt', 'deny_paths solo se sugiere al modelo');
assert.strictEqual(typeof status.enforcement.sandbox, 'boolean', 'sandbox es un control real, booleano');
assert.strictEqual(status.enforcement.skipPermissions, true, 'el bridge siempre auto-aprueba herramientas');
console.log('✔ Test 10: getAgyStatus() declara qué se aplica y qué solo se sugiere');

// Test 11: escritura atómica — no debe quedar ningún .tmp ni .lock huérfano,
// y el contenido en disco debe ser siempre JSON completo y parseable.
state.setConversationId(testChatId, 'conv-atomica');
const stateDir = path.dirname(TEST_STATE_FILE);
const residuos = fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
assert.deepStrictEqual(residuos, [], `No debe quedar residuo de escritura: ${residuos.join(', ')}`);
assert.doesNotThrow(
  () => JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8')),
  'El estado en disco siempre debe ser JSON completo'
);
console.log('✔ Test 11: escritura atómica sin residuos');

// Test 12: caché por mtime — una escritura externa debe invalidarla.
assert.strictEqual(state.getConversationId(testChatId), 'conv-atomica', 'Lectura cacheada');
const onDisk = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
onDisk.chats[String(testChatId)].lastConversationId = 'conv-externa';
fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(onDisk, null, 2), 'utf8');
assert.strictEqual(
  state.getConversationId(testChatId),
  'conv-externa',
  'La caché debe invalidarse cuando otro proceso escribe el fichero'
);
console.log('✔ Test 12: la caché se invalida por mtime');

// Test 13: ciclo de vida y recolección de asks.
state.registerPendingAsk('ask-vivo', { question: 'q', options: ['a'], chatId: testChatId, messageId: 1 });
state.registerPendingAsk('ask-caduca', { question: 'q', options: ['a'], chatId: testChatId, messageId: 2 });

const expirado = state.expirePendingAsk('ask-caduca');
assert.strictEqual(expirado.status, 'expired', 'El timeout debe marcar expired');
assert(expirado.expiredAt, 'Debe registrar cuándo expiró');
assert.strictEqual(state.expirePendingAsk('ask-caduca'), null, 'No se vuelve a expirar lo ya cerrado');

const respondido = state.resolvePendingAsk('ask-test-1', 'Sí', testChatId);
assert.strictEqual(respondido.status, 'answered', 'resolvePendingAsk marca answered');

// Con retención 0 se van los cerrados; el pendiente se queda: puede haber un
// notify.js esperándolo.
const purgados = state.purgeAsks(0);
assert.strictEqual(purgados, 2, `Debe purgar los 2 asks cerrados, purgó ${purgados}`);
assert(state.getPendingAsk('ask-vivo'), 'Un ask pendiente NUNCA se purga');
assert.strictEqual(state.getPendingAsk('ask-caduca'), null, 'El expirado se purga');
assert.strictEqual(state.getPendingAsk('ask-test-1'), null, 'El respondido se purga');
console.log('✔ Test 13: asks se expiran y se recolectan');

// Test 14: el formateo a HTML es determinista y nunca produce marcado inválido.
assert.strictEqual(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d', 'Escapa los tres caracteres');
assert.strictEqual(
  markdownToTelegramHtml('<script>alert(1)</script>'),
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  'El HTML del usuario se escapa, no se interpreta'
);
assert.strictEqual(markdownToTelegramHtml('*negrita* y _cursiva_'), '<b>negrita</b> y <i>cursiva</i>');
assert.strictEqual(markdownToTelegramHtml('**doble** tambien'), '<b>doble</b> tambien');
assert.strictEqual(markdownToTelegramHtml('con `codigo` dentro'), 'con <code>codigo</code> dentro');
assert.strictEqual(
  markdownToTelegramHtml('el `a < b` escapa'),
  'el <code>a &lt; b</code> escapa',
  'El código en línea también se escapa'
);

// Lo que rompía el Markdown legado: marcadores sueltos. Ahora salen literales.
for (const suelto of ['foo_bar sin pareja', 'un * asterisco suelto', 'guion_bajo_medio', 'a ** b']) {
  const html = markdownToTelegramHtml(suelto);
  assert(!html.includes('<b>') && !html.includes('<i>'), `Marcador suelto literal: ${suelto}`);
}

const conBloque = markdownToTelegramHtml('texto\n```js\nif (a < b && c) {}\n```');
assert(
  conBloque.includes('<pre><code class="language-js">if (a &lt; b &amp;&amp; c) {}</code></pre>'),
  `El bloque de código se escapa y se etiqueta: ${conBloque}`
);
assert(
  markdownToTelegramHtml('```py\nprint(1)').includes('</code></pre>'),
  'Un bloque sin cerrar se cierra implícitamente'
);

// Ninguna etiqueta abierta puede quedar sin cerrar en la salida.
const abiertas = (conBloque.match(/<[a-z]+[^>]*>/g) || []).length;
const cerradas = (conBloque.match(/<\/[a-z]+>/g) || []).length;
assert.strictEqual(abiertas, cerradas, 'Toda etiqueta emitida se cierra');
console.log('✔ Test 14: markdownToTelegramHtml es determinista y escapa siempre');

// Test 15: formatElapsed, usado por el mensaje de progreso editable.
assert.strictEqual(formatElapsed(0), '0s');
assert.strictEqual(formatElapsed(45), '45s');
assert.strictEqual(formatElapsed(65), '1m 05s');
assert.strictEqual(formatElapsed(3599), '59m 59s');
assert.strictEqual(formatElapsed(3600), '1h 00m');
// El caso que disparó el arreglo: 18733.2s de sesión acumulada.
assert.strictEqual(formatElapsed(18733.2), '5h 12m');
console.log('✔ Test 15: formatElapsed');

// Test 18: una cancelación tiene etiqueta propia. Compartía la del fallo, así
// que /cancel dejaba el mensaje en «⚠️ Terminado con error tras 21s» y parecía
// que la tarea había reventado sola.
assert.strictEqual(finalProgressLabel({ cancelled: true, success: false }), '🛑 Cancelado tras');
assert.strictEqual(finalProgressLabel({ success: true }), '✅ Completado en');
assert.strictEqual(finalProgressLabel({ success: false }), '⚠️ Terminado con error tras');
console.log('✔ Test 18: finalProgressLabel distingue cancelación de error');

// Test 19: el enfasis que envuelve codigo en linea. Se procesaban los tramos a
// ambos lados del codigo por separado, asi que cada asterisco de
// *negrita con `codigo` dentro* caia en un tramo distinto, no casaba ninguno y
// los asteriscos llegaban literales al mensaje.
assert.strictEqual(
  markdownToTelegramHtml('*17 commits en `main`, release `v0.4.0` publicada.*'),
  '<b>17 commits en <code>main</code>, release <code>v0.4.0</code> publicada.</b>',
  'La negrita debe abarcar el codigo en linea'
);
assert.strictEqual(
  markdownToTelegramHtml('_cursiva con `code` dentro_'),
  '<i>cursiva con <code>code</code> dentro</i>',
  'Lo mismo para la cursiva'
);
// El centinela interno no debe poder inyectarse desde el texto del usuario.
assert.strictEqual(
  markdownToTelegramHtml('\u00000\u0000 y `x`'),
  '0 y <code>x</code>',
  'Un centinela escrito por el usuario se descarta'
);
assert.strictEqual(
  markdownToTelegramHtml('`<script>alert(1)</script>`'),
  '<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>',
  'El codigo en linea se sigue escapando'
);
console.log('✔ Test 19: el enfasis abarca el codigo en linea');


// Test 16: la cola guarda la MISMA referencia, no una copia. De eso depende que
// dispatchTask pueda anotar el statusMessageId después de encolar.
const tareaViva = { ctx, chatId: testChatId, prompt: 'p', mode: 'plan', statusMessageId: null };
queue.enqueueTask(tareaViva);
tareaViva.statusMessageId = 4242;
const recuperada = queue.dequeueTask();
assert.strictEqual(recuperada, tareaViva, 'La cola guarda la referencia, no una copia');
assert.strictEqual(recuperada.statusMessageId, 4242, 'Las mutaciones posteriores al encolado se ven');
assert(recuperada.enqueuedAt, 'enqueueTask anota cuándo se encoló');
console.log('✔ Test 16: la cola preserva la identidad de la tarea');

// Test 17: el workspace es una fuente única de verdad y no depende del cwd.
// El banner de bot.js resolvía la raíz del repo y el executor usaba
// process.cwd(), que con `npm --prefix telegram-bridge start` es otra carpeta:
// el bot decía un directorio y agy trabajaba en otro.
const wsPrevio = process.env.WORKSPACE_DIR;
const dirsPrevio = process.env.AGY_ADD_DIRS;
const dirA = os.tmpdir();
const dirB = path.dirname(TEST_STATE_FILE);

process.env.WORKSPACE_DIR = dirA;
assert.strictEqual(resolveWorkspace(), path.resolve(dirA), 'WORKSPACE_DIR manda sobre el cwd');

delete process.env.WORKSPACE_DIR;
assert.strictEqual(resolveWorkspace(), path.resolve(process.cwd()), 'Sin WORKSPACE_DIR cae al cwd');

process.env.AGY_ADD_DIRS = `  ${dirA} , , ${dirB}  `;
assert.deepStrictEqual(
  resolveExtraDirs(),
  [path.resolve(dirA), path.resolve(dirB)],
  'AGY_ADD_DIRS se limpia, se resuelve y descarta los vacíos'
);

delete process.env.AGY_ADD_DIRS;
assert.deepStrictEqual(resolveExtraDirs(), [], 'Sin AGY_ADD_DIRS no hay extras');

if (wsPrevio !== undefined) process.env.WORKSPACE_DIR = wsPrevio;
if (dirsPrevio !== undefined) process.env.AGY_ADD_DIRS = dirsPrevio;
console.log('✔ Test 17: resolveWorkspace() y resolveExtraDirs()');


// ==============================================================================
// Tests de la ronda de seguridad y estabilidad (SEC-00x / BE-00x / FEAT-001)
// ==============================================================================

const policy = await import('./policy.js');
const logrotate = await import('./logrotate.js');
const { buildGuardrailedPrompt, offloadLargePrompt } = await import('./executor.js');

// Test 20 [SEC-002]: deny_paths se evalúa como glob real, no como lista fija.
// La versión que solo reconocía los tres patrones por defecto devolvía `false`
// en silencio para cualquier política que el usuario escribiera.
const denegadasPorDefecto = ['C:\\proj\\.env', '/home/u/app/.env.local', '/srv/id_rsa.key', 'C:/certs/server.pem'];
for (const ruta of denegadasPorDefecto) {
  assert(policy.isPathDenied(ruta, policy.DEFAULT_DENY_PATHS), `${ruta} debe estar denegada`);
}
for (const ruta of ['C:/proj/README.md', '/home/u/notes.txt']) {
  assert(!policy.isPathDenied(ruta, policy.DEFAULT_DENY_PATHS), `${ruta} debe estar permitida`);
}
// Patrón personalizado con directorio: es justo lo que un matcher por basename
// no puede expresar.
assert(policy.isPathDenied('C:/proj/secrets/api.txt', ['secrets/**']), 'secrets/** debe casar a cualquier profundidad');
assert(policy.isPathDenied('C:/proj/a/b/secrets/x/y.txt', ['secrets/**']), 'secrets/** debe casar anidado');
assert(!policy.isPathDenied('C:/proj/public/api.txt', ['secrets/**']), 'fuera de secrets/ debe pasar');
assert.strictEqual(policy.matchDeniedPath('C:/proj/.env', policy.DEFAULT_DENY_PATHS), '.env*', 'devuelve el patrón culpable');
assert.throws(
  () => policy.assertPathAllowed('C:/proj/.env', policy.DEFAULT_DENY_PATHS),
  (err) => err instanceof policy.PolicyViolationError,
  'assertPathAllowed lanza PolicyViolationError'
);
assert.doesNotThrow(() => policy.assertPathAllowed('C:/proj/README.md', policy.DEFAULT_DENY_PATHS));
console.log('✔ Test 20 [SEC-002]: deny_paths se evalúa como glob real');

// Test 21 [SEC-002]: la subida a Telegram rechaza la ruta ANTES de tocar la red.
// El fichero se crea de verdad para que el rechazo no dependa de que no exista.
{
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-deny-'));
  const envFalso = path.join(dirTmp, '.env.test');
  fs.writeFileSync(envFalso, 'TELEGRAM_BOT_TOKEN=1234567890:AAsecretoQueNoDebeSalirDeAqui\n');

  const fetchOriginal = globalThis.fetch;
  let huboRed = false;
  globalThis.fetch = async () => { huboRed = true; throw new Error('no debería haber red'); };

  const notify = await import('./notify.js');
  await assert.rejects(
    () => notify.sendTelegramNotification({ message: 'toma el env', filePath: envFalso }),
    (err) => err instanceof policy.PolicyViolationError,
    'sendTelegramNotification rechaza un adjunto prohibido'
  );
  assert.strictEqual(huboRed, false, 'No debe hacerse ninguna petición de red al rechazar');

  globalThis.fetch = fetchOriginal;
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 21 [SEC-002]: telegram_notify no sube un adjunto prohibido ni contacta la red');

// Test 22 [SEC-000]: el entorno del hijo `agy` no lleva secretos del bridge.
// `agy` corre con --dangerously-skip-permissions y puede ejecutar comandos: un
// `echo` del token bastaría para publicarlo en el chat.
{
  const entorno = policy.sanitizeEnv({
    PATH: '/usr/bin',
    WORKSPACE_DIR: 'C:/proj',
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_NOTIFY_CHAT_ID: '123',
    ALLOWED_USER_IDS: '123,456'
  });
  assert.strictEqual(entorno.TELEGRAM_BOT_TOKEN, undefined, 'El token no se hereda');
  assert.strictEqual(entorno.ALLOWED_USER_IDS, undefined, 'La whitelist no se hereda');
  assert.strictEqual(entorno.TELEGRAM_NOTIFY_CHAT_ID, undefined, 'El chat de notificación no se hereda');
  assert.strictEqual(entorno.PATH, '/usr/bin', 'El resto del entorno se conserva');
  assert.strictEqual(entorno.WORKSPACE_DIR, 'C:/proj', 'El workspace se conserva');
  assert(!JSON.stringify(entorno).includes(FAKE_TOKEN), 'Ningún rastro del token');
}
console.log('✔ Test 22 [SEC-000]: el entorno de agy va sin secretos del bridge');

// Test 23 [SEC-004]: enmascarado de tokens en texto destinado al log o al chat.
assert.strictEqual(
  policy.redactSecrets(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`),
  'https://api.telegram.org/bot1234567890:[REDACTED]/sendMessage',
  'Enmascara el token dentro de una URL de la API'
);
assert(
  !policy.redactSecrets(`TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}`).includes('AAFakeToken'),
  'Enmascara también el token suelto, sin el prefijo bot'
);
assert.strictEqual(policy.redactSecrets('duración 12:30, ratio 1234567:8'), 'duración 12:30, ratio 1234567:8', 'No toca texto inocuo');
assert.strictEqual(policy.redactSecrets(null), '', 'Tolera null');
console.log('✔ Test 23 [SEC-004]: redactSecrets cubre URL y token suelto');

// Test 24 [BE-000]: los guardrails llevan la política EFECTIVA, no los defaults.
// Antes /status mostraba policy.* y al modelo se le inyectaban los defaults: lo
// que el usuario configuraba no llegaba nunca a quien podía atenderlo.
{
  const dirWs = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-policy-'));
  fs.mkdirSync(path.join(dirWs, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dirWs, '.claude', 'antigravity.json'),
    JSON.stringify({ permissions: { deny_paths: ['secretos/**', '*.pfx'], deny_commands: ['terraform destroy*'] } })
  );

  const cargada = loadPolicy(dirWs);
  assert.deepStrictEqual(cargada.denyPaths, ['secretos/**', '*.pfx'], 'loadPolicy toma las rutas del fichero');
  assert.deepStrictEqual(cargada.denyCommands, ['terraform destroy*'], 'loadPolicy toma los comandos del fichero');

  const inyectado = buildGuardrailedPrompt(cargada, 'haz algo');
  assert(inyectado.includes('secretos/**'), 'El guardrail lleva la ruta configurada');
  assert(inyectado.includes('terraform destroy*'), 'El guardrail lleva el comando configurado');
  assert(!inyectado.includes('git push*'), 'El guardrail NO cae en los defaults cuando hay política');
  assert(inyectado.endsWith('haz algo'), 'El prompt del usuario queda al final');

  fs.rmSync(dirWs, { recursive: true, force: true });
}
console.log('✔ Test 24 [BE-000]: los guardrails inyectan la política efectiva');

// Test 25 [BE-001]: un prompt que no cabe en un argumento se vuelca a fichero.
// Nota de alcance: por el camino de Telegram esto no se dispara —un mensaje no
// pasa de 4096 caracteres—; cubre a los llamantes directos de runAgyTask.
{
  const promptGigante = 'x'.repeat(40000);
  const base = ['--mode', 'plan', '-p', promptGigante];
  const { args, cleanup } = offloadLargePrompt(base);

  assert.notStrictEqual(args[3], promptGigante, 'El prompt se sustituye por un puntero');
  assert(args[3].length < 1000, 'El puntero cabe de sobra en un argumento');
  const idxDir = args.lastIndexOf('--add-dir');
  assert(idxDir > 0, 'Se añade el directorio temporal a los accesibles');
  const dirVolcado = args[idxDir + 1];
  const ficheroVolcado = path.join(dirVolcado, 'PROMPT.md');
  assert(fs.existsSync(ficheroVolcado), 'El PROMPT.md existe');
  assert.strictEqual(fs.readFileSync(ficheroVolcado, 'utf8'), promptGigante, 'El volcado es íntegro');
  assert(args[3].includes(ficheroVolcado), 'El puntero nombra el fichero');

  cleanup();
  assert(!fs.existsSync(dirVolcado), 'cleanup() borra el directorio temporal');

  const corto = ['-p', 'hola'];
  assert.strictEqual(offloadLargePrompt(corto).args, corto, 'Un prompt normal pasa intacto');
}
console.log('✔ Test 25 [BE-001]: offloadLargePrompt vuelca, apunta y limpia');

// Test 26 [BE-004]: los asks pendientes vencidos se recolectan; los vivos no.
// El umbral es el vencimiento declarado de cada ask, no una constante: con un
// umbral fijo, un ask con timeout mayor se marcaría expirado mientras su
// notify.js sigue esperándolo, y el botón respondería «expiró» sin desbloquear.
{
  state.registerPendingAsk('ask_vivo', {
    question: '¿sigo?', options: ['Sí', 'No'], chatId: testChatId, messageId: 1,
    timeoutSeconds: 4 * 3600 // 4 h: por encima de cualquier umbral fijo razonable
  });
  state.registerPendingAsk('ask_huerfano', {
    question: '¿y esto?', options: ['Sí'], chatId: testChatId, messageId: 2,
    timeoutSeconds: 300
  });

  // Se retrasa a mano el huérfano: su cliente murió y su plazo ya venció.
  const crudo = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  const hace3h = new Date(Date.now() - 3 * 3600 * 1000);
  crudo.pendingAsks.ask_huerfano.createdAt = hace3h.toISOString();
  crudo.pendingAsks.ask_huerfano.expiresAt = new Date(hace3h.getTime() + 300 * 1000).toISOString();
  // Un registro sin ninguna marca de tiempo utilizable: no se puede fechar ni
  // atribuir a nadie, y era justo el caso que se colaba por el hueco del NaN.
  crudo.pendingAsks.ask_corrupto = { askId: 'ask_corrupto', status: 'pending', chatId: testChatId };
  fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(crudo, null, 2));

  state.purgeAsks();

  assert.strictEqual(state.getPendingAsk('ask_vivo').status, 'pending', 'Un ask dentro de plazo sigue pendiente');
  assert.strictEqual(state.getPendingAsk('ask_huerfano').status, 'expired', 'Un ask vencido pasa a expired');
  assert.strictEqual(state.getPendingAsk('ask_corrupto'), null, 'Un ask sin fecha utilizable se elimina');

  // Una vez expirado y pasada la retención, desaparece.
  const crudo2 = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  crudo2.pendingAsks.ask_huerfano.expiredAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(crudo2, null, 2));
  state.purgeAsks();
  assert.strictEqual(state.getPendingAsk('ask_huerfano'), null, 'Tras la retención se elimina del estado');
}
console.log('✔ Test 26 [BE-004]: los asks huérfanos se recolectan sin tocar los vivos');

// Test 27 [SEC-003]: resolver un ask es atómico. La comprobación de estado vive
// dentro del lock; hacerla en el llamante era un TOCTOU y dos pulsaciones
// seguidas resolvían dos veces, pisando la primera respuesta.
{
  state.registerPendingAsk('ask_doble', {
    question: '¿aplico?', options: ['Aprobar', 'Rechazar'], chatId: testChatId, messageId: 3, timeoutSeconds: 300
  });
  const primero = state.resolvePendingAsk('ask_doble', 'Aprobar', 111);
  const segundo = state.resolvePendingAsk('ask_doble', 'Rechazar', 222);

  assert(primero && primero.status === 'answered', 'La primera pulsación resuelve');
  assert.strictEqual(segundo, null, 'La segunda pulsación no resuelve nada');
  assert.strictEqual(state.getPendingAsk('ask_doble').answer, 'Aprobar', 'La respuesta original se conserva');
  assert.strictEqual(state.getPendingAsk('ask_doble').answeredBy, 111, 'El autor original se conserva');

  const yaExpirado = state.expirePendingAsk('ask_doble');
  assert.strictEqual(yaExpirado, null, 'Un ask ya respondido no se puede expirar');
}
console.log('✔ Test 27 [SEC-003]: resolvePendingAsk es atómico y no se resuelve dos veces');

// A partir de aquí se ejercita `bot.js` directamente. Es lo que el refactor a
// módulo importable hace posible: mientras el arranque vivía en el cuerpo del
// módulo, importarlo tomaba el lockfile, validaba el token y abría el long
// polling, así que ningún handler suyo podía probarse.
process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
const { createBot, resetRuntimeState, avisoDeDespacho, buildWorkspacesKeyboard } = await import('./bot.js');

// Test 28 [BE-003]: el aviso anuncia la posición real en la fila, no el índice
// de la cola. Con una tarea corriendo, el primero en cola es el segundo en fila.
assert(
  avisoDeDespacho({ habiaTareaEnCurso: false, posEnCola: 1, mode: 'plan' }).includes('Generando plan'),
  'Sin nada en curso, arranca de inmediato'
);
assert(
  avisoDeDespacho({ habiaTareaEnCurso: false, posEnCola: 1, mode: 'accept-edits' }).includes('Ejecutando tarea'),
  'El modo se refleja en el aviso'
);
assert(
  avisoDeDespacho({ habiaTareaEnCurso: true, posEnCola: 1, mode: 'plan' }).includes('posición #2'),
  'Con una tarea en curso, el primero en cola va el segundo'
);
assert(
  avisoDeDespacho({ habiaTareaEnCurso: true, posEnCola: 3, mode: 'plan' }).includes('posición #4'),
  'La posición cuenta la tarea en ejecución'
);
assert(
  avisoDeDespacho({ habiaTareaEnCurso: false, posEnCola: 2, mode: 'plan' }).includes('posición #2'),
  'Cola con resto y nada en curso: la posición es el índice'
);
console.log('✔ Test 28 [BE-003]: el aviso de cola anuncia la posición real');

// Test 29 [BE-005]: la rotación copia y trunca, nunca renombra.
// El log lo tiene abierto en modo append el cmd.exe de la redirección: un
// rename falla o deja el handle apuntando al fichero renombrado, y daemon.log
// no vuelve a recibir nada. Truncar sí funciona con un handle en append.
{
  const dirLog = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-log-'));
  const logFile = path.join(dirLog, 'daemon.log');
  fs.writeFileSync(logFile, 'a'.repeat(2048));

  assert.strictEqual(logrotate.rotateIfNeeded(logFile, 4096), false, 'Por debajo del tope no rota');
  assert.strictEqual(fs.statSync(logFile).size, 2048, 'El log intacto');

  assert.strictEqual(logrotate.rotateIfNeeded(logFile, 1024), true, 'Por encima del tope rota');
  assert(fs.existsSync(logFile), 'El log sigue existiendo tras rotar (no se renombró)');
  assert.strictEqual(fs.statSync(logFile).size, 0, 'El log queda truncado a cero');
  assert.strictEqual(fs.statSync(`${logFile}.old`).size, 2048, 'La generación anterior se conserva íntegra');

  assert.strictEqual(logrotate.rotateIfNeeded(path.join(dirLog, 'no-existe.log'), 1), false, 'Sin fichero no falla');
  fs.rmSync(dirLog, { recursive: true, force: true });
}
console.log('✔ Test 29 [BE-005]: la rotación trunca en sitio y conserva una generación');

// ==============================================================================
// Tests de handlers sobre un bot real, con la API interceptada.
// ==============================================================================

const USUARIO_OK = '555000111';
const USUARIO_AJENO = '999888777';

/**
 * Construye un bot cuyas llamadas a la API se capturan en lugar de salir a la
 * red. Un transformer que no llama a `prev` corta la petición en seco.
 */
function botDePrueba() {
  const bot = createBot({ token: FAKE_TOKEN, allowedUserIds: new Set([USUARIO_OK]) });
  const llamadas = [];
  bot.api.config.use(async (prev, method, payload) => {
    llamadas.push({ method, payload });
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: llamadas.length, date: 0, chat: { id: 1 }, text: payload.text } };
    }
    return { ok: true, result: true };
  });
  bot.botInfo = {
    id: 1, is_bot: true, first_name: 'test', username: 'test_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business_account: false, has_main_web_app: false
  };
  return { bot, llamadas };
}

function updateDeTexto({ userId, chatId = userId, chatType = 'private', text = 'hola', updateId = 1 }) {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: chatType, title: chatType === 'private' ? undefined : 'Grupo' },
      from: { id: Number(userId), is_bot: false, first_name: 'Test' },
      text
    }
  };
}

// Test 30 [SEC-001]: la whitelist autoriza a una PERSONA, no a un CANAL. Si el
// bot entra en un grupo donde participa un usuario autorizado, sus respuestas
// —código, diffs, rutas locales, /status— quedan a la vista de todo el grupo.
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  for (const tipo of ['group', 'supergroup', 'channel']) {
    await bot.handleUpdate(updateDeTexto({ userId: USUARIO_OK, chatId: -100123, chatType: tipo, text: '/status', updateId: 1 }));
  }
  assert.strictEqual(llamadas.length, 0, 'Un usuario autorizado en grupo/canal no obtiene respuesta alguna');

  await bot.handleUpdate(updateDeTexto({ userId: USUARIO_AJENO, text: '/status', updateId: 2 }));
  assert.strictEqual(llamadas.length, 0, 'Un usuario fuera de la whitelist tampoco');

  await bot.handleUpdate(updateDeTexto({ userId: USUARIO_OK, text: '/reset', updateId: 3 }));
  assert(llamadas.length > 0, 'El mismo usuario en su chat privado sí es atendido');
  assert.strictEqual(llamadas[0].method, 'sendMessage', 'Y la respuesta es un mensaje');
  resetRuntimeState();
}
console.log('✔ Test 30 [SEC-001]: solo se atienden chats privados de usuarios en whitelist');

// Test 31 [FEAT-001]: audio, fotos y documentos entrantes reciben respuesta.
// Sin handler, enviar una nota de voz no producía nada: ni respuesta ni error,
// indistinguible desde el móvil de un bridge caído.
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  const base = (extra, updateId) => ({
    update_id: updateId,
    message: {
      message_id: 200 + updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(USUARIO_OK), type: 'private' },
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      ...extra
    }
  });

  await bot.handleUpdate(base({ voice: { file_id: 'v1', file_unique_id: 'v1u', duration: 3 } }, 10));
  assert.strictEqual(llamadas.length, 1, 'Una nota de voz recibe respuesta');
  assert(llamadas[0].payload.text.includes('audio'), 'La respuesta explica que el audio no se procesa');

  await bot.handleUpdate(base({ photo: [{ file_id: 'p1', file_unique_id: 'p1u', width: 1, height: 1 }] }, 11));
  assert.strictEqual(llamadas.length, 2, 'Una foto recibe respuesta');
  assert(llamadas[1].payload.text.includes('archivos'), 'La respuesta explica que los archivos no se procesan');

  await bot.handleUpdate(base({ document: { file_id: 'd1', file_unique_id: 'd1u' } }, 12));
  assert.strictEqual(llamadas.length, 3, 'Un documento recibe respuesta');
  resetRuntimeState();
}
console.log('✔ Test 31 [FEAT-001]: los mensajes no soportados reciben feedback explícito');

// Test 32 [SEC-003]: `callback_data` lo puede fabricar un cliente. Un
// exec_plan con un id que no tiene forma de identificador no debe llegar a
// `agy --conversation`.
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  const callback = (data, updateId) => ({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 300 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: 1, is_bot: true, first_name: 'bot' },
        text: 'plan'
      }
    }
  });

  await bot.handleUpdate(callback('exec_plan:../../etc/passwd', 20));
  const respuestas = llamadas.filter((c) => c.method === 'answerCallbackQuery');
  assert.strictEqual(respuestas.length, 1, 'Se responde al callback');
  assert(respuestas[0].payload.text.includes('inválido'), 'Se rechaza por identificador inválido');
  assert.strictEqual(llamadas.filter((c) => c.method === 'sendMessage').length, 0, 'No se despacha ninguna tarea');
  resetRuntimeState();
}
console.log('✔ Test 32 [SEC-003]: exec_plan valida la forma del identificador de conversación');


// Test 33 [BE-007]: el estado y el lock se resuelven a un directorio de usuario,
// no junto al código. El bridge existe en dos carpetas a la vez —el checkout y
// el plugin instalado— y sus dos procesos no salen de la misma: con la ruta
// relativa a __dirname, notify.js registraba el ask en un state.json y bot.js
// resolvía el botón contra otro.
{
  const paths = await import('./paths.js');

  const dataPrevio = process.env.TELEGRAM_BRIDGE_DATA_DIR;
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-paths-'));
  const datos = path.join(raiz, 'datos');
  const codigoA = path.join(raiz, 'checkout', 'telegram-bridge');
  const codigoB = path.join(raiz, 'plugin', 'telegram-bridge');
  fs.mkdirSync(codigoA, { recursive: true });
  fs.mkdirSync(codigoB, { recursive: true });

  process.env.TELEGRAM_BRIDGE_DATA_DIR = datos;

  // Dos copias del código convergen en el MISMO fichero. Es la propiedad que
  // hace posible el human-in-the-loop entre procesos distintos.
  const desdeA = paths.resolveDataFile('state.json', codigoA);
  const desdeB = paths.resolveDataFile('state.json', codigoB);
  assert.strictEqual(desdeA, desdeB, 'Dos copias del código resuelven el mismo state.json');
  assert.strictEqual(desdeA, path.join(datos, 'state.json'), 'Y es el del directorio de datos');
  assert(fs.existsSync(datos), 'El directorio de datos se crea');

  // El legado se migra una sola vez.
  fs.rmSync(datos, { recursive: true, force: true });
  fs.writeFileSync(path.join(codigoA, 'state.json'), '{"chats":{"1":{"lastConversationId":"viejo"}}}');
  const migrado = paths.resolveDataFile('state.json', codigoA);
  assert(fs.existsSync(migrado), 'El estado legado se migra al destino');
  assert(!fs.existsSync(path.join(codigoA, 'state.json')), 'Y desaparece de la ubicación antigua');
  assert(JSON.parse(fs.readFileSync(migrado, 'utf8')).chats['1'].lastConversationId === 'viejo', 'El contenido se conserva');

  // Con destino ya presente, el legado NO se pisa ni se fusiona: dos historiales
  // distintos no se reconcilian solos sin arriesgar perder conversaciones.
  fs.writeFileSync(path.join(codigoB, 'state.json'), '{"chats":{"2":{"lastConversationId":"otro"}}}');
  paths.resolveDataFile('state.json', codigoB);
  assert(fs.existsSync(path.join(codigoB, 'state.json')), 'Un legado sobrante se deja intacto para inspección');
  assert.strictEqual(
    JSON.parse(fs.readFileSync(migrado, 'utf8')).chats['1'].lastConversationId,
    'viejo',
    'El estado canónico no se pisa'
  );

  // Si el directorio de datos no se puede usar, se cae al comportamiento previo
  // en lugar de dejar el bridge sin arrancar. Se fuerza pidiendo un directorio
  // colgando de un fichero regular, que ningún sistema puede crear.
  const bloqueador = path.join(raiz, 'soy-un-fichero');
  fs.writeFileSync(bloqueador, 'x');
  process.env.TELEGRAM_BRIDGE_DATA_DIR = path.join(bloqueador, 'imposible');
  assert.strictEqual(paths.resolveBridgeDataDir(codigoB), codigoB, 'Sin directorio de datos usable, se cae al de reserva');

  assert.strictEqual(paths.legacyDataFile('bridge.lock', codigoA), path.join(codigoA, 'bridge.lock'), 'legacyDataFile apunta al directorio del código');

  if (dataPrevio === undefined) delete process.env.TELEGRAM_BRIDGE_DATA_DIR;
  else process.env.TELEGRAM_BRIDGE_DATA_DIR = dataPrevio;
  fs.rmSync(raiz, { recursive: true, force: true });
}
console.log('✔ Test 33 [BE-007]: estado y lock convergen en un directorio de usuario');

// Test 34 [BE-007]: TELEGRAM_BRIDGE_STATE_FILE sigue mandando sobre todo lo
// demás. Es de lo que depende que esta misma suite no toque el estado real.
assert.strictEqual(state.getStateFilePath(), TEST_STATE_FILE, 'El override explícito gana');
console.log('✔ Test 34 [BE-007]: TELEGRAM_BRIDGE_STATE_FILE tiene precedencia sobre el directorio de datos');

// Test 35 [BE-007]: importar un módulo no debe tocar el disco.
// La primera versión resolvía las rutas en el cuerpo del módulo, y como
// `resolveDataFile` crea directorios y migra el fichero heredado, bastaba con
// ejecutar esta suite —que importa bot.js— para MOVER el lockfile del bot que
// estuviera corriendo de verdad. Importar no es usar.
{
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-import-'));
  const codigo = path.join(raiz, 'telegram-bridge');
  const datos = path.join(raiz, 'datos');
  fs.mkdirSync(codigo, { recursive: true });
  for (const f of ['bot.js', 'state.js', 'paths.js', 'policy.js', 'logrotate.js', 'executor.js', 'formatter.js', 'queue.js', 'claude-launcher.js']) {
    fs.copyFileSync(path.join(import.meta.dirname, f), path.join(codigo, f));
  }
  fs.symlinkSync(path.join(import.meta.dirname, 'node_modules'), path.join(codigo, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(codigo, 'bridge.lock'), JSON.stringify({ pid: 999999, startedAt: null, bootId: null }));
  fs.writeFileSync(path.join(codigo, 'state.json'), '{"chats":{},"pendingAsks":{}}');

  const hijo = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  // En Windows `import()` exige una URL file://: una ruta absoluta con letra de
  // unidad se interpreta como el protocolo «c:».
  const res = hijo.spawnSync(process.execPath, ['-e', 'import(process.argv[1]).then(()=>console.log("importado"))', pathToFileURL(path.join(codigo, 'bot.js')).href], {
    env: {
      ...process.env,
      TELEGRAM_BRIDGE_DATA_DIR: datos,
      TELEGRAM_BRIDGE_STATE_FILE: '',
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN
    },
    encoding: 'utf8'
  });

  assert(res.stdout.includes('importado'), `El módulo debe importarse limpiamente: ${res.stderr}`);
  assert(fs.existsSync(path.join(codigo, 'bridge.lock')), 'Importar bot.js NO debe migrar el lockfile');
  assert(fs.existsSync(path.join(codigo, 'state.json')), 'Importar bot.js NO debe migrar el state.json');
  assert(!fs.existsSync(datos), 'Importar bot.js NO debe crear siquiera el directorio de datos');

  fs.rmSync(path.join(codigo, 'node_modules'), { recursive: false, force: true });
  fs.rmSync(raiz, { recursive: true, force: true });
}
console.log('✔ Test 35 [BE-007]: importar bot.js no crea directorios ni migra ficheros');

// Test 36 [BE-008]: el .env se busca tambien en una ubicacion que sobrevive a
// `claude plugin update`.
//
// Contexto: cada version del plugin se instala en su PROPIO directorio
// (`cache/<market>/<plugin>/<version>/`) y la actualizacion no arrastra los
// ficheros que no estan en git. Un `.env` junto al codigo desaparece en cada
// update, y el sintoma no es un fallo de arranque sino una herramienta que un
// dia responde «No hay usuarios configurados»: credenciales duraderas dentro
// de un directorio versionado, la misma clase de defecto que BE-007.
{
  const paths = await import('./paths.js');
  const dataPrevio = process.env.TELEGRAM_BRIDGE_DATA_DIR;
  const envPrevio = process.env.TELEGRAM_BRIDGE_ENV_FILE;

  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-env-'));
  const datos = path.join(raiz, 'datos');
  const plugin = path.join(raiz, 'cache', 'lagrange', '0.9.0');
  const bridge = path.join(plugin, 'telegram-bridge');
  fs.mkdirSync(bridge, { recursive: true });
  fs.mkdirSync(datos, { recursive: true });
  process.env.TELEGRAM_BRIDGE_DATA_DIR = datos;
  delete process.env.TELEGRAM_BRIDGE_ENV_FILE;

  const candidatos = paths.bridgeEnvCandidates(bridge);
  assert.strictEqual(candidatos[0], path.join(bridge, '.env'), 'Primero el .env del bridge');
  assert.strictEqual(candidatos[1], path.join(plugin, '.env'), 'Luego el de la raiz del plugin');
  assert.strictEqual(candidatos[2], path.join(datos, '.env'), 'Y por ultimo el duradero');

  // Sin ningun .env: el diagnostico debe decir donde se busco y cual es el
  // duradero. Sin eso, el fallo no es accionable.
  const diag = paths.describeEnvSearch(candidatos);
  for (const c of candidatos) assert(diag.includes(c), `El diagnostico nombra ${c}`);
  assert(/plugin update/i.test(diag), 'El diagnostico explica por que se pierde');
  assert.strictEqual(paths.loadBridgeEnv(bridge).loaded, null, 'Sin ficheros no carga nada');

  // Solo el duradero: es el escenario justo despues de un plugin update.
  fs.writeFileSync(path.join(datos, '.env'), 'AGY_TEST_ENV_MARKER=duradero\n');
  delete process.env.AGY_TEST_ENV_MARKER;
  const soloDuradero = paths.loadBridgeEnv(bridge);
  assert.strictEqual(soloDuradero.loaded, path.join(datos, '.env'), 'Cae al .env duradero');
  assert.strictEqual(process.env.AGY_TEST_ENV_MARKER, 'duradero', 'Y carga sus variables');

  // El .env local sigue teniendo precedencia: ninguna instalacion existente
  // cambia de fichero por este arreglo.
  fs.writeFileSync(path.join(bridge, '.env'), 'AGY_TEST_ENV_MARKER=local\n');
  delete process.env.AGY_TEST_ENV_MARKER;
  const conLocal = paths.loadBridgeEnv(bridge);
  assert.strictEqual(conLocal.loaded, path.join(bridge, '.env'), 'El .env local gana');
  assert.strictEqual(process.env.AGY_TEST_ENV_MARKER, 'local', 'Y son sus variables las que quedan');

  // Override explicito por encima de todo.
  const suelto = path.join(raiz, 'otro.env');
  fs.writeFileSync(suelto, 'AGY_TEST_ENV_MARKER=explicito\n');
  process.env.TELEGRAM_BRIDGE_ENV_FILE = suelto;
  delete process.env.AGY_TEST_ENV_MARKER;
  assert.strictEqual(paths.loadBridgeEnv(bridge).loaded, suelto, 'TELEGRAM_BRIDGE_ENV_FILE manda');
  assert.strictEqual(process.env.AGY_TEST_ENV_MARKER, 'explicito', 'Y carga sus variables');

  // Buscar el .env NO puede crear el directorio de datos: la busqueda ocurre en
  // el cuerpo del modulo, y crear directorios ahi convierte un import en una
  // escritura (la misma invariante que fija el Test 35).
  const datosVirgen = path.join(raiz, 'sin-crear');
  process.env.TELEGRAM_BRIDGE_DATA_DIR = datosVirgen;
  delete process.env.TELEGRAM_BRIDGE_ENV_FILE;
  paths.bridgeEnvCandidates(bridge);
  paths.loadBridgeEnv(bridge);
  assert(!fs.existsSync(datosVirgen), 'Buscar el .env no crea el directorio de datos');

  delete process.env.AGY_TEST_ENV_MARKER;
  if (dataPrevio === undefined) delete process.env.TELEGRAM_BRIDGE_DATA_DIR;
  else process.env.TELEGRAM_BRIDGE_DATA_DIR = dataPrevio;
  if (envPrevio === undefined) delete process.env.TELEGRAM_BRIDGE_ENV_FILE;
  else process.env.TELEGRAM_BRIDGE_ENV_FILE = envPrevio;
  fs.rmSync(raiz, { recursive: true, force: true });
}
console.log('✔ Test 36 [BE-008]: el .env sobrevive a un plugin update sin cambiar la precedencia');

// Test 37 [SEC-003]: el contenido que se sube a Telegram se redacta.
// `deny_paths` decide QUE fichero puede salir; esto decide QUE va dentro. Son
// controles distintos y hacen falta los dos: un resumen de sesion es un fichero
// perfectamente permitido cuyo contenido se deriva del transcript -- rutas,
// lineas de comando completas, salidas de herramientas. Si por una de esas
// lineas paso un token, viajaba a los servidores de Telegram sin filtrar.
{
  const notify = await import('./notify.js');
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-upload-'));
  const TOKEN_FALSO = '1234567890:AAFakeTokenParaEsteTestNoEsReal';

  const md = path.join(dirTmp, 'handoff.md');
  const contenido = '# Handoff\n\nSe exporto TELEGRAM_BOT_TOKEN=' + TOKEN_FALSO + ' en la consola.\n';
  fs.writeFileSync(md, contenido);

  const subido = notify.leerParaSubir(md, 'handoff.md').toString('utf8');
  assert(!subido.includes('AAFakeTokenParaEsteTest'), 'El token no debe viajar dentro del .md subido');
  assert(subido.includes('[REDACTED]'), 'La redaccion debe quedar marcada');
  assert(subido.includes('# Handoff'), 'El resto del documento se conserva');

  const enDisco = fs.readFileSync(md, 'utf8');
  assert.strictEqual(enDisco, contenido, 'El fichero en disco NO se modifica');

  // Un binario se sube tal cual: redactarlo lo corromperia.
  const bin = path.join(dirTmp, 'nota.ogg');
  const bytes = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0xff, 0xfe, 0x01]);
  fs.writeFileSync(bin, bytes);
  assert(notify.leerParaSubir(bin, 'nota.ogg').equals(bytes), 'Un binario se sube byte a byte');

  // Un texto sin secretos vuelve identico.
  const limpio = path.join(dirTmp, 'limpio.md');
  fs.writeFileSync(limpio, '# Sin secretos\n');
  assert.strictEqual(
    notify.leerParaSubir(limpio, 'limpio.md').toString('utf8'),
    '# Sin secretos\n',
    'Un texto limpio no cambia'
  );

  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 37 [SEC-003]: la subida de ficheros redacta secretos y no toca el disco');

// Test 38 [FEAT-001 / BE-008]: getKnownWorkspaces lee proyectos, normaliza, descarta WSL y deduplica por casing
{
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-test-'));
  const fakeConfig = path.join(dirTmp, '.claude.json');

  const dir1 = path.join(dirTmp, 'app1', 'frontend');
  const dir2 = path.join(dirTmp, 'app2', 'frontend');
  const dir3 = path.join(dirTmp, 'landing');
  fs.mkdirSync(dir1, { recursive: true });
  fs.mkdirSync(dir2, { recursive: true });
  fs.mkdirSync(dir3, { recursive: true });

  const fakeJson = {
    projects: {
      [dir1]: {},
      [dir1.toLowerCase()]: {}, // Duplicado de casing
      [dir2]: {}, // Misma base "frontend" pero padre "app2"
      [dir3]: {},
      [path.join(dirTmp, 'no_existe')]: {}, // Inexistente
      'wsl:ubuntu-24.04:/home/user/backend': {} // WSL
    }
  };

  const rawOriginal = JSON.stringify(fakeJson, null, 2);
  fs.writeFileSync(fakeConfig, rawOriginal, 'utf8');

  const workspaces = claudeLauncher.getKnownWorkspaces({ claudeJsonPath: fakeConfig });

  // 1. Debe haber exactamente 3 proyectos válidos (dir1, dir2, dir3)
  assert.strictEqual(workspaces.length, 3, 'Debe descartar inexistentes, WSL y duplicados de casing');

  // 2. Comprobar desambiguación de nombres duplicados ("frontend (app1)" y "frontend (app2)")
  const ws1 = workspaces.find((w) => w.path.toLowerCase() === dir1.toLowerCase());
  const ws2 = workspaces.find((w) => w.path.toLowerCase() === dir2.toLowerCase());
  const ws3 = workspaces.find((w) => w.path.toLowerCase() === dir3.toLowerCase());

  assert(ws1 && ws2 && ws3, 'Todos los proyectos reales deben encontrarse');
  assert.strictEqual(ws1.name, 'frontend');
  assert.strictEqual(ws2.name, 'frontend');
  assert(ws1.displayName.includes('app1'), 'ws1 debe estar desambiguado con su carpeta padre app1');
  assert(ws2.displayName.includes('app2'), 'ws2 debe estar desambiguado con su carpeta padre app2');
  assert.strictEqual(ws3.displayName, 'landing', 'ws3 sin colisión conserva su nombre directo');

  // 3. Comprobar que los IDs sean compactos y estables (hash de 8 caracteres) y mantengan numericId
  assert(workspaces.every((w) => typeof w.id === 'string' && /^[0-9a-f]{8}$/.test(w.id)), 'Los IDs deben ser hashes hexadecimales estables de 8 caracteres');
  assert(workspaces.every((w, idx) => w.numericId === idx), 'numericId debe ser secuencial para compatibilidad retroactiva');

  // 4. Invariante de seguridad: el archivo fuente NUNCA se modifica
  const rawDespues = fs.readFileSync(fakeConfig, 'utf8');
  assert.strictEqual(rawOriginal, rawDespues, 'El archivo .claude.json nunca debe ser modificado por la lectura');

  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 38 [FEAT-001 / BE-008]: getKnownWorkspaces lee proyectos, normaliza, descarta WSL y deduplica por casing sin tocar disco');

// Test 39 [BE-008]: getKnownWorkspaces ante archivo inexistente o JSON corrupto
{
  const noExiste = path.join(os.tmpdir(), 'archivo_que_no_existe_jamas.json');
  assert.deepStrictEqual(claudeLauncher.getKnownWorkspaces({ claudeJsonPath: noExiste }), [], 'Archivo inexistente retorna []');

  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-badjson-'));
  const badJson = path.join(dirTmp, 'corrupt.json');
  fs.writeFileSync(badJson, '{ "projects": { invalid JSON ...', 'utf8');
  assert.deepStrictEqual(claudeLauncher.getKnownWorkspaces({ claudeJsonPath: badJson }), [], 'JSON corrupto retorna [] sin lanzar');
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 39 [BE-008]: getKnownWorkspaces es resiliente a fichero ausente o JSON corrupto');

// Test 40 [FEAT-002]: resolveClaudeBin localiza el ejecutable de Claude Code
{
  const binClaude = claudeLauncher.resolveClaudeBin();
  assert(typeof binClaude === 'string' && binClaude.length > 0, 'resolveClaudeBin debe retornar una cadena no vacía');
  assert(/claude(\.exe|\.cmd)?$/i.test(binClaude), `El binario debe apuntar a claude: ${binClaude}`);
}
console.log('✔ Test 40 [FEAT-002]: resolveClaudeBin localiza el ejecutable de Claude Code en el sistema');

// Test 41 [FEAT-003 / BE-009]: Persistencia y liveliness check de claudeSession
{
  // 1. Estado inicial limpio
  state.clearActiveClaudeSession();
  assert.strictEqual(state.getActiveClaudeSession(), null, 'Inicialmente no debe haber sesión activa');

  // 2. Registrar sesión con el PID del proceso actual (proceso vivo conocido)
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-test-'));
  const testSession = {
    pid: process.pid,
    projectPath: dirTmp,
    sessionName: 'Mobile-test-project'
  };
  const registered = state.setActiveClaudeSession(testSession);
  assert.strictEqual(registered.pid, process.pid, 'Debe registrar el PID indicado');
  assert.strictEqual(registered.projectPath, dirTmp, 'Debe registrar el projectPath');
  assert.strictEqual(registered.sessionName, 'Mobile-test-project', 'Debe registrar el sessionName');
  assert(typeof registered.startedAt === 'string' && registered.startedAt.length > 0, 'Debe incluir timestamp startedAt');

  // 3. getActiveClaudeSession debe retornar la sesión viva
  const active = state.getActiveClaudeSession();
  assert(active !== null, 'Debe retornar la sesión activa viva');
  assert.strictEqual(active.pid, process.pid, 'El PID debe coincidir');
  assert.strictEqual(active.projectPath, dirTmp, 'El projectPath debe coincidir');
  assert.strictEqual(active.sessionName, 'Mobile-test-project', 'El sessionName debe coincidir');
  assert.strictEqual(active.startedAt, registered.startedAt, 'startedAt debe coincidir');

  // 4. Comprobar persistencia física en state.json
  const rawState = JSON.parse(fs.readFileSync(TEST_STATE_FILE, 'utf8'));
  assert(rawState.claudeSession, 'state.json debe contener la clave claudeSession');
  assert.strictEqual(rawState.claudeSession.pid, process.pid, 'El PID debe estar persistido en disco');

  // 5. Comprobar que un PID muerto es purgado automáticamente al consultar
  const FAKE_DEAD_PID = 99999999;
  state.setActiveClaudeSession({
    pid: FAKE_DEAD_PID,
    projectPath: dirTmp,
    sessionName: 'Mobile-dead-session'
  });
  const deadActive = state.getActiveClaudeSession();
  assert.strictEqual(deadActive, null, 'Un PID inexistente debe retornar null');
  assert.strictEqual(state.loadState().claudeSession, null, 'El estado debe haberse limpiado automáticamente');

  // 6. Comprobar clearActiveClaudeSession explícito
  state.setActiveClaudeSession(testSession);
  assert(state.getActiveClaudeSession() !== null, 'La sesión debe estar activa antes de limpiar');
  state.clearActiveClaudeSession();
  assert.strictEqual(state.getActiveClaudeSession(), null, 'clearActiveClaudeSession debe eliminar la sesión');
  assert.strictEqual(state.loadState().claudeSession, null, 'El estado en caché/disco debe ser null');

  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 41 [FEAT-003 / BE-009]: Persistencia y liveliness check de claudeSession validados');

// Test 42 [FEAT-003 / SEC-005]: launchClaudeRemoteSession inicia sesión desacoplada sin secretos en entorno
{
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-test-'));
  state.clearActiveClaudeSession();

  // 1. Validar fallo si el directorio de trabajo no existe
  const noExistePath = path.join(os.tmpdir(), 'no-existe-para-launch-test-xyz');
  const resInexistente = claudeLauncher.launchClaudeRemoteSession({ workspacePath: noExistePath });
  assert.strictEqual(resInexistente.success, false, 'Debe fallar si workspacePath no existe');
  assert(resInexistente.error.includes('no existe'), 'Error debe indicar que la ruta no existe');

  // 1.b Validar rechazo por Project Allowlist si la ruta no está autorizada
  const resNoAllowlist = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmp,
    skipAllowlistCheck: false
  });
  assert.strictEqual(resNoAllowlist.success, false, 'Debe fallar si no pertenece a la Project Allowlist');
  assert(resNoAllowlist.error.includes('Project Allowlist'), 'Debe reportar violación de Project Allowlist');

  // 2. Simular spawnFn para capturar invocación exacta y registrar listeners
  const spawnCalls = [];
  let unrefCalled = false;
  let errorHandler = null;
  const mockChild = {
    pid: process.pid, // Usamos process.pid para que getActiveClaudeSession lo considere vivo
    unref: () => { unrefCalled = true; },
    on: (event, fn) => {
      if (event === 'error') errorHandler = fn;
    }
  };
  const mockSpawn = (bin, args, opts) => {
    spawnCalls.push({ bin, args, opts });
    return mockChild;
  };

  // Asegurar que existe un secreto en process.env para verificar saneamiento
  process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;

  // 3. Invocación con sessionName por defecto (Mobile-<basename>)
  const resOk = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmp,
    spawnFn: mockSpawn,
    skipAllowlistCheck: true,
    findExistingFn: () => null
  });

  assert.strictEqual(resOk.success, true, 'El lanzamiento debe ser exitoso');
  assert.strictEqual(resOk.pid, process.pid, 'Debe retornar el PID del proceso');
  assert.strictEqual(resOk.projectPath, dirTmp, 'Debe retornar el projectPath');
  assert.strictEqual(resOk.spawnMode, 'same-dir', 'Debe usar same-dir por defecto');
  const expectedDefaultName = `Mobile-${path.basename(dirTmp)}`;
  assert.strictEqual(resOk.sessionName, expectedDefaultName, 'Debe formatear Mobile-<basename> por defecto');
  assert.strictEqual(unrefCalled, true, 'child.unref() debe haber sido llamado');

  // Verificar llamada a spawnFn (subcomando headless remote-control con flag --spawn)
  assert.strictEqual(spawnCalls.length, 1, 'Debe haber llamado a spawnFn una vez');
  const call = spawnCalls[0];
  assert.strictEqual(call.bin, claudeLauncher.resolveClaudeBin(), 'Debe usar el binario resuelto de Claude');
  assert.deepStrictEqual(
    call.args,
    ['remote-control', '--name', expectedDefaultName, '--spawn=same-dir'],
    'Argumentos deben ser [remote-control, --name, sessionName, --spawn=same-dir]'
  );
  assert.strictEqual(call.opts.cwd, dirTmp, 'cwd debe ser workspacePath');
  assert(
    call.opts.stdio === 'ignore' || (Array.isArray(call.opts.stdio) && call.opts.stdio[0] === 'ignore'),
    'stdio debe ser ignore o descriptor desacoplado [ignore, fd, fd]'
  );

  // Invariante de seguridad [SEC-005]: el entorno pasado NO debe contener secretos de Telegram
  assert.strictEqual(call.opts.env.TELEGRAM_BOT_TOKEN, undefined, 'TELEGRAM_BOT_TOKEN no debe heredarse');
  assert.strictEqual(call.opts.env.TELEGRAM_NOTIFY_CHAT_ID, undefined, 'TELEGRAM_NOTIFY_CHAT_ID no debe heredarse');
  assert.strictEqual(call.opts.env.ALLOWED_USER_IDS, undefined, 'ALLOWED_USER_IDS no debe heredarse');

  // Verificar que la sesión quedó registrada en state
  const activeSession = state.getActiveClaudeSession();
  assert(activeSession !== null, 'La sesión debe estar registrada en state');
  assert.strictEqual(activeSession.sessionName, expectedDefaultName);

  // 4. Validar prevención de doble sesión cuando ya hay una activa en OTRO proyecto
  const dirTmpOtro = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-other-'));
  const resDoble = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmpOtro,
    spawnFn: mockSpawn,
    skipAllowlistCheck: true,
    findExistingFn: () => null
  });
  assert.strictEqual(resDoble.success, false, 'No debe permitir lanzar si ya hay una sesión activa');
  assert(resDoble.error.includes('Ya existe una sesión activa'), 'Mensaje de error indica sesión activa');
  assert(resDoble.session && resDoble.session.pid === process.pid, 'Debe retornar la sesión activa');
  assert.strictEqual(spawnCalls.length, 1, 'No debe haber llamado a spawnFn de nuevo');
  fs.rmSync(dirTmpOtro, { recursive: true, force: true });

  // 5. Invocación con sessionName y spawnMode personalizados
  state.clearActiveClaudeSession();
  const resCustom = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmp,
    sessionName: 'MiSesionPersonalizada',
    spawnMode: 'worktree',
    spawnFn: mockSpawn,
    skipAllowlistCheck: true,
    findExistingFn: () => null
  });
  assert.strictEqual(resCustom.success, true);
  assert.strictEqual(resCustom.sessionName, 'MiSesionPersonalizada');
  assert.strictEqual(resCustom.spawnMode, 'worktree');
  assert.deepStrictEqual(spawnCalls[1].args, ['remote-control', '--name', 'MiSesionPersonalizada', '--spawn=worktree']);

  // 6. Validar F-01: child.on('error') limpia la sesión activa si el proceso falla asíncronamente
  assert(typeof errorHandler === 'function', 'Debe haber registrado listener para child.on("error")');
  errorHandler(new Error('Simulated spawn ENOENT'));
  assert.strictEqual(state.getActiveClaudeSession(), null, 'El error en proceso hijo debe limpiar activeSession');

  // 7. Validar F-02: binario terminado en .cmd en Windows se envuelve en cmd.exe /d /s /c
  if (process.platform === 'win32') {
    const cmdCalls = [];
    const mockSpawnCmd = (bin, args, opts) => {
      cmdCalls.push({ bin, args, opts });
      return mockChild;
    };
    claudeLauncher.launchClaudeRemoteSession({
      workspacePath: dirTmp,
      claudeBin: 'C:\\fake\\npm\\claude.cmd',
      spawnFn: mockSpawnCmd,
      skipAllowlistCheck: true,
      findExistingFn: () => null
    });
    assert.strictEqual(cmdCalls.length, 1);
    assert(cmdCalls[0].bin.toLowerCase().endsWith('cmd.exe'), 'Debe usar cmd.exe como binario de spawn');
    assert.strictEqual(cmdCalls[0].args[0], '/d');
    assert.strictEqual(cmdCalls[0].args[1], '/s');
    assert.strictEqual(cmdCalls[0].args[2], '/c');
    assert.strictEqual(cmdCalls[0].args[3], 'C:\\fake\\npm\\claude.cmd');
    assert.strictEqual(cmdCalls[0].args[4], 'remote-control');
  }

  // Limpieza
  state.clearActiveClaudeSession();
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 42 [FEAT-003 / SEC-005 / BE-008]: launchClaudeRemoteSession desacoplado, sin secretos, headless y con guardas F-01/F-02');

// Test 43 [FEAT-003 / BE-009]: stopClaudeRemoteSession termina el árbol de procesos y limpia el estado
{
  state.clearActiveClaudeSession();

  // 1. Validar error si no hay sesión activa
  const resNoSession = claudeLauncher.stopClaudeRemoteSession();
  assert.strictEqual(resNoSession.success, false, 'Debe fallar si no hay sesión activa');
  assert.strictEqual(
    resNoSession.error,
    'No hay ninguna sesión activa de Claude para detener.',
    'Debe retornar mensaje exacto de sesión inexistente'
  );

  // 2. Registrar sesión activa simulada con process.pid
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stop-test-'));
  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: dirTmp,
    sessionName: 'Mobile-to-stop'
  });
  assert(state.getActiveClaudeSession() !== null, 'Debe haber sesión activa antes de detener');

  // 3. Simular execFileFn para Windows
  const execCalls = [];
  const mockExecFile = (file, args, cb) => {
    execCalls.push({ file, args });
    if (typeof cb === 'function') cb(null, '', '');
  };

  // 4. Detener sesión en Windows
  const resStopWin = claudeLauncher.stopClaudeRemoteSession({
    execFileFn: mockExecFile,
    platform: 'win32'
  });

  assert.strictEqual(resStopWin.success, true, 'stopClaudeRemoteSession debe ser exitoso');
  assert.strictEqual(resStopWin.pid, process.pid, 'Debe retornar el pid detenido');
  assert.strictEqual(resStopWin.sessionName, 'Mobile-to-stop', 'Debe retornar el sessionName');

  assert.strictEqual(execCalls.length, 1, 'Debe haber invocado taskkill una vez');
  assert.strictEqual(execCalls[0].file, 'taskkill', 'El comando debe ser taskkill');
  assert.deepStrictEqual(
    execCalls[0].args,
    ['/pid', String(process.pid), '/T', '/F'],
    'Debe invocar taskkill con /pid <PID> /T /F'
  );

  // Verificar que el estado se limpió
  assert.strictEqual(state.getActiveClaudeSession(), null, 'El estado debe quedar limpio tras detener');

  // 5. Probar rama POSIX (señales SIGTERM y SIGKILL)
  const posixSignals = [];
  const mockKill = (targetPid, signal) => {
    posixSignals.push({ targetPid, signal });
  };

  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: dirTmp,
    sessionName: 'Mobile-posix-test'
  });

  const resStopPosix = claudeLauncher.stopClaudeRemoteSession({
    platform: 'linux',
    killFn: mockKill
  });

  assert.strictEqual(resStopPosix.success, true, 'stopClaudeRemoteSession en POSIX debe ser exitoso');
  assert.strictEqual(resStopPosix.pid, process.pid);
  assert.strictEqual(resStopPosix.sessionName, 'Mobile-posix-test');
  assert(posixSignals.some((s) => s.signal === 'SIGTERM'), 'Debe enviar SIGTERM');
  assert(posixSignals.some((s) => s.signal === 'SIGKILL'), 'Debe enviar SIGKILL');
  assert.strictEqual(state.getActiveClaudeSession(), null, 'El estado debe quedar limpio en POSIX');

  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 43 [FEAT-003 / BE-009]: stopClaudeRemoteSession termina el árbol de procesos y limpia el estado');

// Test 44 [FEAT-001 / BE-008]: buildWorkspacesKeyboard genera teclado interactivo con callback_data compacto
{
  const mockWorkspaces = [
    { id: 'a1b2c3d4', path: 'C:\\vs work\\app1\\frontend', name: 'frontend', displayName: 'frontend (app1)' },
    { id: 'e5f60718', path: 'C:\\vs work\\app2\\frontend', name: 'frontend', displayName: 'frontend (app2)' },
    { id: '293a4b5c', path: 'C:\\vs work\\landing', name: 'landing', displayName: 'landing' }
  ];

  const keyboard = buildWorkspacesKeyboard(mockWorkspaces);
  const inline = keyboard.inline_keyboard;

  // 3 filas para los proyectos + 1 fila para el botón Cancelar = 4 filas
  assert.strictEqual(inline.length, 4, 'Debe haber 4 filas en el teclado');
  assert.strictEqual(inline[0][0].text, '📁 frontend (app1)');
  assert.strictEqual(inline[0][0].callback_data, 'rc_start:a1b2c3d4');
  assert.strictEqual(inline[1][0].text, '📁 frontend (app2)');
  assert.strictEqual(inline[1][0].callback_data, 'rc_start:e5f60718');
  assert.strictEqual(inline[2][0].text, '📁 landing');
  assert.strictEqual(inline[2][0].callback_data, 'rc_start:293a4b5c');
  assert.strictEqual(inline[3][0].text, '❌ Cancelar');
  assert.strictEqual(inline[3][0].callback_data, 'rc_cancel');

  // Verificar que NINGÚN callback_data exceda el límite de 64 bytes de Telegram
  for (const fila of inline) {
    for (const btn of fila) {
      const bytes = Buffer.byteLength(btn.callback_data, 'utf8');
      assert(bytes <= 64, `callback_data "${btn.callback_data}" excede 64 bytes (${bytes} bytes)`);
    }
  }
}
console.log('✔ Test 44 [FEAT-001 / BE-008]: buildWorkspacesKeyboard genera teclado con callback_data compacto');

// Test 45 [FEAT-001 / FEAT-002]: Comando /claude responde con estado o lista de workspaces
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();
  state.clearActiveClaudeSession();

  const updateCmd = (cmd, args = '', updateId = 100) => {
    const text = args ? `/${cmd} ${args}` : `/${cmd}`;
    return {
      update_id: updateId,
      message: {
        message_id: 100 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: cmd.length + 1 }]
      }
    };
  };

  // 1. /claude status cuando no hay sesión
  await bot.handleUpdate(updateCmd('claude', 'status', 100));
  assert(llamadas.length > 0, 'Debe haber respondido a /claude status');
  assert(llamadas[0].payload.text.includes('No hay ninguna sesión activa'), 'Avisa que no hay sesión');

  // 2. /claude stop cuando no hay sesión
  llamadas.length = 0;
  await bot.handleUpdate(updateCmd('claude', 'stop', 101));
  assert(llamadas.length > 0, 'Debe haber respondido a /claude stop');
  assert(llamadas[0].payload.text.includes('No hay ninguna sesión activa'), 'Reporta que no hay sesión');

  // 3. /claude cuando hay sesión activa inyectada
  llamadas.length = 0;
  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: 'C:\\fake\\project',
    sessionName: 'Mobile-test'
  });

  await bot.handleUpdate(updateCmd('claude', '', 102));
  assert(llamadas[0].payload.text.includes('Sesión de Claude Code Activa'), 'Detecta sesión activa');
  assert(llamadas[0].payload.text.includes('Mobile-test'), 'Muestra nombre de sesión');
  assert(llamadas[0].payload.reply_markup, 'Ofrece botones para detener o cambiar');

  // 4. Limpiamos sesión activa
  state.clearActiveClaudeSession();
  resetRuntimeState();
}
console.log('✔ Test 45 [FEAT-001 / FEAT-002]: Comando /claude responde con estado y gestión de sesión');

// Test 46 [FEAT-001 / BE-008]: Callbacks interactivos rc_cancel y rc_stop
{
  const { bot, llamadas } = botDePrueba();
  resetRuntimeState();

  const callback = (data, updateId) => ({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: Number(USUARIO_OK), is_bot: false, first_name: 'Test' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 500 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(USUARIO_OK), type: 'private' },
        from: { id: 1, is_bot: true, first_name: 'bot' },
        text: 'prompt'
      }
    }
  });

  // Callback rc_cancel
  await bot.handleUpdate(callback('rc_cancel', 200));
  const ansCancel = llamadas.find((c) => c.method === 'answerCallbackQuery' && c.payload.text === 'Operación cancelada');
  assert(ansCancel, 'rc_cancel responde con acuse');

  // Callback rc_start con id inexistente
  llamadas.length = 0;
  await bot.handleUpdate(callback('rc_start:9999', 201));
  const ansInvalido = llamadas.find((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('no encontrado'));
  assert(ansInvalido, 'rc_start con ID inválido responde que no fue encontrado');

  // Callback rc_stop cuando no hay sesión activa
  llamadas.length = 0;
  state.clearActiveClaudeSession();
  await bot.handleUpdate(callback('rc_stop', 202));
  const ansStopNoSession = llamadas.find((c) => c.method === 'answerCallbackQuery' && c.payload.text.includes('Deteniendo'));
  assert(ansStopNoSession, 'rc_stop responde con acuse');
  const msgNoSession = llamadas.find((c) => c.method === 'sendMessage' && c.payload.text.includes('No hay ninguna sesión activa'));
  assert(msgNoSession, 'rc_stop informa que no hay sesión activa');

  resetRuntimeState();
}
console.log('✔ Test 46 [FEAT-001 / BE-008]: Callbacks interactivos rc_cancel, rc_stop y validación de IDs en rc_start');

// Test 47 [FEAT-001 / BE-008]: Cambio de proyecto (F-03) detiene la sesión activa previa y lanza la nueva
{
  state.clearActiveClaudeSession();
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-switch-test-'));

  // Simular sesión activa previa
  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: 'C:\\fake\\old-proj',
    sessionName: 'Mobile-old'
  });
  assert(state.getActiveClaudeSession() !== null, 'Debe haber sesión activa previa');

  // Mock para execFileSyncFn y spawnFn
  let killCalledWith = null;
  const mockKill = (bin, args) => {
    killCalledWith = { bin, args };
  };

  let mockSpawnCalled = false;
  const mockSpawn = () => {
    mockSpawnCalled = true;
    return { pid: process.pid, unref: () => {}, on: () => {} };
  };

  const resSwitch = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirTmp,
    replaceActive: true,
    spawnFn: mockSpawn,
    skipAllowlistCheck: true,
    findExistingFn: () => null,
    stopOptions: { execFileSyncFn: mockKill, platform: 'win32' }
  });

  assert.strictEqual(resSwitch.success, true, 'El reemplazo de sesión debe ser exitoso');
  assert(killCalledWith !== null, 'Debe haber llamado a taskkill mockeado');
  assert.strictEqual(killCalledWith.args[1], String(process.pid));
  assert.strictEqual(mockSpawnCalled, true, 'Debe haber invocado spawnFn para la nueva sesión');
  const active = state.getActiveClaudeSession();
  assert(active !== null, 'Debe haber nueva sesión activa');
  assert.strictEqual(active.projectPath, dirTmp, 'La nueva sesión debe apuntar al nuevo proyecto');

  state.clearActiveClaudeSession();
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
console.log('✔ Test 47 [FEAT-001 / BE-008]: Cambio de proyecto (F-03) reemplaza sesión activa limpiamente');

// Test 48 [SEC-006 / BE-010]: Separación estricta de Allowlists e Idempotencia del spawn (una sesión por proyecto)
{
  state.clearActiveClaudeSession();

  // --- Parte 1: Separación de Allowlists (Project Allowlist) ---
  const dirBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-allowlist-test-'));
  const dirProjA = path.join(dirBase, 'proj-allowed');
  const dirProjB = path.join(dirBase, 'proj-forbidden');
  const dirSecret = path.join(dirBase, 'proj-secret');
  fs.mkdirSync(dirProjA, { recursive: true });
  fs.mkdirSync(dirProjB, { recursive: true });
  fs.mkdirSync(dirSecret, { recursive: true });

  const mockClaudeJson = path.join(dirBase, 'claude.json');
  fs.writeFileSync(mockClaudeJson, JSON.stringify({
    projects: {
      [dirProjA]: { remoteControlSpawnMode: 'same-dir' },
      [dirProjB]: { remoteControlSpawnMode: 'worktree' },
      [dirSecret]: { remoteControlSpawnMode: 'same-dir' }
    }
  }, null, 2));

  // 1.1 Con allowedWorkspacesSet restringiendo solo a 'proj-allowed'
  const allowlistOnlyA = claudeLauncher.getProjectAllowlist({
    claudeJsonPath: mockClaudeJson,
    allowedWorkspacesSet: new Set(['proj-allowed']),
    denyPaths: ['*secret*']
  });
  assert.strictEqual(allowlistOnlyA.length, 1, 'Solo debe incluir el proyecto permitido');
  assert.strictEqual(path.resolve(allowlistOnlyA[0].path).toLowerCase(), path.resolve(dirProjA).toLowerCase());

  // 1.2 isWorkspaceAllowed valida membresía
  assert.strictEqual(
    claudeLauncher.isWorkspaceAllowed(dirProjA, {
      claudeJsonPath: mockClaudeJson,
      allowedWorkspacesSet: new Set(['proj-allowed']),
      denyPaths: ['*secret*']
    }),
    true,
    'dirProjA debe ser permitido'
  );

  assert.strictEqual(
    claudeLauncher.isWorkspaceAllowed(dirProjB, {
      claudeJsonPath: mockClaudeJson,
      allowedWorkspacesSet: new Set(['proj-allowed']),
      denyPaths: ['*secret*']
    }),
    false,
    'dirProjB debe ser rechazado por no estar en la allowlist explícita'
  );

  assert.strictEqual(
    claudeLauncher.isWorkspaceAllowed(dirSecret, {
      claudeJsonPath: mockClaudeJson,
      denyPaths: ['*secret*']
    }),
    false,
    'dirSecret debe ser rechazado por coincidir con deny_paths'
  );

  // 1.3 launchClaudeRemoteSession rechaza workspace no permitido sin invocar spawnFn
  let unauthorizedSpawnInvoked = false;
  const resDenied = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirProjB,
    allowlistOptions: {
      claudeJsonPath: mockClaudeJson,
      allowedWorkspacesSet: new Set(['proj-allowed'])
    },
    spawnFn: () => {
      unauthorizedSpawnInvoked = true;
      return { pid: 99999, unref: () => {}, on: () => {} };
    }
  });
  assert.strictEqual(resDenied.success, false, 'Debe fallar ante proyecto no autorizado');
  assert(resDenied.error.includes('Project Allowlist'), 'Debe reportar que no pertenece a la Project Allowlist');
  assert.strictEqual(unauthorizedSpawnInvoked, false, 'No debe invocar spawnFn bajo ninguna circunstancia');

  // 1.4 F-06 / F-07: Comprobar fusión de trust status y rechazo si hasTrustDialogAccepted es false
  const dirUntrusted = path.join(dirBase, 'proj-untrusted');
  fs.mkdirSync(dirUntrusted, { recursive: true });
  const mockClaudeTrustJson = path.join(dirBase, 'claude-trust.json');
  fs.writeFileSync(mockClaudeTrustJson, JSON.stringify({
    projects: {
      [dirUntrusted]: { hasTrustDialogAccepted: false },
      [dirProjA.toLowerCase()]: { hasTrustDialogAccepted: false },
      [dirProjA]: { hasTrustDialogAccepted: true, remoteControlSpawnMode: 'worktree' }
    }
  }, null, 2));

  const allowlistMerged = claudeLauncher.getProjectAllowlist({ claudeJsonPath: mockClaudeTrustJson });
  const mergedA = allowlistMerged.find((w) => w.path.toLowerCase() === dirProjA.toLowerCase());
  assert(mergedA !== undefined, 'dirProjA debe estar en la lista');
  assert.strictEqual(mergedA.hasTrustDialogAccepted, true, 'Debe fusionar a true si alguna entrada aceptó trust');
  assert.strictEqual(mergedA.spawnMode, 'worktree', 'Debe adoptar el spawnMode explícito');

  const resUntrusted = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirUntrusted,
    allowlistOptions: { claudeJsonPath: mockClaudeTrustJson }
  });
  assert.strictEqual(resUntrusted.success, false);
  assert(resUntrusted.error.includes('Workspace no confiable'), 'Debe reportar workspace no confiable');

  // --- Parte 2: Idempotencia del Spawn (Una sesión por proyecto) ---
  // 2.1 Idempotencia por Bridge State
  state.setActiveClaudeSession({
    pid: process.pid,
    projectPath: dirProjA,
    sessionName: 'Mobile-proj-allowed',
    spawnMode: 'same-dir'
  });

  let duplicateSpawnCalled = false;
  const resBridgeIdempotent = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirProjA,
    allowlistOptions: {
      claudeJsonPath: mockClaudeJson
    },
    spawnFn: () => {
      duplicateSpawnCalled = true;
      return { pid: 88888, unref: () => {}, on: () => {} };
    }
  });

  assert.strictEqual(resBridgeIdempotent.success, true, 'Debe responder success ante sesión existente');
  assert.strictEqual(resBridgeIdempotent.alreadyRunning, true, 'Debe indicar alreadyRunning: true');
  assert.strictEqual(resBridgeIdempotent.source, 'bridge', 'Fuente debe ser bridge');
  assert.strictEqual(resBridgeIdempotent.pid, process.pid, 'Debe retornar el PID existente');
  assert.strictEqual(duplicateSpawnCalled, false, 'No debe disparar spawn repetido si ya está vivo en bridge');

  state.clearActiveClaudeSession();

  // 2.2 Idempotencia por Claude Native Pointer (~/.claude/projects/<slug>/bridge-pointer.json)
  const mockClaudeHome = path.join(dirBase, 'claude-home');
  const slugA = path.resolve(dirProjA).replace(/[^a-zA-Z0-9]/g, '-');
  const pointerDir = path.join(mockClaudeHome, 'projects', slugA);
  fs.mkdirSync(pointerDir, { recursive: true });
  fs.writeFileSync(path.join(pointerDir, 'bridge-pointer.json'), JSON.stringify({
    sessionId: 'session-xyz-123',
    environmentId: 'env_native_456',
    pid: process.pid,
    source: 'standalone'
  }));

  let pointerSpawnCalled = false;
  const resPointerIdempotent = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirProjA,
    allowlistOptions: {
      claudeJsonPath: mockClaudeJson
    },
    findExistingFn: (targetPath) => claudeLauncher.findExistingClaudeSession(targetPath, { claudeHome: mockClaudeHome }),
    spawnFn: () => {
      pointerSpawnCalled = true;
      return { pid: 77777, unref: () => {}, on: () => {} };
    }
  });

  assert.strictEqual(resPointerIdempotent.success, true);
  assert.strictEqual(resPointerIdempotent.alreadyRunning, true);
  assert.strictEqual(resPointerIdempotent.source, 'claude-pointer');
  assert.strictEqual(resPointerIdempotent.environmentId, 'env_native_456');
  assert.strictEqual(pointerSpawnCalled, false, 'No debe disparar spawn si existe bridge-pointer.json vivo');
  assert.strictEqual(state.getActiveClaudeSession()?.pid, process.pid, 'Debe sincronizar la sesión viva en state');

  state.clearActiveClaudeSession();

  // 2.3 Idempotencia por tmux pane
  let tmuxSpawnCalled = false;
  const resTmuxIdempotent = claudeLauncher.launchClaudeRemoteSession({
    workspacePath: dirProjA,
    allowlistOptions: {
      claudeJsonPath: mockClaudeJson
    },
    findExistingFn: () => ({
      pid: process.pid,
      source: 'tmux',
      projectPath: dirProjA
    }),
    spawnFn: () => {
      tmuxSpawnCalled = true;
      return { pid: 66666, unref: () => {}, on: () => {} };
    }
  });

  assert.strictEqual(resTmuxIdempotent.success, true);
  assert.strictEqual(resTmuxIdempotent.alreadyRunning, true);
  assert.strictEqual(resTmuxIdempotent.source, 'tmux');
  assert.strictEqual(tmuxSpawnCalled, false, 'No debe disparar spawn si existe pane en tmux');

  // Limpieza
  state.clearActiveClaudeSession();
  fs.rmSync(dirBase, { recursive: true, force: true });
}
console.log('✔ Test 48 [SEC-006 / BE-010]: Separación estricta de Allowlists e Idempotencia del spawn (una sesión por proyecto)');

// Limpieza: solo el directorio temporal de test
try {
  fs.rmSync(path.dirname(TEST_STATE_FILE), { recursive: true, force: true });
} catch {}

console.log('--- ✅ Todos los tests pasaron exitosamente ---');

