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

const { resolveAgyBin, getAgyStatus, loadPolicy } = await import('./executor.js');
const { splitMessage } = await import('./formatter.js');
const state = await import('./state.js');
const queue = await import('./queue.js');
const { Api, Context } = await import('grammy');

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

// Test 3: Formateador y división de mensajes
const shortText = 'Hola mundo!';
assert.strictEqual(splitMessage(shortText, 50).length, 1, 'Texto corto no se divide');

const textWithCode = 'Inicio del mensaje\n```javascript\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\nFinal';
const chunks = splitMessage(textWithCode, 40);
console.log(`✔ Test 3: splitMessage dividió texto en ${chunks.length} partes`);
assert(chunks.length >= 2, 'Debe dividirse en al menos 2 partes con límite 40');
assert(chunks[0].includes('```'), 'El primer chunk debe contener cierre de bloque si quedó abierto');

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
console.log('✔ Test 9: loadPolicy() respeta fichero y entorno');

// Test 10: getAgyStatus distingue lo que se aplica de lo que solo se sugiere.
// Es lo que impide que /status vuelva a prometer una protección inexistente.
assert.strictEqual(status.enforcement.denyCommands, 'prompt', 'deny_commands solo se sugiere al modelo');
assert.strictEqual(status.enforcement.denyPaths, 'prompt', 'deny_paths solo se sugiere al modelo');
assert.strictEqual(typeof status.enforcement.sandbox, 'boolean', 'sandbox es un control real, booleano');
assert.strictEqual(status.enforcement.skipPermissions, true, 'el bridge siempre auto-aprueba herramientas');
console.log('✔ Test 10: getAgyStatus() declara qué se aplica y qué solo se sugiere');

// Limpieza: solo el directorio temporal de test
try {
  fs.rmSync(path.dirname(TEST_STATE_FILE), { recursive: true, force: true });
} catch {}

console.log('--- ✅ Todos los tests pasaron exitosamente ---');
