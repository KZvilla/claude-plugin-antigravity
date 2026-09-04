import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

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
