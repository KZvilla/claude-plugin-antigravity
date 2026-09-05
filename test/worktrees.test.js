/**
 * Gestión de worktrees para el fan-out de subagentes (FEAT-003).
 *
 * Se ejercita contra un repositorio git real creado en un directorio temporal:
 * las invariantes que importan son de git, no de nuestro código, y stubbearlas
 * las volvería inobservables. En concreto:
 *
 *   - Dos worktrees no pueden compartir rama. Cada subagente estrena la suya,
 *     derivada de la base. Si esto se rompe, el fan-out falla en el segundo
 *     subagente y no en el primero, que es el peor momento para enterarse.
 *   - La limpieza jamás debe tocar un worktree con trabajo sin integrar, ni uno
 *     que no sea nuestro (los del telegram-bridge comparten directorio).
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const wt = require('../mcp-server/worktrees.js');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function crearRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wt-')));
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'inicial');
  return dir;
}

function borrarRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {}
}

async function main() {
  const repo = crearRepo();

  try {
    await group('convención de rama base', () => {
      const enMain = wt.resolverRamaBase(repo);
      check('detecta main como rama protegida', enMain.protegida === true, `rama = ${enMain.rama}`);
      check('exige rama nueva estando en main', enMain.requiereRamaNueva === true);

      let lanzo = false;
      try {
        wt.crearWorktrees(repo, { slug: 'x', cantidad: 1, ramaBase: 'main' });
      } catch { lanzo = true; }
      check('crearWorktrees se niega a derivar de main', lanzo);

      const prep = wt.prepararRamaBase(repo, 'Añadir validación');
      check('prepararRamaBase crea feat/<slug> desde main',
        prep.rama === 'feat/anadir-validacion' && prep.creada === true, `rama = ${prep.rama}`);
      check('el repo quedó parado en la rama nueva', wt.ramaActual(repo) === 'feat/anadir-validacion');

      const yaEnRama = wt.resolverRamaBase(repo);
      check('una rama de trabajo no está protegida', yaEnRama.protegida === false);

      const idempotente = wt.prepararRamaBase(repo, 'otra cosa');
      check('no cambia de rama si ya está en una de trabajo',
        idempotente.rama === 'feat/anadir-validacion' && idempotente.creada === false);
    });

    let creados = [];
    await group('creación de worktrees', () => {
      creados = wt.crearWorktrees(repo, { slug: 'reparto', cantidad: 3, ramaBase: 'feat/anadir-validacion' });

      check('crea la cantidad pedida', creados.length === 3, `creó ${creados.length}`);
      check('todos los directorios existen', creados.every(c => fs.existsSync(c.ruta)));

      const ramas = creados.map(c => c.rama);
      check('cada worktree estrena su propia rama', new Set(ramas).size === 3, ramas.join(', '));
      check('ninguna rama es la base', !ramas.includes('feat/anadir-validacion'));

      // La invariante de git que el diseño original pasaba por alto.
      const base = git(repo, 'rev-parse', 'feat/anadir-validacion');
      check('todas parten del mismo commit que la base',
        creados.every(c => git(c.ruta, 'rev-parse', 'HEAD') === base));

      check('cada worktree está parado en su rama',
        creados.every(c => git(c.ruta, 'rev-parse', '--abbrev-ref', 'HEAD') === c.rama));
    });

    await group('clasificación limpio / sucio', () => {
      let insp = wt.inspeccionarWorktrees(repo, 'feat/anadir-validacion');
      check('recién creados, los 3 son limpios',
        insp.limpios.length === 3 && insp.sucios.length === 0,
        `limpios=${insp.limpios.length} sucios=${insp.sucios.length}`);

      // Sucio por cambios sin commitear.
      fs.writeFileSync(path.join(creados[0].ruta, 'pendiente.txt'), 'wip\n');

      // Sucio por commit propio sin mergear: working tree impecable, pero con
      // trabajo que se perdería al borrarlo. Es el caso que un `git status`
      // ingenuo daría por limpio.
      fs.writeFileSync(path.join(creados[1].ruta, 'hecho.txt'), 'listo\n');
      git(creados[1].ruta, 'add', '-A');
      git(creados[1].ruta, 'commit', '-q', '-m', 'trabajo del subagente 2');

      insp = wt.inspeccionarWorktrees(repo, 'feat/anadir-validacion');
      check('ahora hay 1 limpio y 2 sucios',
        insp.limpios.length === 1 && insp.sucios.length === 2,
        `limpios=${insp.limpios.length} sucios=${insp.sucios.length}`);

      const motivos = insp.sucios.map(s => s.motivo).join(' | ');
      check('distingue cambios sin commitear', /sin commitear/.test(motivos), motivos);
      check('distingue commits sin mergear', /sin mergear/.test(motivos), motivos);
      check('el limpio es el tercero', insp.limpios[0].rama === creados[2].rama, insp.limpios[0].rama);
    });

    await group('limpieza segura', () => {
      const res = wt.limpiarWorktrees(repo, 'feat/anadir-validacion');

      check('elimina solo el worktree limpio', res.totalEliminados === 1, `eliminó ${res.totalEliminados}`);
      check('preserva los dos con trabajo', res.totalPreservados === 2, `preservó ${res.totalPreservados}`);
      check('el directorio del limpio ya no está', !fs.existsSync(creados[2].ruta));
      check('los directorios con trabajo siguen',
        fs.existsSync(creados[0].ruta) && fs.existsSync(creados[1].ruta));

      const ramas = git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/);
      check('borra la rama del worktree eliminado', !ramas.includes(creados[2].rama), ramas.join(','));
      check('conserva las ramas con trabajo',
        ramas.includes(creados[0].rama) && ramas.includes(creados[1].rama), ramas.join(','));
    });

    await group('no toca worktrees ajenos', () => {
      // El telegram-bridge usa el mismo directorio con otro prefijo. Un fan-out
      // limpiando lo suyo no puede llevárselo por delante.
      const ajeno = path.join(repo, '.claude', 'worktrees', 'bridge-sesion-x');
      git(repo, 'worktree', 'add', '-b', 'worktree-bridge-sesion-x', ajeno, 'feat/anadir-validacion');

      const insp = wt.inspeccionarWorktrees(repo, 'feat/anadir-validacion');
      const rutas = [...insp.limpios, ...insp.sucios].map(x => x.ruta);
      check('el worktree del bridge no aparece en la inspección',
        !rutas.some(r => r.includes('bridge-')), rutas.join(', '));

      wt.limpiarWorktrees(repo, 'feat/anadir-validacion');
      check('el worktree del bridge sobrevive a la limpieza', fs.existsSync(ajeno));
    });

    await group('rollback si el lote falla a medias', () => {
      // Se ocupa de antemano el nombre de rama del segundo worktree: la creación
      // avanza con el primero y revienta en el segundo.
      git(repo, 'branch', 'wt/agy-parcial-2');

      let lanzo = false;
      try {
        wt.crearWorktrees(repo, { slug: 'parcial', cantidad: 3, ramaBase: 'feat/anadir-validacion' });
      } catch { lanzo = true; }

      check('propaga el fallo en vez de devolver un lote incompleto', lanzo);
      check('no deja el primer worktree colgado',
        !fs.existsSync(path.join(repo, '.claude', 'worktrees', 'agy-parcial-1')));

      const ramas = git(repo, 'branch', '--format=%(refname:short)').split(/\r?\n/);
      check('no deja la rama del primero', !ramas.includes('wt/agy-parcial-1'), ramas.join(','));
    });

    await group('validación de argumentos', () => {
      for (const cantidad of [0, -1, 2.5, 'tres', undefined]) {
        let lanzo = false;
        try {
          wt.crearWorktrees(repo, { slug: 'v', cantidad, ramaBase: 'feat/anadir-validacion' });
        } catch { lanzo = true; }
        check(`rechaza cantidad = ${JSON.stringify(cantidad)}`, lanzo);
      }

      check('esRepoGit dice que no ante una ruta inexistente',
        wt.esRepoGit(path.join(os.tmpdir(), 'no-existe-jamas-xyz')) === false);
      check('inspeccionar no revienta fuera de un repo',
        wt.inspeccionarWorktrees(os.tmpdir()).limpios.length === 0);
    });
  } finally {
    borrarRepo(repo);
  }

  process.exit(report() ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
