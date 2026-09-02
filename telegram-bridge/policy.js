/**
 * Política de permisos y evaluación de rutas prohibidas.
 *
 * Vive en su propio módulo, y no en executor.js, por una razón concreta:
 * `executor.js` resuelve el binario de `agy` en su cuerpo de módulo
 * (`const AGY_BIN = resolveAgyBin()`), lo que dispara un `execFileSync` de
 * `where.exe` en cada carga. `notify.js` es un proceso efímero que el servidor
 * MCP lanza por spawn en cada notificación: importar el executor solo para leer
 * la política le añadiría ese subproceso síncrono a cada invocación, y rompería
 * su promesa de cabecera de no arrastrar dependencias.
 *
 * Este módulo no tiene efectos al cargarse.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// IMPORTANTE — qué se aplica de verdad y qué no:
//
//   `agy --help` (v1.1.22) NO expone ningún flag de política por ruta ni por
//   comando. Los únicos controles reales del CLI son `--sandbox` (restricciones
//   de terminal) y `--mode plan` (sesión de solo lectura). `deny_paths` y
//   `deny_commands` se inyectan como texto delante del prompt: son una
//   instrucción al modelo, no un control que el sistema pueda hacer cumplir.
//
// La excepción es `isPathDenied()`, que SÍ es exigible: la aplica el bridge
// sobre las rutas que él mismo sube a Telegram (adjuntos de `telegram_notify` y
// audios de `telegram_send_voice`), donde quien decide es Node y no el modelo.

export const DEFAULT_DENY_COMMANDS = ['git push*', 'git reset --hard*', 'npm publish*', 'rm -rf /*'];
export const DEFAULT_DENY_PATHS = ['.env*', '**/*.key', '**/*.pem'];

/**
 * Variables de entorno que NUNCA se heredan al proceso hijo de `agy`.
 *
 * `agy` corre con `--dangerously-skip-permissions` y puede ejecutar comandos de
 * terminal: cualquier secreto en su entorno es un secreto que el modelo puede
 * leer con un `echo` y devolver en su respuesta, que a su vez se reenvía al chat
 * de Telegram. El token no se pierde para las herramientas salientes:
 * `notify.js` lo lee del `.env` en disco, no del entorno heredado.
 */
export const SECRET_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_NOTIFY_CHAT_ID',
  'ALLOWED_USER_IDS'
];

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * Copia del entorno sin los secretos del bridge, para pasársela a un hijo.
 */
export function sanitizeEnv(env = process.env, extraKeys = []) {
  const limpio = { ...env };
  for (const key of [...SECRET_ENV_KEYS, ...extraKeys]) {
    delete limpio[key];
  }
  return limpio;
}

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

/**
 * Carga la política efectiva con la misma precedencia que el servidor MCP:
 * defaults < ~/.claude/antigravity.json < <cwd>/.claude/antigravity.json < entorno.
 * Así el bridge y el MCP no divergen cuando el usuario ajusta su política.
 */
export function loadPolicy(cwd = resolveWorkspace()) {
  const policy = {
    denyCommands: [...DEFAULT_DENY_COMMANDS],
    denyPaths: [...DEFAULT_DENY_PATHS],
    // Inactivo por defecto, y NO es un límite de rutas. `agy --help` lo describe
    // como «terminal restrictions», y medido en Windows:
    //   - la herramienta de escritura de archivos escribe fuera del workspace
    //     igual con `--sandbox` que sin él;
    //   - los comandos de terminal pasan por ShellExecute con elevación, o sea
    //     un UAC por comando: si se cancela el comando falla, y si se acepta se
    //     ejecuta como administrador.
    // Activarlo por defecto sería peor que no hacerlo: no añade frontera y
    // entrena al usuario a conceder admin a algo disparado desde Telegram.
    // Se deja configurable, pero el límite real sigue siendo `--mode plan`.
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
      console.error(`[policy] No se pudo leer ${file}: ${err.message}. Se ignora.`);
    }
  }

  // El entorno gana: permite endurecer el bridge sin tocar la política del MCP.
  policy.sandbox = parseBool(process.env.AGY_SANDBOX, policy.sandbox);

  return policy;
}

// ==============================================================================
// Evaluación de patrones de ruta
// ==============================================================================

/**
 * Traduce un glob a expresión regular. Se implementa aquí, y no con
 * `minimatch`/`picomatch`, para no añadir dependencias a un módulo que tiene que
 * poder cargarse desde `notify.js` en cualquier entorno.
 *
 * Semántica soportada, la mínima que cubre los patrones reales de `deny_paths`:
 *   `*`   cualquier cosa menos el separador
 *   `**`  cualquier cosa, separadores incluidos
 *   `?`   un carácter que no sea separador
 *
 * Un patrón no absoluto puede coincidir a cualquier profundidad, como en
 * `.gitignore`: `.env*` casa con `C:/proj/sub/.env.local`, y `secrets/**` casa
 * con `C:/proj/secrets/api.txt`. Sin esa regla, un patrón relativo comparado
 * contra una ruta absoluta no casaría jamás y la política sería decorativa.
 */
