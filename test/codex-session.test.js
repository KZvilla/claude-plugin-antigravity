#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordCodexSession, resolveSessionSource } = require('../mcp-server/session-source.js');
const { preprocessSessionLog } = require('../mcp-server/session-log.js');
const { extractLastCheckpoint } = require('../mcp-server/checkpoint.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function writeTranscript(filePath, sessionId, cwd) {
  const changed = path.join(cwd, 'src', 'feature.js');
  const rows = [
    { timestamp: '2026-09-13T20:00:00Z', type: 'session_meta', payload: { session_id: sessionId, cwd, cli_version: '0.154.0', git: { branch: 'feat/codex' } } },
    { timestamp: '2026-09-13T20:00:01Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Implement the Codex adapter' }] } } },
    { timestamp: '2026-09-13T20:00:02Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: { [changed]: { type: 'update' } } } } },
    {
      timestamp: '2026-09-13T20:00:03Z', type: 'event_msg',
      payload: { type: 'item_completed', item: {
        type: 'CommandExecution', status: 'completed', exit_code: 0, cwd,
        command: ['npm', 'test'], parsed_cmd: [{ type: 'unknown', cmd: 'npm test' }],
        stdout: '20 tests passed', stderr: '', aggregated_output: '20 tests passed'
      } }
    },
    { timestamp: '2026-09-13T20:00:04Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Adapter implemented and verified.' }] } } }
  ];
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return changed;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lagrange-codex-session-'));
const cwd = path.join(root, 'workspace with spaces');
const data = path.join(root, 'plugin data');
fs.mkdirSync(cwd, { recursive: true });
const env = { PLUGIN_ROOT: path.resolve(__dirname, '..'), PLUGIN_DATA: data, USERPROFILE: root };
const firstId = '01a09d5e-27b0-7cc0-a003-832256d964bc';
const firstLog = path.join(root, `${firstId}.jsonl`);
const changed = writeTranscript(firstLog, firstId, cwd);

console.log('\npuntero Codex e identidad fail-closed');
recordCodexSession({ hook_event_name: 'SessionStart', source: 'startup', session_id: firstId, transcript_path: firstLog, cwd }, env);
let source = resolveSessionSource({ cwd, env });
check('una sesión activa se resuelve sin heurística temporal', source.host === 'codex' && source.sessionId === firstId, JSON.stringify(source));
check('la ruta con espacios se conserva', source.filePath === firstLog, source.filePath);
source = resolveSessionSource({ cwd, sessionId: '../escape', env });
check('session_id con traversal se rechaza', /Invalid session_id/.test(source.error || ''), JSON.stringify(source));

console.log('\nadaptador Codex a los extractores existentes');
const processed = preprocessSessionLog(firstLog);
check('identifica host y versión Codex', processed.sessionMeta.host === 'codex' && /0\.154\.0/.test(processed.sessionMeta.version || ''), JSON.stringify(processed.sessionMeta));
check('conserva mensajes de usuario y asistente', /Implement the Codex adapter/.test(processed.transcript) && /Adapter implemented/.test(processed.transcript));
check('deriva archivo modificado', processed.facts.modifiedFiles.includes(changed), JSON.stringify(processed.facts));
check('deriva comando de tests', processed.facts.executedCommands.includes('npm test'), JSON.stringify(processed.facts));
const checkpoint = extractLastCheckpoint(firstLog);
check('checkpoint conserva el objetivo', checkpoint.userGoal === 'Implement the Codex adapter', checkpoint.userGoal);
check('checkpoint conserva el archivo', checkpoint.filesModified.includes(changed), JSON.stringify(checkpoint));
check('checkpoint verifica tests verdes', checkpoint.overallTestStatus === 'PASSED', JSON.stringify(checkpoint));

console.log('\nconcurrencia y cierre de sesión');
const secondId = '01a09d5f-1111-7222-8333-444455556666';
const secondLog = path.join(root, `${secondId}.jsonl`);
writeTranscript(secondLog, secondId, cwd);
recordCodexSession({ hook_event_name: 'SessionStart', source: 'startup', session_id: secondId, transcript_path: secondLog, cwd }, env);
source = resolveSessionSource({ cwd, env });
check('dos sesiones activas fallan como ambiguas', source.ambiguous === true && source.error.includes(firstId) && source.error.includes(secondId), JSON.stringify(source));
recordCodexSession({ hook_event_name: 'SessionEnd', session_id: secondId, transcript_path: secondLog, cwd }, env);
source = resolveSessionSource({ cwd, env });
check('SessionEnd elimina la ambigüedad sin borrar historial', source.sessionId === firstId, JSON.stringify(source));
source = resolveSessionSource({ cwd, sessionId: secondId, env });
check('una sesión cerrada sigue accesible por ID', source.sessionId === secondId, JSON.stringify(source));

console.log('\nausencia de hook confiable');
const emptyEnv = { PLUGIN_ROOT: env.PLUGIN_ROOT, PLUGIN_DATA: path.join(root, 'empty data'), USERPROFILE: root };
source = resolveSessionSource({ cwd, env: emptyEnv });
check('Codex no cae silenciosamente en el último log Claude', source.codex === true && /trust/.test(source.error || ''), JSON.stringify(source));
const skipped = recordCodexSession({ session_id: firstId, transcript_path: firstLog, cwd }, { PLUGIN_DATA: data });
check('el hook es no-op fuera de Codex', skipped.skipped === true, JSON.stringify(skipped));

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
