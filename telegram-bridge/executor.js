import { spawn, execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import {
  loadPolicy,
  resolveWorkspace,
  resolveExtraDirs,
  sanitizeEnv,
  redactSecrets
} from './policy.js';

// La política vive en `policy.js` para que `notify.js` pueda leerla sin cargar
// este módulo (ver la cabecera de policy.js). Se reexporta porque `bot.js`, los
// tests y el servidor MCP la importan históricamente desde aquí.
export { loadPolicy, resolveWorkspace, resolveExtraDirs } from './policy.js';

// FEAT-034 — El lector del stream de `agy` es el mismo que usa el fan-out del
// servidor MCP: el acumulador reconstruye la respuesta y `interpretarEvento`
// dice qué herramienta abrió el agente. Ninguno toca el disco al cargarse.
const requireCjs = createRequire(import.meta.url);
const { crearAcumuladorStream } = requireCjs('../mcp-server/agy-stream.js');
const { interpretarEvento } = requireCjs('../mcp-server/fanout-tail.js');

/**
 * Resuelve la ruta del binario agy.exe de Antigravity
 * (Autocontenido: replica la lógica validada del servidor MCP sin dependencias externas)
 */
export function resolveAgyBin() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'agy.exe' : 'agy';

  // 1. Intentar encontrarlo en PATH sin interpolación de shell
  try {
    const finder = isWin ? 'where.exe' : 'which';
    const found = execFileSync(finder, [binName], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim().split(/\r?\n/)[0];

    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {}

  // 2. Intentar ruta predeterminada en Windows LocalAppData
  if (isWin && process.env.LOCALAPPDATA) {
    const localPath = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }

  // 3. Fallback al nombre estándar
  return binName;
}

// Exportado para el cast (FEAT-022): `verificarResuelve` necesita el binario, y
// resolverlo otra vez costaría otro `where.exe` síncrono.
export const AGY_BIN = resolveAgyBin();

// Margen entre la terminación suave y la forzada al abortar una tarea.
const SIGKILL_GRACE_MS = 5000;
// Tope para consultar la versión del binario sin congelar el event loop.
const AGY_VERSION_TIMEOUT_MS = 5000;
// Tamaño de prompt a partir del cual se vuelca a un fichero en vez de pasarlo
// como argumento. Mismo valor que `PROMPT_ARG_LIMIT` del servidor MCP.
const PROMPT_ARG_LIMIT = 24000;

/**
 * Termina el proceso hijo y, en Windows, TODO su árbol de descendientes.
 *
 * Por qué no basta `child.kill()` en Windows: no existen señales POSIX, y libuv
 * traduce tanto SIGTERM como SIGKILL a `TerminateProcess` sobre el manejador de
 * `agy.exe` y solo sobre él. Si `agy` había lanzado `npm test`, un servidor
 * local o un script de Python, esos nietos quedan desvinculados y siguen vivos
 * ocupando puertos, bloqueando ficheros y consumiendo CPU.
 *
 * `taskkill /T` es lo único que recorre el árbol. Se intenta primero sin `/F`
 * —que pide el cierre y permite a un hijo con ventana guardar estado— y solo se
 * fuerza pasado el margen. Ojo con la expectativa: en Windows no hay
 * terminación «suave» real para un proceso de consola, así que en la práctica
 * el que cierra casi siempre es el `/F`; la primera pasada existe para los
 * descendientes que sí saben atender un cierre. Nada de esto retrasa al
 * usuario: `terminate()` no se espera, la promesa de la tarea resuelve enseguida.
 */
function terminateTree(child, { onForce } = {}) {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T'], () => {});
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        onForce?.();
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      }
    }, SIGKILL_GRACE_MS);
    forceTimer.unref?.();
    return forceTimer;
  }

  // POSIX: SIGTERM al grupo si lo hay, y SIGKILL si lo ignora.
  try { child.kill('SIGTERM'); } catch {}
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      onForce?.();
      try { child.kill('SIGKILL'); } catch {}
    }
  }, SIGKILL_GRACE_MS);
  forceTimer.unref?.();
  return forceTimer;
}