function globToRegExp(pattern) {
  const normalizado = String(pattern).replace(/\\/g, '/').trim();
  let out = '';

  for (let i = 0; i < normalizado.length; i++) {
    const c = normalizado[i];
    if (c === '*') {
      if (normalizado[i + 1] === '*') {
        if (normalizado[i + 2] === '/') {
          // `**/` consume su barra para poder casar con cero directorios.
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  // Anclaje a cualquier profundidad salvo que el patrón sea explícitamente
  // absoluto (`/etc/...` o `C:/...`).
  const esAbsoluto = normalizado.startsWith('/') || /^[A-Za-z]:\//.test(normalizado);
  const prefijo = esAbsoluto ? '^' : '^(?:.*/)?';

  // Insensible a mayúsculas: Windows no las distingue en rutas, y en POSIX un
  // deny_path que falle por la caja de una letra falla en abierto, no en cerrado.
  return new RegExp(`${prefijo}${out}$`, 'i');
}

const regexCache = new Map();

function cachedRegExp(pattern) {
  let re = regexCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

/**
 * ¿La ruta cae bajo algún patrón de `deny_paths`?
 *
 * Evalúa los patrones REALES de la política cargada, no una lista fija: si el
 * usuario declara `deny_paths: ["secrets/**"]` en su `antigravity.json`, se
 * respeta. Una versión que solo reconociera los tres patrones por defecto
 * devolvería `false` en silencio para todo lo demás.
 *
 * @param {string} targetPath ruta a comprobar (relativa o absoluta)
 * @param {string[]} [patterns] patrones; por defecto los de `loadPolicy()`
 * @returns {string|null} el patrón que la prohíbe, o `null` si está permitida
 */
export function matchDeniedPath(targetPath, patterns = null) {
  if (!targetPath) return null;
  const lista = patterns || loadPolicy().denyPaths;
  if (!Array.isArray(lista) || lista.length === 0) return null;

  // Se comprueban la ruta resuelta y la literal: si el llamante pasó una ruta
  // relativa, `path.resolve` la ancla al cwd del proceso, que no tiene por qué
  // ser aquel contra el que se escribió el patrón.
  const candidatos = [
    path.resolve(targetPath).replace(/\\/g, '/'),
    String(targetPath).replace(/\\/g, '/')
  ];

  for (const pattern of lista) {
    if (!pattern) continue;
    const re = cachedRegExp(pattern);
    if (candidatos.some((c) => re.test(c))) return pattern;
  }

  return null;
}

/**
 * Variante booleana de `matchDeniedPath`.
 */
export function isPathDenied(targetPath, patterns = null) {
  return matchDeniedPath(targetPath, patterns) !== null;
}

/**
 * Error de política, para distinguirlo de un fallo de red o de E/S.
 */
export class PolicyViolationError extends Error {
  constructor(targetPath, pattern) {
    super(
      `Ruta bloqueada por la politica de seguridad: "${targetPath}" coincide con deny_paths "${pattern}". ` +
      'El archivo NO se ha enviado a Telegram.'
    );
    this.name = 'PolicyViolationError';
    this.path = targetPath;
    this.pattern = pattern;
  }
}

/**
 * Lanza si la ruta está prohibida. Punto único de aplicación para todo lo que el
 * bridge suba a Telegram.
 */
export function assertPathAllowed(targetPath, patterns = null) {
  const pattern = matchDeniedPath(targetPath, patterns);
  if (pattern) throw new PolicyViolationError(targetPath, pattern);
  return targetPath;
}

// ==============================================================================
// Saneamiento de secretos
// ==============================================================================

/**
 * Enmascara tokens de bot de Telegram en texto arbitrario antes de imprimirlo.
 *
 * Cubre dos formas: la que aparece dentro de una URL de la API
 * (`api.telegram.org/bot<id>:<secreto>/...`) y el token suelto (`<id>:<secreto>`),
 * que es la que de verdad puede acabar en un log si algo vuelca el entorno o el
 * contenido del `.env`. Un enmascarado que solo contemple el prefijo `bot` deja
 * pasar la segunda, que es la más probable.
 */
export function redactSecrets(text) {
  if (text === null || text === undefined) return '';
  let out = String(text);
  out = out.replace(/(bot)(\d{6,}):[A-Za-z0-9_-]{20,}/g, '$1$2:[REDACTED]');
  out = out.replace(/(^|[^A-Za-z0-9_-])(\d{6,}):[A-Za-z0-9_-]{20,}/g, '$1$2:[REDACTED]');
  return out;
}
