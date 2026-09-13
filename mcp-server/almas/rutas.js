/**
 * FEAT-041 — Dónde viven las almas y cómo se llama cada una en disco.
 *
 * El directorio está en `~/.claude/`, al lado de `lagrange-voicebox/`, y no
 * junto al código: el bot, el MCP y el consolidador pueden correr desde copias
 * distintas del plugin (clon de desarrollo o plugin instalado) y todas tienen
 * que ver las mismas almas.
 *
 * La clave de un alma es un segmento de ruta. Por eso sale de un slug estricto
 * y se valida antes de tocar el disco: un nombre de voz nunca puede escaparse
 * del directorio.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAVE_VALIDA = /^[a-z0-9][a-z0-9-]{0,63}$/;

function homeDir(env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function dirAlmas(env = process.env) {
  const explicito = (env.LAGRANGE_ALMAS_DIR || '').trim();
  if (explicito) return path.resolve(explicito);
  return path.join(homeDir(env), '.claude', 'lagrange-almas');
}

/**
 * Slug de un nombre de voz: sin tildes, en minúsculas, con guiones.
 * `'Diego Alvarez'` → `'diego-alvarez'`, `'Alyá!'` → `'alya'`. `null` si no
 * queda nada utilizable.
 */
function claveDeVoz(nombre) {
  if (typeof nombre !== 'string') return null;
  const clave = nombre
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return clave || null;
}

function validarClave(clave) {
  if (typeof clave !== 'string' || !CLAVE_VALIDA.test(clave)) {
    throw new Error(`Clave de alma inválida: "${clave}".`);
  }
  return clave;
}

function rutasDe(clave, env = process.env) {
  validarClave(clave);
  const dir = path.join(dirAlmas(env), clave);
  return {
    dir,
    alma: path.join(dir, 'alma.md'),
    anterior: path.join(dir, 'alma.md.anterior'),
    memoria: path.join(dir, 'memoria.md'),
    diario: path.join(dir, 'diario.jsonl')
  };
}

function rutaUsuario(env = process.env) {
  return path.join(dirAlmas(env), 'usuario.md');
}

/** Claves con un directorio válido en disco, ordenadas. */
function listarClaves(env = process.env) {
  try {
    return fs.readdirSync(dirAlmas(env), { withFileTypes: true })
      .filter(e => e.isDirectory() && CLAVE_VALIDA.test(e.name))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

module.exports = { CLAVE_VALIDA, dirAlmas, claveDeVoz, validarClave, rutasDe, rutaUsuario, listarClaves };