/**
 * Si el prompt no cabe cómodamente en un argumento de línea de comandos, lo
 * vuelca a un fichero y deja en su lugar un puntero que le dice a `agy` que lo
 * lea. Portado de `offloadLargePrompt` del servidor MCP.
 *
 * Alcance real: `CreateProcessW` corta en 32.767 caracteres la línea COMPLETA.
 * Un mensaje de Telegram no pasa de 4096, así que por el camino del bot esto no
 * se dispara nunca; existe para los llamantes directos de `runAgyTask` (tests,
 * futuros adjuntos entrantes) y para que el bridge no diverja del MCP.
 *
 * Contrapartida a tener presente: el volcado añade `--add-dir <tmpdir>`, es
 * decir amplía el conjunto de directorios que `agy` puede leer y escribir. Se
 * limita a un directorio recién creado y vacío, y se borra al terminar.
 */
/**
 * Antepone al prompt los guardrails derivados de la política EFECTIVA.
 *
 * Se lee de `policy.*`, no de las constantes por defecto. Antes se inyectaban
 * los defaults mientras `/status` mostraba `policy.*`: lo que el usuario
 * escribía en su `antigravity.json` se anunciaba en el chat pero no llegaba
 * nunca al modelo, que es el único capaz de atenderlo. Como los guardrails son
 * el único mecanismo que existe —aunque solo sea una sugerencia—, esa
 * discrepancia dejaba la configuración sin ningún efecto.
 *
 * Función aparte para poder afirmarlo en un test sin lanzar `agy`.
 */
export function buildGuardrailedPrompt(policy, prompt) {
  return [
    `[SECURITY & PERMISSION GUARDRAILS ENFORCED BY USER POLICY]`,
    `- FORBIDDEN PATHS: ${policy.denyPaths.join(', ')}`,
    `- FORBIDDEN COMMANDS: ${policy.denyCommands.join(', ')}`,
    `If any requested action violates these rules, refuse that specific action and explain the restriction.\n`,
    `[TASK INSTRUCTIONS]`,
    prompt
  ].join('\n');
}

export function offloadLargePrompt(args) {
  const i = args.indexOf('-p');
  if (i === -1 || i + 1 >= args.length) return { args, cleanup: () => {} };

  const prompt = args[i + 1];
  if (typeof prompt !== 'string' || prompt.length <= PROMPT_ARG_LIMIT) {
    return { args, cleanup: () => {} };
  }

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-prompt-'));
    const file = path.join(dir, 'PROMPT.md');
    fs.writeFileSync(file, prompt, 'utf8');

    const puntero = [
      'Your instructions for this task did not fit in a command-line argument,',
      'so they were written to this file:',
      '',
      file,
      '',
      'Read that file COMPLETELY, from the first line to the last, before doing',
      'anything else. Its contents are your prompt: follow them exactly as if',
      'they had been typed here. Do not ask for confirmation and do not stop at',
      'a partial read - produce the final answer the file asks for.'
    ].join('\n');

    const nuevos = [...args];
    nuevos[i + 1] = puntero;
    nuevos.push('--add-dir', dir);

    console.log(`[executor] Prompt de ${prompt.length} caracteres por encima del limite de argumento; volcado a ${file}`);

    return {
      args: nuevos,
      cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    };
  } catch (err) {
    // Si el volcado falla es mejor intentar el spawn igualmente y que sea el
    // sistema quien se queje, en vez de abortar por un fallo de /tmp.
    console.error(`[executor] No se pudo volcar el prompt: ${err.message}. Se intenta el spawn directo.`);
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    return { args, cleanup: () => {} };
  }
}


