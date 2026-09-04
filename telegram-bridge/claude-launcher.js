import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { sanitizeEnv } from './policy.js';
import {
  getActiveClaudeSession,
  setActiveClaudeSession,
  clearActiveClaudeSession
} from './state.js';

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
 * Lee de forma estrictamente segura y de solo lectura los proyectos registrados
 * en ~/.claude.json, descartando rutas inexistentes, WSL y duplicados por casing.
 *
 * Invariante de seguridad: esta función NUNCA abre el archivo en modo de escritura
 * ni realiza modificaciones sobre él o el sistema de archivos.
 *
 * @param {Object} [options]
 * @param {string} [options.claudeJsonPath] Ruta alternativa al archivo .claude.json
 * @param {(p: string) => boolean} [options.existsFn] Verificador de existencia (para testing)
 * @returns {Array<{ id: number, path: string, name: string, displayName: string }>}
 */
export function getKnownWorkspaces({
  claudeJsonPath = resolveClaudeJsonPath(),
  existsFn = (p) => fs.existsSync(p)
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

    seenPaths.add(dedupKey);

    const base = path.basename(normalized) || normalized;
    validWorkspaces.push({
      path: normalized,
      name: base,
      parent: path.basename(path.dirname(normalized)) || ''
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

    return {
      id: index,
      path: ws.path,
      name: ws.name,
      displayName
    };
  });
}

/**
 * Inicia una sesión desacoplada de Claude Code en modo control remoto (--remote-control).
 * Valida la existencia del workspace, verifica que no exista una sesión previa activa,
 * sanea el entorno para no heredar secretos de Telegram y persiste el PID atómicamente.
 *
 * @param {Object} options
 * @param {string} options.workspacePath Ruta física al proyecto
 * @param {string} [options.sessionName] Nombre para la sesión remota (default: Mobile-<basename>)
 * @param {string} [options.claudeBin] Ruta al binario de Claude (default: resolveClaudeBin())
 * @param {Function} [options.spawnFn] Función de spawn inyectable para testing (default: spawn)
 * @returns {{ success: boolean, pid?: number, sessionName?: string, projectPath?: string, error?: string, session?: object }}
 */
export function launchClaudeRemoteSession({
  workspacePath,
  sessionName,
  claudeBin = resolveClaudeBin(),
  spawnFn = spawn
} = {}) {
  if (!workspacePath || typeof workspacePath !== 'string' || !fs.existsSync(workspacePath)) {
    return {
      success: false,
      error: `El directorio de trabajo no existe: ${workspacePath || '(no especificado)'}`
    };
  }

  const active = getActiveClaudeSession();
  if (active) {
    return {
      success: false,
      error: 'Ya existe una sesión activa de Claude',
      session: active
    };
  }

  const effectiveSessionName = (typeof sessionName === 'string' && sessionName.trim().length > 0)
    ? sessionName.trim()
    : `Mobile-${path.basename(workspacePath)}`;

  let child;
  try {
    child = spawnFn(
      claudeBin,
      ['--remote-control', effectiveSessionName],
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

  child.unref?.();

  setActiveClaudeSession({
    pid: child.pid,
    projectPath: workspacePath,
    sessionName: effectiveSessionName
  });

  return {
    success: true,
    pid: child.pid,
    sessionName: effectiveSessionName,
    projectPath: workspacePath
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
 * @param {Function} [options.execFileFn] Función de ejecución de comandos (default: execFile)
 * @param {string} [options.platform] Plataforma de destino (default: process.platform)
 * @param {Function} [options.killFn] Función de envío de señales para POSIX testing (default: process.kill)
 * @returns {{ success: boolean, pid?: number, sessionName?: string, error?: string }}
 */
export function stopClaudeRemoteSession({
  execFileFn = execFile,
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
    try {
      execFileFn('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    } catch (err) {
      console.warn(`[claude-launcher] Error al ejecutar taskkill: ${err.message}`);
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

