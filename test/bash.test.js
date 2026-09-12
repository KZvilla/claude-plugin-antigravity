/**
 * resolverBash (plan-tests-bash, B): en Windows elige el bash de Git y nunca
 * el lanzador de WSL, que no entiende rutas C:\. Entornos y disco falsos.
 */
const { check, group, report } = require('./lib/assert');
const { resolverBash } = require('../mcp-server/lib/bash');

const PF = 'C:\\Program Files\\Git\\bin\\bash.exe';
const WSL_APPS = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps';

function r(env, existentes, plataforma = 'win32') {
  const disco = new Set(existentes.map(s => s.toLowerCase()));
  return resolverBash({ plataforma, env, existe: (p) => disco.has(p.toLowerCase()) });
}

async function main() {
  await group('fuera de Windows', () => {
    check('linux usa el bash del sistema', r({}, [], 'linux') === 'bash');
  });

  await group('Windows: orden de preferencia', () => {
    const base = { ProgramFiles: 'C:\\Program Files' };
    check('el override de Claude Code gana',
      r({ ...base, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\bin\\bash.exe' }, ['D:\\git\\bin\\bash.exe', PF]) === 'D:\\git\\bin\\bash.exe');
    check('un override que no existe se saltea',
      r({ ...base, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\nada\\bash.exe' }, [PF]) === PF);
    check('Program Files si no hay otra cosa', r(base, [PF]) === PF);

    const scoopCmd = 'C:\\scoop\\apps\\git\\current\\cmd';
    const scoopBash = 'C:\\scoop\\apps\\git\\current\\bin\\bash.exe';
    check('el git activo del PATH gana sobre Program Files',
      r({ ...base, Path: `${scoopCmd};C:\\Windows` }, [`${scoopCmd}\\git.exe`, scoopBash, PF]) === scoopBash);

    check('entrada del PATH entre comillas y clave "Path"',
      r({ Path: '"C:\\Tools\\Git\\cmd";C:\\Windows' }, ['C:\\Tools\\Git\\cmd\\git.exe', 'C:\\Tools\\Git\\bin\\bash.exe'])
        === 'C:\\Tools\\Git\\bin\\bash.exe');

    check('git desde mingw64\\bin da la raíz de Git, no mingw64 (auditoría)',
      r({ PATH: 'D:\\Git\\mingw64\\bin' }, ['D:\\Git\\mingw64\\bin\\git.exe', 'D:\\Git\\bin\\bash.exe']) === 'D:\\Git\\bin\\bash.exe');
    check('git de MSYS2 en mingw64\\bin encuentra usr\\bin\\bash.exe',
      r({ PATH: 'C:\\msys64\\mingw64\\bin' }, ['C:\\msys64\\mingw64\\bin\\git.exe', 'C:\\msys64\\usr\\bin\\bash.exe'])
        === 'C:\\msys64\\usr\\bin\\bash.exe');
    check('entrada del PATH con barra final',
      r({ PATH: 'C:\\Tools\\Git\\cmd\\' }, ['C:\\Tools\\Git\\cmd\\git.exe', 'C:\\Tools\\Git\\bin\\bash.exe'])
        === 'C:\\Tools\\Git\\bin\\bash.exe');
    check('un bash de MSYS2 en el PATH se acepta',
      r({ PATH: 'C:\\msys64\\usr\\bin' }, ['C:\\msys64\\usr\\bin\\bash.exe']) === 'C:\\msys64\\usr\\bin\\bash.exe');
  });

  await group('Windows: nunca el lanzador de WSL', () => {
    check('WindowsApps se excluye', r({ PATH: WSL_APPS }, [`${WSL_APPS}\\bash.exe`]) === null);
    check('System32 se excluye', r({ PATH: 'C:\\Windows\\System32' }, ['C:\\Windows\\System32\\bash.exe']) === null);
    check('ni siquiera por override',
      r({ CLAUDE_CODE_GIT_BASH_PATH: `${WSL_APPS}\\bash.exe` }, [`${WSL_APPS}\\bash.exe`]) === null);
    check('ni con un override escrito con / (auditoría)',
      r({ CLAUDE_CODE_GIT_BASH_PATH: 'C:/Users/u/AppData/Local/Microsoft/WindowsApps/bash.exe' },
        [`${WSL_APPS}\\bash.exe`]) === null);
    check('un override válido con / se normaliza',
      r({ CLAUDE_CODE_GIT_BASH_PATH: 'D:/git/bin/bash.exe' }, ['D:\\git\\bin\\bash.exe']) === 'D:\\git\\bin\\bash.exe');
    check('con WSL delante, igual encuentra el de Git',
      r({ PATH: WSL_APPS, ProgramFiles: 'C:\\Program Files' }, [`${WSL_APPS}\\bash.exe`, PF]) === PF);
    check('sin nada, null', r({}, []) === null);
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