/**
 * Ejecuta una tarea en Antigravity CLI de forma segura y estructurada
 *
 * @param {Object} options
 * @param {string} options.prompt Tarea o instrucción a ejecutar
 * @param {'plan'|'accept-edits'} [options.mode='accept-edits'] Modo de ejecución
 * @param {string} [options.model] Modelo override (ej. gemini-3.8-flash)
 * @param {'low'|'medium'|'high'} [options.effort='high'] Esfuerzo de razonamiento
 * @param {number} [options.timeoutMinutes=15] Timeout en minutos
 * @param {string} [options.conversationId] ID para continuar conversación multiturno
 * @param {string} [options.cwd] Directorio de trabajo
 * @param {boolean} [options.sandbox] Fuerza (o desactiva) `--sandbox` para esta tarea
 * @param {(cancel: () => boolean) => void} [options.onSpawn] Recibe una función para
 *        abortar esta tarea. Permite implementar /cancel sin exponer el ChildProcess.
 * @param {(texto: string) => void} [options.onActividad] FEAT-034: recibe cada
 *        herramienta que el agente abre («write_to_file → src/a.js»).
 * @param {Function} [options.spawnFn] Solo para los tests: lanza un agy falso.
 */
export function runAgyTask(options = {}) {
  const {
    prompt,
    mode = 'accept-edits',
    model = process.env.AGY_MODEL || null,
    effort = process.env.AGY_EFFORT || 'high',
    timeoutMinutes = parseInt(process.env.AGY_TIMEOUT_MINUTES, 10) || 15,
    conversationId = null,
    cwd = resolveWorkspace(),
    sandbox = undefined,
    onSpawn = null,
    onActividad = null,
    spawnFn = spawn
  } = options;

  const policy = loadPolicy(cwd);
  const useSandbox = sandbox === undefined ? policy.sandbox : Boolean(sandbox);

  // Construcción de argumentos CLI
  const cliArgs = [
    '--print-timeout', `${timeoutMinutes}m`,
    // stream-json y no json (FEAT-034): con json no hay nada que leer hasta el
    // final, y el progreso no podía decir qué estaba haciendo el agente.
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--mode', mode,
    '--effort', effort
  ];

  // Restricciones de terminal, no de rutas: ver el comentario de loadPolicy().
  if (useSandbox) {
    cliArgs.push('--sandbox');
  }

  // Workspace explícito: sin esto `agy` depende del directorio desde el que se
  // lanzó el proceso, y el usuario no tiene forma de saber cuál es.
  cliArgs.push('--add-dir', cwd);
  for (const dir of resolveExtraDirs()) {
    if (dir !== cwd) cliArgs.push('--add-dir', dir);
  }

  if (model) {
    cliArgs.push('--model', model);
  }

  if (conversationId) {
    cliArgs.push('--conversation', conversationId);
  }

  cliArgs.push('-p', buildGuardrailedPrompt(policy, prompt));

  return lanzarAgy(cliArgs, {
    cwd,
    timeoutMinutes,
    conversationId,
    onSpawn,
    formato: 'stream-json',
    onActividad,
    spawnFn,
    descripcion: `modo: ${mode}, sandbox: ${useSandbox ? 'sí' : 'no'}, conv: ${conversationId || 'nueva'}, cwd: ${cwd}`
  });
}

/**
 * FEAT-022 — Ejecuta argumentos ya armados. El cast de un agente persistido los
 * arma en `mcp-server/agents/cast.js` (con `--agent` y `--mode plan`), así que
 * aquí no se añaden guardrails de texto: el `agent.md` es el system prompt, y su
 * allowlist más `--mode plan` son los controles reales.
 *
 * Mismo spawn que `runAgyTask` —entorno saneado, árbol terminable, prompt largo
 * a fichero— y devuelve la forma que espera `castear()`, que es la de
 * `executeAgy` del servidor MCP.
 */
export async function runAgyArgs(cliArgs, {
  cwd = resolveWorkspace(),
  timeoutMinutes = parseInt(process.env.AGY_TIMEOUT_MINUTES, 10) || 15,
  onSpawn = null,
  spawnFn = spawn
} = {}) {
  // Sigue en json: los args los arma cast.js con `--output-format json`, y el
  // cast no muestra actividad (FEAT-034 lo dejó fuera a propósito).
  const r = await lanzarAgy(['--print-timeout', `${timeoutMinutes}m`, ...cliArgs], {
    cwd,
    timeoutMinutes,
    onSpawn,
    spawnFn,
    descripcion: `cast, cwd: ${cwd}`
  });
  return {
    success: Boolean(r.success),
    cancelled: Boolean(r.cancelled),
    data: r.data || null,
    rawOutput: r.rawOutput || r.stdout || '',
    error: r.error || null
  };
}

