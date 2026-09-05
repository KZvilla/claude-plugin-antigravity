/**
 * Gestión de git worktrees para el fan-out de subagentes de Antigravity.
 *
 * Contexto (FEAT-003): el aislamiento entre subagentes concurrentes es el
 * worktree, no el sandbox — `--sandbox` monta un jail sobre el cwd, hace que las
 * escrituras se fuguen al repositorio principal y exige UAC en Windows (ver
 * docs/future-implementations/subagentes-concurrentes-agy.md, H1 a H3). Lo que
 * sí funciona es pasar `cwd` a `agy_run` apuntando a un worktree por subagente.
 *
 * La lógica de inspección y limpieza segura viene de
 * telegram-bridge/claude-launcher.js, que ya la había resuelto para el bridge.
 * Acá se porta a CommonJS, se le cambia el prefijo para no pisar los worktrees
 * del bridge, y se le añade la creación, que allá no hacía falta.
 *
 * Dos invariantes que el diseño original del flujo daba por sentadas y que git
 * no permite:
 *   1. Dos worktrees NO pueden tener la misma rama checkouteada. Cada subagente
 *      necesita su propia rama *derivada* de la base, no la base misma.
 *   2. Nunca se opera sobre main/master. Si el repo está ahí, hay que crear una
 *      rama de trabajo primero (`prepararRamaBase`).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Prefijo propio, distinto del `bridge-` que usa telegram-bridge. La limpieza
// filtra por él, así que un worktree del bridge nunca puede ser borrado por acá
// y viceversa.
const PREFIJO = 'agy';
const DIR_WORKTREES = path.join('.claude', 'worktrees');

// Ramas sobre las que no se trabaja nunca directamente.
const RAMAS_PROTEGIDAS = new Set(['main', 'master']);

function git(repoPath, args, { permitirFallo = false } = {}) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (err) {
    if (permitirFallo) return null;
    throw new Error(`git ${args.join(' ')} falló: ${err.message}`);
  }
}

function esRepoGit(repoPath) {
  if (!repoPath || typeof repoPath !== 'string' || !fs.existsSync(repoPath)) return false;
  return git(repoPath, ['rev-parse', '--is-inside-work-tree'], { permitirFallo: true }) === 'true';
}

function ramaActual(repoPath) {
  const rama = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { permitirFallo: true });
  return rama && rama !== 'HEAD' ? rama : null;
}

/**
 * Normaliza un texto libre a un slug usable como segmento de rama y de ruta.
 */
function slugificar(texto) {
  const s = String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'tarea';
}

function rutaWorktree(repoPath, slug, n) {
  return path.join(repoPath, DIR_WORKTREES, `${PREFIJO}-${slug}-${n}`);
}

function nombreRama(slug, n) {
  return `wt/${PREFIJO}-${slug}-${n}`;
}

/**
 * Decide la rama base del lote según la convención del proyecto:
 * nunca main/master; dev/develop y cualquier rama de trabajo sirven tal cual.
 *
 * @returns {{ rama: string|null, protegida: boolean, requiereRamaNueva: boolean }}
 */
function resolverRamaBase(repoPath) {
  const rama = ramaActual(repoPath);
  const protegida = rama !== null && RAMAS_PROTEGIDAS.has(rama);
  return { rama, protegida, requiereRamaNueva: protegida };
}

/**
 * Deja el repositorio parado sobre una rama base utilizable. Si ya está en una
 * rama de trabajo (incluidas dev/develop) no toca nada; si está en main/master
 * crea `feat/<slug>` y se cambia a ella.
 *
 * @returns {{ rama: string, creada: boolean }}
 */
function prepararRamaBase(repoPath, slugTarea) {
  if (!esRepoGit(repoPath)) throw new Error(`No es un repositorio git: ${repoPath}`);

  const { rama, protegida } = resolverRamaBase(repoPath);
  if (rama === null) throw new Error('HEAD está detached; no hay rama base sobre la que derivar.');
  if (!protegida) return { rama, creada: false };

  const nueva = `feat/${slugificar(slugTarea)}`;
  const yaExiste = git(repoPath, ['rev-parse', '--verify', nueva], { permitirFallo: true }) !== null;
  git(repoPath, yaExiste ? ['checkout', nueva] : ['checkout', '-b', nueva]);
  return { rama: nueva, creada: !yaExiste };
}

/**
 * Crea `cantidad` worktrees, cada uno con su propia rama derivada de `ramaBase`.
 *
 * No se pasa la rama base a `git worktree add` como rama a checkoutear: eso
 * fallaría en el segundo worktree, porque git no admite la misma rama en dos
 * sitios. Se usa `-b` para que cada uno estrene la suya.
 *
 * @returns {Array<{ indice: number, ruta: string, rama: string }>}
 */
