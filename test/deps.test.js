/**
 * Dependencias del daemon (telegram-bridge/deps.mjs) y su cableado.
 *
 * Contexto: una noche el daemon quedó caído con ERR_MODULE_NOT_FOUND: grammy.
 * daemon.ps1 solo miraba que existiera la carpeta node_modules, solo lo miraba
 * en install, y daemon.sh no miraba nada. Esta suite fija el chequeo paquete
 * por paquete y dónde se llama: en install y en start, nunca desde
 * test_prerequisites (daemon-platform.test.js la extrae con sed y la corre
 * sola), y en install recién con el bot parado.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { check, group, report } = require('./lib/assert');

const BRIDGE = path.join(__dirname, '..', 'telegram-bridge');
const DEPS = path.join(BRIDGE, 'deps.mjs');

function fixture(dependencias, instaladas) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-deps-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(dependencias === undefined ? { name: 'x' } : { name: 'x', dependencies: dependencias }));
  for (const nombre of instaladas) {
    const destino = path.join(dir, 'node_modules', ...nombre.split('/'));
    fs.mkdirSync(destino, { recursive: true });
    fs.writeFileSync(path.join(destino, 'package.json'), JSON.stringify({ name: nombre }));
  }
  return dir;
}

async function main() {
  const { faltantes } = await import(pathToFileURL(DEPS).href);

  await group('faltantes revisa paquete por paquete', () => {
    const parcial = fixture({ a: '1', '@s/b': '1' }, ['a']);
    check('detecta la que falta, con scope', JSON.stringify(faltantes(parcial)) === '["@s/b"]', JSON.stringify(faltantes(parcial)));
    const cli = spawnSync(process.execPath, [DEPS, parcial], { encoding: 'utf8' });
    check('la CLI sale con 1 y la nombra', cli.status === 1 && cli.stdout.trim() === '@s/b', `${cli.status} ${cli.stdout}`);

    // Una carpeta node_modules que existe pero está incompleta: el caso real.
    const vacia = fixture({ a: '1' }, []);
    fs.mkdirSync(path.join(vacia, 'node_modules'));
    check('una node_modules vacía no pasa', faltantes(vacia).includes('a'));

    const completa = fixture({ a: '1', '@s/b': '1' }, ['a', '@s/b']);
    check('completas → []', faltantes(completa).length === 0);
    check('la CLI sale con 0', spawnSync(process.execPath, [DEPS, completa]).status === 0);

    const sinClave = fixture(undefined, []);
    check('sin clave dependencies → []', faltantes(sinClave).length === 0);

    const sinPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-deps-'));
    check('sin package.json, la CLI sale con 2', spawnSync(process.execPath, [DEPS, sinPkg]).status === 2);

    for (const d of [parcial, vacia, completa, sinClave, sinPkg]) fs.rmSync(d, { recursive: true, force: true });
  });

  await group('los scripts del daemon verifican dependencias donde toca', () => {
    const ps1 = fs.readFileSync(path.join(BRIDGE, 'daemon.ps1'), 'utf8');
    const sh = fs.readFileSync(path.join(BRIDGE, 'daemon.sh'), 'utf8');
    const cuerpo = (src, inicio, fin) => {
      const i = src.indexOf(inicio);
      if (i === -1) return '';
      const j = src.indexOf(fin, i + inicio.length);
      return src.slice(i, j === -1 ? undefined : j);
    };

    const install = cuerpo(ps1, 'function Invoke-Install', '\nfunction ');
    const start = cuerpo(ps1, 'function Invoke-Start', '\nfunction ');
    const prereq = cuerpo(ps1, 'function Test-Prerequisites', '\nfunction ');
    check('daemon.ps1: install verifica dependencias', /Assert-Dependencias/.test(install));
    check('daemon.ps1: install lo hace después de parar el bot',
      install.indexOf('Wait-BotStopped') !== -1 && install.lastIndexOf('Assert-Dependencias') > install.indexOf('Wait-BotStopped'));
    check('daemon.ps1: start verifica dependencias', /Assert-Dependencias/.test(start));
    // Sin los comentarios: el propio Test-Prerequisites explica por qué NO
    // instala nada, y esa explicación nombra lo que no hace.
    const codigoPrereq = prereq.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
    check('daemon.ps1: Test-Prerequisites no instala nada', !/npm (ci|install)|Assert-Dependencias/.test(codigoPrereq));

    const shInstall = cuerpo(sh, 'invoke_install()', '\n}\n');
    const shStart = cuerpo(sh, 'invoke_start()', '\n}\n');
    const shPrereq = cuerpo(sh, 'test_prerequisites()', '\n}\n');
    check('daemon.sh: install verifica dependencias', /assert_dependencias/.test(shInstall));
    check('daemon.sh: install lo hace después del stop',
      shInstall.indexOf('systemctl --user stop') !== -1 && shInstall.indexOf('assert_dependencias') > shInstall.indexOf('systemctl --user stop'));
    check('daemon.sh: start verifica dependencias', /assert_dependencias/.test(shStart));
    check('daemon.sh: test_prerequisites intacta (la extrae daemon-platform con sed)', !/assert_dependencias|dependencias_faltantes/.test(shPrereq));
  });

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