/**
 * El ciclo de vida del proceso hijo, común a `runAgyTask` y `runAgyArgs`.
 */
function lanzarAgy(cliArgs, {
  cwd,
  timeoutMinutes,
  conversationId = null,
  onSpawn = null,
  descripcion = '',
  formato = 'json',
  onActividad = null,
  spawnFn = spawn
}) {
  const timeoutMs = (timeoutMinutes + 1) * 60 * 1000;
  const { args: finalArgs, cleanup: limpiarPrompt } = offloadLargePrompt(cliArgs);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;

    const terminate = (child) => {
      killTimer = terminateTree(child, {
        onForce: () => console.warn('[executor] El proceso no cerró por las buenas. Forzando el árbol.')
      });
    };

    console.log(`[executor] Ejecutando: ${AGY_BIN} (${descripcion})`);

    const startedAt = Date.now();
    // Entorno saneado: `agy` corre con `--dangerously-skip-permissions` y puede
    // ejecutar comandos, así que heredar `TELEGRAM_BOT_TOKEN` equivale a
    // publicarlo — un `echo` bastaría, y su salida vuelve al chat. Las
    // herramientas salientes no se rompen: `notify.js` lee el `.env` de disco.
    const child = spawnFn(AGY_BIN, finalArgs, {
      cwd,
      shell: false,
      env: sanitizeEnv()
    });

    // FEAT-034 — En stream, cada línea alimenta al acumulador (que al cierre
    // reconstruye lo que antes daba el JSON final) y, si es una herramienta que
    // arranca, se avisa por `onActividad`. `readline` convive con el listener
    // `data` de abajo: los dos reciben los mismos buffers.
    const enStream = formato === 'stream-json';
    const acumulador = enStream ? crearAcumuladorStream() : null;
    let lector = null;
    if (enStream) {
      lector = readline.createInterface({ input: child.stdout, terminal: false });
      lector.on('line', (linea) => {
        acumulador.onLine(linea);
        // Tras cancelar o vencer, el proceso puede seguir escribiendo mientras
        // muere: esas líneas no deben mover el progreso de una tarea cerrada.
        if (settled || typeof onActividad !== 'function') return;
        try {
          const ev = interpretarEvento(linea);
          if (ev && ev.tipo === 'tool') onActividad(ev.texto);
        } catch (err) {
          console.warn(`[executor] onActividad falló: ${redactSecrets(err.message)}`);
        }
      });
    }
    const cerrarLector = () => {
      if (lector) {
        try { lector.close(); } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cerrarLector();
      terminate(child);
      limpiarPrompt();
      resolve({
        success: false,
        error: `La tarea en Antigravity superó el tiempo límite de ${timeoutMinutes} minutos.`,
        conversationId,
        stdout,
        stderr
      });
    }, timeoutMs);

    if (typeof onSpawn === 'function') {
      onSpawn(() => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        cerrarLector();
        terminate(child);
        limpiarPrompt();
        resolve({
          success: false,
          cancelled: true,
          error: 'Tarea cancelada por el usuario.',
          conversationId,
          stdout,
          stderr
        });
        return true;
      });
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // Igual que timeout y cancelación: tras el fallo de spawn, nada más del
      // lector.
      cerrarLector();
      limpiarPrompt();
      resolve({
        success: false,
        error: `Error al iniciar ${AGY_BIN}: ${redactSecrets(err.message)}`,
        conversationId,
        stdout,
        stderr
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      limpiarPrompt();
      if (settled) return;
      settled = true;

      // En stream no hay un JSON final que parsear: se arma el mismo `parsed`
      // desde el acumulador, y todo lo de abajo queda igual. `readline` emite
      // sus últimas líneas antes del `close` del hijo, así que ya está completo.
      let parsed = null;
      let respuestaStream = '';
      let eventosStream = 0;
      if (enStream) {
        const r = acumulador.resultado();
        eventosStream = r.eventos;
        respuestaStream = r.response || '';
        parsed = r.eventos > 0 ? {
          response: r.response,
          conversation_id: r.conversationId,
          duration_seconds: r.durationSeconds,
          usage: r.usage,
          status: r.error ? 'ERROR' : undefined,
          error: r.error || undefined
        } : null;
      } else {
        try {
          parsed = JSON.parse(stdout.trim());
        } catch {}
      }

      const activeConvId = (parsed && parsed.conversation_id) || conversationId || null;
      // Reloj de pared de ESTA tarea. `parsed.duration_seconds` es acumulado de
      // toda la conversación, así que al reanudar una sesión vieja informaba
      // horas para una respuesta de segundos.
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const sessionSeconds = (parsed && parsed.duration_seconds) || 0;

      if (code === 0 && (!parsed || parsed.status !== 'ERROR')) {
        // En stream, `stdout` es NDJSON crudo: jamás se entrega como respuesta.
        const responseText = (parsed && parsed.response)
          || (enStream ? '' : stdout)
          || '(Sin respuesta generada)';
        resolve({
          success: true,
          data: parsed,
          conversationId: activeConvId,
          durationSeconds,
          sessionSeconds,
          responseText,
          rawOutput: stdout
        });
      } else {
        let errorMsg = `Antigravity finalizó con código de error ${code}.`;
        if (parsed && parsed.error) {
          errorMsg = `Error de Antigravity: "${parsed.error}".`;
        } else if (stderr.trim()) {
          errorMsg += `\nDetalles: ${redactSecrets(stderr.trim())}`;
        } else if (stdout.trim()) {
          // Con eventos y texto de respuesta, eso; si `agy` murió antes de
          // emitir NDJSON (o nada fue legible), lo crudo: ahí está el motivo, y
          // sin él el error llegaba al chat sin un solo detalle.
          const salida = enStream && eventosStream > 0 && respuestaStream.trim()
            ? respuestaStream.trim()
            : stdout.trim();
          errorMsg += `\nSalida: ${redactSecrets(salida)}`;
        }

        resolve({
          success: false,
          data: parsed,
          conversationId: activeConvId,
          durationSeconds,
          sessionSeconds,
          error: errorMsg,
          stdout,
          stderr
        });
      }
    });
  });
}