function crearWorktrees(repoPath, { slug, cantidad, ramaBase }) {
  if (!esRepoGit(repoPath)) throw new Error(`No es un repositorio git: ${repoPath}`);
  if (!Number.isInteger(cantidad) || cantidad < 1) {
    throw new Error(`cantidad debe ser un entero >= 1, recibido: ${cantidad}`);
  }
  if (RAMAS_PROTEGIDAS.has(ramaBase)) {
    throw new Error(`No se crean worktrees desde ${ramaBase}. Usá prepararRamaBase() antes.`);
  }

  const limpio = slugificar(slug);
  fs.mkdirSync(path.join(repoPath, DIR_WORKTREES), { recursive: true });

  const creados = [];
  try {
    for (let n = 1; n <= cantidad; n++) {
      const ruta = rutaWorktree(repoPath, limpio, n);
      const rama = nombreRama(limpio, n);
      git(repoPath, ['worktree', 'add', '-b', rama, ruta, ramaBase]);
      creados.push({ indice: n, ruta, rama });
    }
  } catch (err) {
    // Un lote a medias es peor que ninguno: el orquestador lanzaría subagentes
    // sobre un reparto incompleto sin enterarse. Se deshace lo ya creado.
    for (const wt of creados) {
      git(repoPath, ['worktree', 'remove', wt.ruta, '--force'], { permitirFallo: true });
      git(repoPath, ['branch', '-D', wt.rama], { permitirFallo: true });
    }
    git(repoPath, ['worktree', 'prune'], { permitirFallo: true });
    throw err;
  }

  return creados;
}

/**
 * Clasifica los worktrees del fan-out en limpios y con trabajo pendiente.
 *
 * Limpio significa las dos cosas a la vez: sin cambios sin commitear, y sin
 * commits por delante de la rama base. Un worktree con commits propios sin
 * mergear NO es limpio, aunque su working tree lo parezca.
 *
 * @returns {{ limpios: Array, sucios: Array }}
 */
function inspeccionarWorktrees(repoPath, ramaBase) {
  const resultado = { limpios: [], sucios: [] };
  if (!esRepoGit(repoPath)) return resultado;

  const base = ramaBase || ramaActual(repoPath);
  const bruto = git(repoPath, ['worktree', 'list', '--porcelain'], { permitirFallo: true });
  if (bruto === null) return resultado;

  const bloques = bruto.split(/\r?\n\r?\n/).map(b => b.trim()).filter(Boolean);
  for (const bloque of bloques) {
    let ruta = '';
    let rama = '';
    for (const linea of bloque.split(/\r?\n/)) {
      if (linea.startsWith('worktree ')) ruta = linea.slice(9).trim();
      else if (linea.startsWith('branch refs/heads/')) rama = linea.slice(18).trim();
    }
    if (!ruta) continue;

    // Solo los nuestros. Los del bridge (`bridge-`) y el worktree principal
    // quedan fuera por construcción.
    const esNuestro = rama.startsWith(`wt/${PREFIJO}-`)
      || (ruta.includes(`${path.sep}${PREFIJO}-`) && ruta.includes('worktrees'));
    if (!esNuestro) continue;

    // Metadato huérfano: la carpeta ya no está. Seguro de podar.
    if (!fs.existsSync(ruta)) {
      resultado.limpios.push({ ruta, rama, motivo: 'metadato huérfano (carpeta ausente)' });
      continue;
    }

    const estado = git(ruta, ['status', '--porcelain'], { permitirFallo: true });
    if (estado === null) {
      resultado.sucios.push({ ruta, rama, motivo: 'no se pudo leer el estado del worktree' });
      continue;
    }
    if (estado.length > 0) {
      resultado.sucios.push({ ruta, rama, motivo: 'archivos modificados sin commitear' });
      continue;
    }

    if (rama && base && rama !== base) {
      const log = git(repoPath, ['log', `${base}..${rama}`, '--oneline'], { permitirFallo: true });
      const adelante = log ? log.split(/\r?\n/).filter(Boolean).length : 0;
      if (adelante > 0) {
        resultado.sucios.push({ ruta, rama, motivo: `${adelante} commit(s) sin mergear hacia ${base}` });
        continue;
      }
    }

    resultado.limpios.push({ ruta, rama, motivo: 'sin cambios ni commits propios' });
  }

  return resultado;
}

/**
 * Elimina únicamente los worktrees del fan-out que estén 100% limpios, con su
 * rama. Los que tengan trabajo sin integrar se preservan y se devuelven para
 * que el orquestador decida.
 */
function limpiarWorktrees(repoPath, ramaBase) {
  const { limpios, sucios } = inspeccionarWorktrees(repoPath, ramaBase);
  const eliminados = [];

  for (const wt of limpios) {
    git(repoPath, ['worktree', 'unlock', wt.ruta], { permitirFallo: true });
    git(repoPath, ['worktree', 'remove', wt.ruta, '--force'], { permitirFallo: true });

    // `git worktree remove` puede dejar la carpeta si algo la retiene — en
    // Windows pasa. Se intenta a mano, pero sin romper si el SO aún la sujeta.
    try {
      if (fs.existsSync(wt.ruta)) fs.rmSync(wt.ruta, { recursive: true, force: true });
    } catch {}

    if (wt.rama) git(repoPath, ['branch', '-D', wt.rama], { permitirFallo: true });
    eliminados.push(wt);
  }

  git(repoPath, ['worktree', 'prune'], { permitirFallo: true });

  return {
    eliminados,
    preservados: sucios,
    totalEliminados: eliminados.length,
    totalPreservados: sucios.length
  };
}

module.exports = {
  PREFIJO,
  DIR_WORKTREES,
  RAMAS_PROTEGIDAS,
  slugificar,
  esRepoGit,
  ramaActual,
  resolverRamaBase,
  prepararRamaBase,
  crearWorktrees,
  inspeccionarWorktrees,
  limpiarWorktrees
};
