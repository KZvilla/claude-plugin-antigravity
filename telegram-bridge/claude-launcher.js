import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { sanitizeEnv, isPathDenied } from './policy.js';
import {
  getActiveClaudeSession,
  setActiveClaudeSession,
  clearActiveClaudeSession
} from './state.js';

export {
  getActiveClaudeSession,
  setActiveClaudeSession,
  clearActiveClaudeSession
};

/**
 * Resuelve la ruta canónica del archivo .claude.json en el perfil del usuario.
 * Permite inyectar una ruta personalizada para entornos de prueba.
 *
 * @param {string|null} [customPath]
 * @returns {string}
 */
export function resolveClaudeJsonPath(customPath = null) {
  if (customPath) return customPath;
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude.json');
}

/**
 * Resuelve el ejecutable de Claude Code en el sistema de manera segura y sin shell.
 * Prioriza PATH y ubicaciones estándar conocidas en Windows y POSIX.
 *
 * @returns {string} Ruta absoluta al ejecutable o nombre del comando fallback.
 */
export function resolveClaudeBin() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'claude.exe' : 'claude';

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

  // 2. Ubicaciones estándar habituales en Windows
  if (isWin) {
    const userProfile = process.env.USERPROFILE || os.homedir();
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;

    const candidatos = [
      path.join(userProfile, '.local', 'bin', 'claude.exe'),
      localAppData ? path.join(localAppData, 'Programs', 'Claude', 'claude.exe') : null,
      appData ? path.join(appData, 'npm', 'claude.cmd') : null,
      path.join(userProfile, '.local', 'bin', 'claude')
    ].filter(Boolean);

    for (const cand of candidatos) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
  }

  // 3. Fallback al nombre estándar
  return binName;
}

/**
 * Comprueba si un PID numérico corresponde a un proceso vivo en ejecución.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parsea el conjunto de workspaces explícitamente permitidos desde variables de entorno.
 * Soporta ALLOWED_CLAUDE_WORKSPACES o ALLOWED_WORKSPACES (separados por coma).
 * Si no está definido, retorna null (permitiendo todos los proyectos válidos no denegados).
 *
 * @param {Object} [env]
 * @returns {Set<string>|null}
 */
