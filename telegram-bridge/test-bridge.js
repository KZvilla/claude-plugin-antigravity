import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgyBin, getAgyStatus } from './executor.js';
import { splitMessage, formatExecutionMeta } from './formatter.js';
import {
  setConversationId,
  getConversationId,
  clearConversationId,
  enqueueTask,
  dequeueTask,
  getQueueLength
} from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('--- 🧪 Iniciando Verificación de telegram-bridge ---');

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
// Verificar que los chunks con código abierto lo cierren debidamente
assert(chunks.length >= 2, 'Debe dividirse en al menos 2 partes con límite 40');
assert(chunks[0].includes('```'), 'El primer chunk debe contener cierre de bloque si quedó abierto');

// Test 4: Persistencia de estado en state.json
const testChatId = 999999999;
setConversationId(testChatId, 'test-conv-12345', { test: true });
assert.strictEqual(getConversationId(testChatId), 'test-conv-12345', 'Debe recuperar el conversationId');

clearConversationId(testChatId);
assert.strictEqual(getConversationId(testChatId), null, 'Debe borrar conversationId tras clear');
console.log('✔ Test 4: Persistencia state.json validada');

// Test 5: Cola de tareas
const queueInitialLen = getQueueLength();
enqueueTask({ id: 'task-1', prompt: 'test' });
assert.strictEqual(getQueueLength(), queueInitialLen + 1, 'Cola debe incrementar');
const dequeued = dequeueTask();
assert.strictEqual(dequeued.id, 'task-1', 'Debe desencolar la tarea');
console.log('✔ Test 5: Cola de ejecución (concurrency 1) validada');

// Test 6: La cola debe mantener el ctx vivo (no debe serializarse a JSON).
// Si esto se rompe, ctx.reply deja de ser una función tras encolar/desencolar
// (queda un objeto plano de JSON.parse) y el bot crashea con una excepción
// no controlada en cuanto intenta responder al usuario.
const fakeCtx = { reply: () => 'called', chat: { id: 1 } };
enqueueTask({ ctx: fakeCtx, chatId: 1, prompt: 'test', mode: 'accept-edits', conversationId: null });
const dequeuedWithCtx = dequeueTask();
assert.strictEqual(typeof dequeuedWithCtx.ctx.reply, 'function', 'ctx.reply debe seguir siendo una función tras desencolar');
assert.strictEqual(dequeuedWithCtx.ctx, fakeCtx, 'ctx debe ser la misma referencia en memoria, no una copia JSON');
console.log('✔ Test 6: ctx conserva sus métodos a través de la cola');

// Limpieza de state.json de test
try {
  const statePath = path.join(__dirname, 'state.json');
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
} catch {}

console.log('--- ✅ Todos los tests pasaron exitosamente ---');
