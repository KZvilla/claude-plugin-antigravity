import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

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

const AGY_BIN = resolveAgyBin();

// ==============================================================================
// Política de permisos
// ==============================================================================
//
// IMPORTANTE — qué se aplica de verdad y qué no:
//
//   `agy --help` (v1.1.22) NO expone ningún flag de política por ruta ni por
//   comando. Los únicos controles reales del CLI son `--sandbox` (restricciones
//   de terminal) y `--mode plan` (sesión de solo lectura). `deny_paths` y
//   `deny_commands` se inyectan como texto delante del prompt: son una
//   instrucción al modelo, no un control que el sistema pueda hacer cumplir.
//
// Se conservan porque reducen el riesgo en la práctica y porque mantienen la
// paridad con el servidor MCP, pero `getAgyStatus()` los marca como
// «sugeridos» para que `/status` no prometa una protección que no existe.

const DEFAULT_DENY_COMMANDS = ['git push*', 'git reset --hard*', 'npm publish*', 'rm -rf /*'];
const DEFAULT_DENY_PATHS = ['.env*', '**/*.key', '**/*.pem'];

// Margen entre SIGTERM y SIGKILL al abortar una tarea.
const SIGKILL_GRACE_MS = 5000;
// Tope para consultar la versión del binario sin congelar el event loop.
const AGY_VERSION_TIMEOUT_MS = 5000;

/**
 * Directorio de trabajo de las tareas. Fuente única de verdad: `bot.js` lo usa
 * para el banner y el executor para lanzar `agy`, que antes discrepaban — el
 * banner resolvía la raíz del repo y el executor usaba `process.cwd()`, que con
 * `npm --prefix telegram-bridge start` es la carpeta del bridge.
 */
export function resolveWorkspace() {
  return path.resolve(process.env.WORKSPACE_DIR || process.cwd());
}

/**
 * Directorios extra que `agy` puede leer y escribir, de `AGY_ADD_DIRS`.
 * Permite acotar `WORKSPACE_DIR` a un sandbox y abrir un repo concreto solo
 * cuando hace falta, en lugar de ampliar el workspace entero.
 */
export function resolveExtraDirs() {
  return (process.env.AGY_ADD_DIRS || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * Carga la política efectiva con la misma precedencia que el servidor MCP:
 * defaults < ~/.claude/antigravity.json < <cwd>/.claude/antigravity.json < entorno.
 * Así el bridge y el MCP no divergen cuando el usuario ajusta su política.
 */
export function loadPolicy(cwd = resolveWorkspace()) {
  const policy = {
    denyCommands: [...DEFAULT_DENY_COMMANDS],
    denyPaths: [...DEFAULT_DENY_PATHS],
    sandbox: false,
    configFile: null
  };

  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidates = [
    homeDir ? path.join(homeDir, '.claude', 'antigravity.json') : null,
    path.join(cwd, '.claude', 'antigravity.json')
  ].filter(Boolean);

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const perms = JSON.parse(fs.readFileSync(file, 'utf8')).permissions;
      if (!perms) continue;
      if (Array.isArray(perms.deny_commands)) policy.denyCommands = perms.deny_commands;
      if (Array.isArray(perms.deny_paths)) policy.denyPaths = perms.deny_paths;
      if (perms.sandbox !== undefined) policy.sandbox = Boolean(perms.sandbox);
      policy.configFile = file;
    } catch (err) {
      console.error(`[executor] No se pudo leer ${file}: ${err.message}. Se ignora.`);
    }
  }

  // El entorno gana: permite endurecer el bridge sin tocar la política del MCP.
  policy.sandbox = parseBool(process.env.AGY_SANDBOX, policy.sandbox);

  return policy;
}

/**
 * Ejecuta una tarea en Antigravity CLI de forma segura y estructurada
 *
 * @param {Object} options
 * @param {string} options.prompt Tarea o instrucción a ejecutar
 * @param {'plan'|'accept-edits'} [options.mode='accept-edits'] Modo de ejecución
 * @param {string} [options.model] Modelo override (ej. gemini-3.7-flash)
 * @param {'low'|'medium'|'high'} [options.effort='high'] Esfuerzo de razonamiento
 * @param {number} [options.timeoutMinutes=15] Timeout en minutos
 * @param {string} [options.conversationId] ID para continuar conversación multiturno
 * @param {string} [options.cwd] Directorio de trabajo
 * @param {boolean} [options.sandbox] Fuerza (o desactiva) `--sandbox` para esta tarea
 * @param {(cancel: () => boolean) => void} [options.onSpawn] Recibe una función para
 *        abortar esta tarea. Permite implementar /cancel sin exponer el ChildProcess.
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
    onSpawn = null
  } = options;

  const policy = loadPolicy(cwd);
  const useSandbox = sandbox === undefined ? policy.sandbox : Boolean(sandbox);
  const timeoutMs = (timeoutMinutes + 1) * 60 * 1000;

  // Construcción de argumentos CLI
  const cliArgs = [
    '--print-timeout', `${timeoutMinutes}m`,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--mode', mode,
    '--effort', effort
  ];

  // Único control de permisos real que ofrece el CLI, además de `--mode plan`.
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

  // Inyección de guardrails de seguridad por política
  const securityGuardrails = [
    `[SECURITY & PERMISSION GUARDRAILS ENFORCED BY USER POLICY]`,
    `- FORBIDDEN PATHS: ${DEFAULT_DENY_PATHS.join(', ')}`,
    `- FORBIDDEN COMMANDS: ${DEFAULT_DENY_COMMANDS.join(', ')}`,
    `If any requested action violates these rules, refuse that specific action and explain the restriction.\n`,
    `[TASK INSTRUCTIONS]`,
    prompt
  ].join('\n');

  cliArgs.push('-p', securityGuardrails);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;

    /**
     * SIGTERM y, si el hijo lo ignora, SIGKILL. Antes solo se enviaba SIGTERM y
     * se resolvía la promesa de inmediato, dejando posiblemente un agy.exe
     * huérfano consumiendo cuota y CPU.
     */
    const terminate = (child) => {
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          console.warn('[executor] El proceso ignoró SIGTERM. Enviando SIGKILL.');
          try { child.kill('SIGKILL'); } catch {}
        }
      }, SIGKILL_GRACE_MS);
      killTimer.unref?.();
    };

    console.log(`[executor] Ejecutando: ${AGY_BIN} (modo: ${mode}, sandbox: ${useSandbox ? 'sí' : 'no'}, conv: ${conversationId || 'nueva'}, cwd: ${cwd})`);

    const startedAt = Date.now();
    const child = spawn(AGY_BIN, cliArgs, {
      cwd,
      shell: false,
      env: { ...process.env }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminate(child);
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
        terminate(child);
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
      resolve({
        success: false,
        error: `Error al iniciar ${AGY_BIN}: ${err.message}`,
        conversationId,
        stdout,
        stderr
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;

      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {}

      const activeConvId = (parsed && parsed.conversation_id) || conversationId || null;
      // Reloj de pared de ESTA tarea. `parsed.duration_seconds` es acumulado de
      // toda la conversación, así que al reanudar una sesión vieja informaba
      // horas para una respuesta de segundos.
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const sessionSeconds = (parsed && parsed.duration_seconds) || 0;

      if (code === 0 && (!parsed || parsed.status !== 'ERROR')) {
        const responseText = (parsed && parsed.response) || stdout || '(Sin respuesta generada)';
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
          errorMsg += `\nDetalles: ${stderr.trim()}`;
        } else if (stdout.trim()) {
          errorMsg += `\nSalida: ${stdout.trim()}`;
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
