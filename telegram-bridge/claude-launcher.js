import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { sanitizeEnv } from './policy.js';
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
 * Inicia una sesión desacoplada de Claude Code en modo control remoto (remote-control).
 * Valida la existencia del workspace, verifica que no exista una sesión previa activa,
 * sanea el entorno para no heredar secretos de Telegram y persiste el PID atómicamente.
 *
 * @param {Object} options
 * @param {string} options.workspacePath Ruta física al proyecto
 * @param {string} [options.sessionName] Nombre para la sesión remota (default: Mobile-<basename>)
 * @param {string} [options.spawnMode] Modo de spawn: same-dir o worktree (default: same-dir)
 * @param {string} [options.claudeBin] Ruta al binario de Claude (default: resolveClaudeBin())
 * @param {Function} [options.spawnFn] Función de spawn inyectable para testing (default: spawn)
 * @param {boolean} [options.replaceActive] Detiene la sesión previa si existía (default: false)
 * @param {Object} [options.stopOptions] Opciones inyectables para stopClaudeRemoteSession (testing)
 * @returns {{ success: boolean, pid?: number, sessionName?: string, projectPath?: string, spawnMode?: string, error?: string, session?: object }}
 */
export function launchClaudeRemoteSession({
  workspacePath,
  sessionName,
  spawnMode,
  claudeBin = resolveClaudeBin(),
  spawnFn = spawn,
  replaceActive = false,
  stopOptions = {}
} = {}) {
  if (!workspacePath || typeof workspacePath !== 'string' || !fs.existsSync(workspacePath)) {
    return {
      success: false,
      error: `El directorio de trabajo no existe: ${workspacePath || '(no especificado)'}`
    };
  }

  const active = getActiveClaudeSession();
  if (active) {
    if (replaceActive) {
      stopClaudeRemoteSession(stopOptions);
    } else {
      return {
        success: false,
        error: 'Ya existe una sesión activa de Claude',
        session: active
      };
    }
  }

  const effectiveSessionName = (typeof sessionName === 'string' && sessionName.trim().length > 0)
    ? sessionName.trim()
    : `Mobile-${path.basename(workspacePath)}`;

  const effectiveSpawnMode = (typeof spawnMode === 'string' && spawnMode.trim().length > 0)
    ? spawnMode.trim()
    : 'same-dir';

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