// La versión no cambia entre mensajes, y `execFileSync` sin timeout congela el
// event loop: si el binario tarda o se cuelga, el bot deja de responder al long
// polling. Se cachea y se acota el tiempo.
let versionCache = null;

function getAgyVersion() {
  if (versionCache !== null) return versionCache;

  const opts = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: AGY_VERSION_TIMEOUT_MS };
  let version = 'Desconocida';
  try {
    version = execFileSync(AGY_BIN, ['--version'], opts).trim();
  } catch {
    try {
      version = execFileSync(AGY_BIN, ['help'], opts).split(/\r?\n/)[0].trim();
    } catch {
      // No se cachea el fallo: puede ser transitorio (binario actualizándose).
      return 'Desconocida (no se pudo consultar el binario)';
    }
  }

  versionCache = version;
  return version;
}

/**
 * Consulta la versión e información del ejecutable de Antigravity
 */
export function getAgyStatus(cwd = resolveWorkspace()) {
  const version = getAgyVersion();

  const policy = loadPolicy(cwd);

  return {
    binPath: AGY_BIN,
    version,
    workspaceDir: cwd,
    extraDirs: resolveExtraDirs(),
    denyCommands: policy.denyCommands,
    denyPaths: policy.denyPaths,
    configFile: policy.configFile,
    // Cómo se aplica cada control. `/status` lo usa para no presentar una
    // sugerencia al modelo como si fuese una política del sistema.
    enforcement: {
      // Reales: los impone el CLI.
      sandbox: policy.sandbox,
      skipPermissions: true,
      // Solo sugeridos: viajan en el prompt, nada impide desobedecerlos.
      denyCommands: 'prompt',
      denyPaths: 'prompt'
    }
  };
}
