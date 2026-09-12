/**
 * Que `bash` usar para correr sintaxis POSIX.
 *
 * En Windows, el `bash` del PATH suele ser el lanzador de WSL
 * (`WindowsApps\bash.exe` o `System32\bash.exe`): no entiende rutas `C:\...`
 * y corre en otra maquina. Claude Code usa Git Bash, asi que el delegado de la
 * statusline y los tests tienen que usar ese.
 *
 * Sin estado a proposito (auditoria del plan): son unos pocos existsSync y
 * los tests inyectan entornos distintos.
 */
const fs = require('node:fs');
const path = require('node:path');

const w = path.win32;
const LANZADOR_WSL = /[\\/](system32|windowsapps)[\\/]/i;

function leerVar(env, nombre) {
  const clave = Object.keys(env || {}).find(k => k.toLowerCase() === nombre.toLowerCase());
  return clave ? env[clave] : undefined;
}

// Comillas externas y barras finales: `"C:\Git\cmd\"` y `C:\Git\cmd` son el
// mismo directorio, y la deteccion de la raiz de Git ancla al final.
function limpiar(ruta) {
  return String(ruta).trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
}

function dirsDelPath(env) {
  return (leerVar(env, 'PATH') || '').split(';').map(limpiar).filter(Boolean);
}

function resolverBash({ plataforma = process.platform, env = process.env, existe = fs.existsSync } = {}) {
  if (plataforma !== 'win32') return 'bash';

  const candidatos = [];
  const override = leerVar(env, 'CLAUDE_CODE_GIT_BASH_PATH');
  if (override) candidatos.push(limpiar(override));

  // El git activo del PATH manda sobre una instalacion estandar que quizas
  // este vieja (PortableGit, Scoop).
  // Raiz perezosa y `mingw64\bin` primero: con `.*` codicioso, `...\Git\mingw64\bin`
  // daba la raiz `...\Git\mingw64` y un bash inexistente (auditoria). Git for
  // Windows tiene bash en `bin` y en `usr\bin`; MSYS2, solo en `usr\bin`.
  const dirs = dirsDelPath(env);
  for (const dir of dirs) {
    const raiz = w.normalize(dir).match(/^(.*?)\\(mingw64\\bin|cmd|bin)$/i);
    if (raiz && existe(w.join(dir, 'git.exe'))) {
      candidatos.push(w.join(raiz[1], 'bin', 'bash.exe'), w.join(raiz[1], 'usr', 'bin', 'bash.exe'));
    }
  }
  for (const dir of dirs) candidatos.push(w.join(dir, 'bash.exe'));

  for (const base of [leerVar(env, 'ProgramFiles'), leerVar(env, 'ProgramFiles(x86)')]) {
    if (base) candidatos.push(w.join(limpiar(base), 'Git', 'bin', 'bash.exe'));
  }
  const local = leerVar(env, 'LOCALAPPDATA');
  if (local) candidatos.push(w.join(limpiar(local), 'Programs', 'Git', 'bin', 'bash.exe'));

  // normalize: un override con `/` no debe saltear el filtro de WSL.
  return candidatos.map(c => w.normalize(c)).find(c => !LANZADOR_WSL.test(c) && existe(c)) || null;
}

module.exports = { resolverBash };