export function parseAllowedWorkspacesEnv(env = process.env) {
  const raw = env.ALLOWED_CLAUDE_WORKSPACES || env.ALLOWED_WORKSPACES || '';
  if (!raw.trim()) return null;
  const items = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

/**
 * Comprueba si existe un panel de tmux en ejecución asociado a una ruta física dada
 * que esté corriendo una instancia de Claude Code.
 *
 * @param {string} projectPath
 * @param {Function} [execFileSyncFn]
 * @returns {{ pid: number, source: string, projectPath: string }|null}
 */
export function checkTmuxSession(projectPath, execFileSyncFn = execFileSync) {
  try {
    const output = execFileSyncFn('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #{pane_current_path} #{pane_current_command}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const normalizedTarget = path.resolve(projectPath).toLowerCase();
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(' ');
      if (parts.length >= 3) {
        const panePid = parseInt(parts[0], 10);
        const panePath = parts[1];
        const cmd = parts.slice(2).join(' ');
        if (path.resolve(panePath).toLowerCase() === normalizedTarget && /claude/i.test(cmd)) {
          return { pid: panePid, source: 'tmux', projectPath: panePath };
        }
      }
    }
  } catch {
    // tmux no está instalado o no hay servidor activo
  }
  return null;
}

/**
 * Busca de forma no invasiva si ya existe una sesión activa de Claude Remote Control
 * para un proyecto dado en cualquiera de las fuentes posibles:
 * 1. Estado activo del bridge (`state.json`).
 * 2. Puntero oficial persistido por Claude Code (`~/.claude/projects/<slug>/bridge-pointer.json`).
 * 3. Paneles de tmux ejecutando Claude en ese directorio.
 *
 * Garantiza idempotencia: una única sesión por proyecto.
 *
 * @param {string} projectPath Ruta física al proyecto
 * @param {Object} [options]
 * @param {string} [options.claudeHome] Ruta al directorio ~/.claude
 * @param {Function} [options.isPidAliveFn] Comprobador de vida de PID
 * @param {Function} [options.tmuxCheckerFn] Comprobador de tmux
 * @returns {{ pid: number, source: string, sessionId?: string, environmentId?: string, sessionName?: string, projectPath: string, spawnMode?: string }|null}
 */
export function findExistingClaudeSession(projectPath, {
  claudeHome = path.join(os.homedir(), '.claude'),
  isPidAliveFn = isPidAlive,
  tmuxCheckerFn = checkTmuxSession
} = {}) {
  if (!projectPath || typeof projectPath !== 'string') return null;

  const normalizedTarget = path.resolve(projectPath);
  const isWin = process.platform === 'win32';
  const targetKey = isWin ? normalizedTarget.toLowerCase() : normalizedTarget;

  // 1. Estado registrado en el bridge
  const active = getActiveClaudeSession();
  if (active && active.pid) {
    const activeKey = isWin ? path.resolve(active.projectPath).toLowerCase() : path.resolve(active.projectPath);
    if (activeKey === targetKey && isPidAliveFn(active.pid)) {
      return {
        pid: active.pid,
        source: 'bridge',
        sessionName: active.sessionName,
        projectPath: active.projectPath,
        spawnMode: active.spawnMode
      };
    }
  }

  // 2. Puntero oficial bridge-pointer.json de Claude Code en ~/.claude/projects/
  const possibleSlugs = [
    normalizedTarget.replace(/[^a-zA-Z0-9]/g, '-'),
    normalizedTarget.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-')
  ];

  for (const slug of possibleSlugs) {
    const pointerPath = path.join(claudeHome, 'projects', slug, 'bridge-pointer.json');
    if (fs.existsSync(pointerPath)) {
      try {
        const raw = fs.readFileSync(pointerPath, 'utf8');
        const data = JSON.parse(raw);
        if (data.pid && isPidAliveFn(data.pid)) {
          return {
            pid: data.pid,
            source: 'claude-pointer',
            sessionId: data.sessionId,
            environmentId: data.environmentId,
            projectPath: normalizedTarget
          };
        }
      } catch {}
    }
  }

  // 3. Comprobación en tmux
  try {
    const tmuxSession = tmuxCheckerFn(normalizedTarget);
    if (tmuxSession && isPidAliveFn(tmuxSession.pid)) {
      return tmuxSession;
    }
  } catch {}

  return null;
}

/**
 * Lee de forma estrictamente segura y de solo lectura la Project Allowlist
 * (lista cerrada de workspaces autorizados).
 *
 * Invariantes de seguridad:
 * 1. NUNCA abre archivos en modo de escritura ni altera la configuración.
 * 2. Aplica filtro de rutas prohibidas de política (`isPathDenied`).
 * 3. Si se define ALLOWED_CLAUDE_WORKSPACES en el entorno, acota la lista solo a ellos.
 * 4. Descarta rutas inexistentes, WSL y duplicados de casing.
 *
 * @param {Object} [options]
 * @param {string} [options.claudeJsonPath] Ruta alternativa a .claude.json
 * @param {(p: string) => boolean} [options.existsFn] Verificador de existencia
 * @param {Set<string>|null} [options.allowedWorkspacesSet] Filtro explícito de allowlist
 * @param {string[]} [options.denyPaths] Patrones de exclusión
 * @returns {Array<{ id: string, numericId: number, path: string, name: string, displayName: string, spawnMode: string }>}
 */
export function getProjectAllowlist({
  claudeJsonPath = resolveClaudeJsonPath(),
  existsFn = (p) => fs.existsSync(p),
  allowedWorkspacesSet = parseAllowedWorkspacesEnv(),
  denyPaths = null
} = {}) {
  let rawContent;
  try {
    if (!existsFn(claudeJsonPath)) {
      return [];
    }
    rawContent = fs.readFileSync(claudeJsonPath, 'utf8');
  } catch (err) {
    console.warn(`[claude-launcher] No se pudo leer .claude.json en ${claudeJsonPath}: ${err.message}`);
    return [];
  }

  let data;
  try {
    data = JSON.parse(rawContent);
  } catch (err) {
    console.warn(`[claude-launcher] Formato JSON inválido en ${claudeJsonPath}: ${err.message}`);
    return [];
  }

  const rawProjects = data?.projects;
  if (!rawProjects || typeof rawProjects !== 'object' || Array.isArray(rawProjects)) {
    return [];
  }

  const isWin = process.platform === 'win32';
  const seenPaths = new Set();
  const validWorkspaces = [];

  for (const rawPath of Object.keys(rawProjects)) {
    if (!rawPath || typeof rawPath !== 'string') continue;

    const trimmed = rawPath.trim();
    if (!trimmed) continue;

    // Descartar rutas WSL en runtime nativo Win32
    if (trimmed.startsWith('wsl:') || trimmed.startsWith('wsl.localhost')) {
      continue;
    }

    // Normalizar a ruta completa canónica
    const normalized = path.resolve(path.normalize(trimmed));

    // Deduplicación insensible a mayúsculas en Windows
    const dedupKey = isWin ? normalized.toLowerCase() : normalized;
    if (seenPaths.has(dedupKey)) {
      continue;
    }

    // Comprobar existencia física en disco
    try {
      if (!existsFn(normalized)) {
        continue;
      }
    } catch {
      continue;
    }

    // Comprobar políticas de rutas prohibidas (deny_paths)
    try {
      if (isPathDenied(normalized, denyPaths)) {
        continue;
      }
    } catch {}

    // Si hay una allowlist explícita en el entorno, validar pertenencia
    if (allowedWorkspacesSet) {
      const baseName = path.basename(normalized).toLowerCase();
      const normLower = normalized.toLowerCase();
      const isAllowed = allowedWorkspacesSet.has(normLower) ||
        allowedWorkspacesSet.has(baseName) ||
        allowedWorkspacesSet.has(trimmed.toLowerCase());
      if (!isAllowed) {
        continue;
      }
    }

    seenPaths.add(dedupKey);

    const projectConfig = (rawProjects[rawPath] && typeof rawProjects[rawPath] === 'object')
      ? rawProjects[rawPath]
      : {};
    const spawnMode = projectConfig.remoteControlSpawnMode || 'same-dir';

    const base = path.basename(normalized) || normalized;
    validWorkspaces.push({
      path: normalized,
      name: base,
      parent: path.basename(path.dirname(normalized)) || '',
      spawnMode
    });
  }

  // Contar frecuencias del nombre base para desambiguar displayName si hay colisiones
  const nameCounts = new Map();
  for (const ws of validWorkspaces) {
    nameCounts.set(ws.name, (nameCounts.get(ws.name) || 0) + 1);
  }

  return validWorkspaces.map((ws, index) => {
    const hasCollision = (nameCounts.get(ws.name) || 0) > 1;
    const displayName = hasCollision && ws.parent
      ? `${ws.name} (${ws.parent})`
      : ws.name;

    // F-05: Generar un ID determinista y compacto (8 chars hex) derivado de la ruta normalizada
    const hashId = crypto.createHash('sha256').update(ws.path.toLowerCase()).digest('hex').slice(0, 8);

    return {
      id: hashId,
      numericId: index,
      path: ws.path,
      name: ws.name,
      displayName,
      spawnMode: ws.spawnMode
    };
  });
}

/**
 * Alias de compatibilidad retroactiva para getProjectAllowlist.
 *
 * @param {Object} [options]
 * @returns {Array<{ id: string, numericId: number, path: string, name: string, displayName: string, spawnMode: string }>}
 */
export function getKnownWorkspaces(options) {
  return getProjectAllowlist(options);
}

/**
 * Valida si una ruta física dada pertenece a la Project Allowlist.
 *
 * @param {string} workspacePath Ruta a validar
 * @param {Object} [options] Opciones de allowlist
 * @returns {boolean}
 */
export function isWorkspaceAllowed(workspacePath, options = {}) {
  if (!workspacePath || typeof workspacePath !== 'string') return false;
  const allowlist = getProjectAllowlist(options);
  const isWin = process.platform === 'win32';
  const target = isWin ? path.resolve(workspacePath).toLowerCase() : path.resolve(workspacePath);
  return allowlist.some((ws) => (isWin ? ws.path.toLowerCase() : ws.path) === target);
}

/**
 * Inicia una sesión desacoplada de Claude Code en modo control remoto (remote-control).
 * Valida la existencia del workspace, verifica que pertenezca a la Project Allowlist,
 * aplica control de idempotencia (no spawnea si ya hay una sesión viva para el proyecto),
 * sanea el entorno para no heredar secretos de Telegram y persiste el PID atómicamente.
 *
 * @param {Object} options
 * @param {string} options.workspacePath Ruta física al proyecto
 * @param {string} [options.sessionName] Nombre para la sesión remota (default: Mobile-<basename>)
 * @param {string} [options.spawnMode] Modo de spawn: same-dir o worktree (default: same-dir)
 * @param {string} [options.claudeBin] Ruta al binario de Claude (default: resolveClaudeBin())
 * @param {Function} [options.spawnFn] Función de spawn inyectable para testing (default: spawn)
 * @param {boolean} [options.replaceActive] Detiene la sesión previa de OTRO proyecto si existía (default: false)
 * @param {Object} [options.stopOptions] Opciones inyectables para stopClaudeRemoteSession (testing)
 * @param {Object} [options.allowlistOptions] Opciones inyectables para getProjectAllowlist
 * @param {boolean} [options.skipAllowlistCheck] Omite la verificación de allowlist (testing)
 * @param {Function} [options.findExistingFn] Comprobador inyectable de sesiones existentes (testing)
 * @returns {{ success: boolean, pid?: number, sessionName?: string, projectPath?: string, spawnMode?: string, alreadyRunning?: boolean, source?: string, environmentId?: string, error?: string, session?: object }}
 */
export function launchClaudeRemoteSession({
  workspacePath,
  sessionName,
  spawnMode,
  claudeBin = resolveClaudeBin(),
  spawnFn = spawn,
  replaceActive = false,
  stopOptions = {},
  allowlistOptions = {},
  skipAllowlistCheck = false,
  findExistingFn = findExistingClaudeSession
} = {}) {
  if (!workspacePath || typeof workspacePath !== 'string' || !fs.existsSync(workspacePath)) {
    return {
      success: false,
      error: `El directorio de trabajo no existe: ${workspacePath || '(no especificado)'}`
    };
  }

  // 1. Verificación de seguridad contra Project Allowlist (Separación de Allowlists)
  if (!skipAllowlistCheck && !isWorkspaceAllowed(workspacePath, allowlistOptions)) {
    return {
      success: false,
      error: `Acceso denegado: El directorio '${workspacePath}' no pertenece a la Project Allowlist de workspaces autorizados.`
    };
  }

  const effectiveSessionName = (typeof sessionName === 'string' && sessionName.trim().length > 0)
    ? sessionName.trim()
    : `Mobile-${path.basename(workspacePath)}`;

  const effectiveSpawnMode = (typeof spawnMode === 'string' && spawnMode.trim().length > 0)
    ? spawnMode.trim()
    : 'same-dir';

  // 2. Idempotencia: Verificar si ya hay una sesión viva para este proyecto (en bridge, Claude pointer o tmux)
  const existing = findExistingFn(workspacePath);
  if (existing) {
    setActiveClaudeSession({
      pid: existing.pid,
      projectPath: workspacePath,
      sessionName: existing.sessionName || effectiveSessionName,
      spawnMode: existing.spawnMode || effectiveSpawnMode
    });

    return {
      success: true,
      alreadyRunning: true,
      pid: existing.pid,
      sessionName: existing.sessionName || effectiveSessionName,
      projectPath: workspacePath,
      source: existing.source,
      environmentId: existing.environmentId,
      spawnMode: existing.spawnMode || effectiveSpawnMode
    };
  }

  // 3. Si hay una sesión activa para OTRO proyecto diferente, gestionarla según replaceActive
  const active = getActiveClaudeSession();
  if (active) {
    if (replaceActive) {
      stopClaudeRemoteSession(stopOptions);
    } else {
      return {
        success: false,
        error: 'Ya existe una sesión activa de Claude para otro proyecto',
        session: active
      };
    }
  }

  // F-02: En Windows Node 20+, invocar .cmd/.bat con shell: false lanza EINVAL (CVE-2024-27980)
  const isWin = process.platform === 'win32';
  const isCmdWrapper = isWin && /\.(cmd|bat)$/i.test(claudeBin);

  const spawnBin = isCmdWrapper ? (process.env.ComSpec || 'cmd.exe') : claudeBin;
  const spawnArgs = isCmdWrapper
    ? ['/d', '/s', '/c', claudeBin, 'remote-control', '--name', effectiveSessionName, `--spawn=${effectiveSpawnMode}`]
    : ['remote-control', '--name', effectiveSessionName, `--spawn=${effectiveSpawnMode}`];

  let child;
  try {
    child = spawnFn(
      spawnBin,
      spawnArgs,
      {
        cwd: workspacePath,
        detached: true,
        stdio: 'ignore',
        env: sanitizeEnv()
      }
    );
  } catch (err) {
    return {
      success: false,
      error: `Error al invocar spawn sobre Claude: ${err.message}`
    };
  }

  // F-01: Proteger el daemon contra eventos de error no capturados en el proceso hijo
  child.on?.('error', (err) => {
    console.error(`[claude-launcher] Error en el proceso hijo de Claude: ${err.message}`);
    clearActiveClaudeSession();
  });

  child.unref?.();

  setActiveClaudeSession({
    pid: child.pid,
    projectPath: workspacePath,
    sessionName: effectiveSessionName,
    spawnMode: effectiveSpawnMode
  });

  return {
    success: true,
    pid: child.pid,
    sessionName: effectiveSessionName,
    projectPath: workspacePath,
    spawnMode: effectiveSpawnMode
  };
}

/**
 * Detiene la sesión remota activa de Claude Code terminando el árbol de procesos
 * y limpiando el estado de forma atómica.
 *
 * En Windows utiliza `taskkill /pid <PID> /T /F` para terminar todos los descendientes.
 * En POSIX envía señales SIGTERM y SIGKILL.
 *
 * @param {Object} [options]
 * @param {Function} [options.execFileSyncFn] Función síncrona de ejecución (default: execFileSync)
 * @param {Function} [options.execFileFn] Función de compatibilidad para testing (default: null)
 * @param {string} [options.platform] Plataforma de destino (default: process.platform)
 * @param {Function} [options.killFn] Función de envío de señales para POSIX testing (default: process.kill)
 * @returns {{ success: boolean, pid?: number, sessionName?: string, error?: string }}
 */
export function stopClaudeRemoteSession({
  execFileSyncFn = null,
  execFileFn = null,
  platform = process.platform,
  killFn = null
} = {}) {
  const active = getActiveClaudeSession();
  if (!active) {
    return {
      success: false,
      error: 'No hay ninguna sesión activa de Claude para detener.'
    };
  }

  const { pid, sessionName } = active;

  if (platform === 'win32') {
    // F-04: Ejecución síncrona para asegurar que el árbol de procesos muera antes de limpiar el estado
    const runner = execFileSyncFn || (execFileFn ? (cmd, args) => execFileFn(cmd, args, () => {}) : execFileSync);
    try {
      runner('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (err) {
      console.warn(`[claude-launcher] Aviso en taskkill: ${err.message}`);
    }
  } else {
    const doKill = killFn || process.kill;
    try {
      doKill(-pid, 'SIGTERM');
    } catch {
      try { doKill(pid, 'SIGTERM'); } catch {}
    }
    try {
      doKill(-pid, 'SIGKILL');
    } catch {
      try { doKill(pid, 'SIGKILL'); } catch {}
    }
  }

  clearActiveClaudeSession();

  return {
    success: true,
    pid,
    sessionName
  };
}

