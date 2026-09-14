/**
 * BE-023 — The cwd explicitly requested for agy_run must frame every
 * run_command as well as the spawned agy process. This remains prompt guidance,
 * not a claim of filesystem confinement or observation of the inner tool.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

function promptOf(call) {
  const i = call.args.indexOf('-p');
  return i >= 0 ? call.args[i + 1] : '';
}

function responseText(response) {
  return (((response.result || {}).content || [])[0] || {}).text || '';
}

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cwd-'));
  const capture = path.join(fixture, 'capture.jsonl');
  fs.writeFileSync(capture, '');

  // Relative on purpose: the server must resolve it once against its cwd.
  // `$&` catches accidental String.replace interpolation.
  const relativeCwd = 'project-$& with spaces';
  const expectedCwd = path.resolve(fixture, relativeCwd);
  fs.mkdirSync(expectedCwd, { recursive: true });

  const task = 'ORIGINAL_TASK_$&\nKeep this text byte-for-byte.';
  const server = startServer({ cwd: fixture, captureFile: capture });

  let withCwd;
  let withoutCwd;
  try {
    await server.initialize();
    withCwd = await server.callTool('agy_run', {
      prompt: task,
      cwd: relativeCwd,
      conversation_id: 'cwd-thread',
      permissions: {
        allow: ['read', 'commands'],
        deny: ['edit', 'network'],
        deny_paths: ['secret/**'],
        deny_commands: ['git push*'],
        sandbox: false
      }
    });
    withoutCwd = await server.callTool('agy_run', {
      prompt: 'NO_CWD_TASK',
      permissions: {
        allow: ['read', 'edit', 'commands', 'network'],
        deny: [],
        deny_paths: [],
        deny_commands: [],
        sandbox: false
      }
    });
  } finally {
    await server.stop();
  }

  const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const explicitCall = calls[0] || { args: [] };
  const implicitCall = calls[1] || { args: [] };
  const explicitPrompt = promptOf(explicitCall);
  const implicitPrompt = promptOf(implicitCall);
  const explicitOutput = responseText(withCwd || {});
  const implicitOutput = responseText(withoutCwd || {});
  const encodedCwd = JSON.stringify(expectedCwd);

  await group('cwd explícito: un solo valor normalizado para proceso y prompt', () => {
    check('dos llamadas capturadas', calls.length === 2, `capturadas: ${calls.length}`);
    check('spawn.cwd es la ruta absoluta esperada', explicitCall.cwd === expectedCwd,
      `esperado ${expectedCwd}, recibido ${explicitCall.cwd}`);
    check('el prompt contiene la misma ruta codificada', explicitPrompt.includes(encodedCwd), explicitPrompt.slice(0, 500));
    check('encuadra Cwd de run_command', /When using run_command, pass .* as its Cwd by default/.test(explicitPrompt));
    check('permite un subdirectorio', explicitPrompt.includes('use a subdirectory of it'));
    check('prohíbe anteponer cd', explicitPrompt.includes('Do not prepend cd to CommandLine'));
    check('no transforma el comando con cd', !explicitPrompt.includes(`cd ${expectedCwd}`));
    check('conserva la tarea original intacta', explicitPrompt.endsWith(task));
    check('conserva --conversation', explicitCall.args.includes('--conversation')
      && explicitCall.args[explicitCall.args.indexOf('--conversation') + 1] === 'cwd-thread');
  });

  await group('precedencia de seguridad y salida honesta', () => {
    const security = explicitPrompt.indexOf('[SECURITY & PERMISSION GUARDRAILS ENFORCED BY USER POLICY]');
    const taskMarker = explicitPrompt.indexOf('[TASK INSTRUCTIONS]');
    const project = explicitPrompt.indexOf('[PROJECT WORKING DIRECTORY');
    const original = explicitPrompt.indexOf(task);
    check('seguridad aparece primero', security === 0);
    check('contexto queda dentro de TASK INSTRUCTIONS', security < taskMarker && taskMarker < project && project < original);
    check('deny_paths se conserva', explicitPrompt.includes('secret/**'));
    check('deny_commands se conserva', explicitPrompt.includes('git push*'));
    check('salida informa el directorio solicitado', explicitOutput.includes(`Requested Working Directory: ${encodedCwd}`));
    const requestedLine = explicitOutput.split(/\r?\n/).find(line => line.includes('Requested Working Directory')) || '';
    check('no lo llama real, efectivo ni verificado', !/(actual|effective|verified|real|efectiv|verificad)/i.test(requestedLine), requestedLine);
  });

  await group('cwd omitido: conserva el fallback sin inventar una elección', () => {
    check('spawn conserva process.cwd como fallback', implicitCall.cwd === fixture,
      `esperado ${fixture}, recibido ${implicitCall.cwd}`);
    check('no inyecta contexto de proyecto', !implicitPrompt.includes('PROJECT WORKING DIRECTORY'));
    check('la tarea queda sola cuando no hay guardarraíles', implicitPrompt === 'NO_CWD_TASK', implicitPrompt);
    check('no imprime Requested Working Directory', !implicitOutput.includes('Requested Working Directory'));
  });

  removeFixture(fixture);
  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
