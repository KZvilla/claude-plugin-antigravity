/**
 * El daemon tiene que existir en Linux, no solo en Windows.
 *
 * Contexto: `daemon.ps1` y los scripts `daemon:*` de npm eran PowerShell puro.
 * En Ubuntu, `npm run bridge:daemon:install` fallaba sin mas — ni ruta
 * alternativa, ni mensaje que lo explicara. El resto del bridge si era portable
 * (paths.js resuelve XDG, executor.js tiene su rama POSIX), asi que el hueco
 * era exactamente el gestor de servicios.
 *
 * Esta suite fija tres cosas: que el despachador elige por plataforma, que el
 * guard de directorio estable existe en AMBOS scripts (un guard que solo viva
 * en uno deja el agujero abierto por el otro lado), y que macOS falla
 * declarandolo en vez de con un error accidental.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(REPO_ROOT, 'telegram-bridge');

// Preload que finge la plataforma. Es la unica forma de ejercitar las tres
// ramas del despachador desde una sola maquina.
const PRELOAD = path.join(os.tmpdir(), `agy-fakeplat-${process.pid}.js`);
fs.writeFileSync(PRELOAD, 'if (process.env.FAKE_PLATFORM) Object.defineProperty(process, "platform", { value: process.env.FAKE_PLATFORM });\n');

function correrDespachador(plataforma, comando) {
  return spawnSync(process.execPath, ['--require', PRELOAD, path.join(BRIDGE, 'daemon.mjs'), comando], {
    env: { ...process.env, FAKE_PLATFORM: plataforma },
    encoding: 'utf8',
    timeout: 30000
  });
}

async function main() {
  await group('Los dos scripts de daemon existen y parsean', () => {
    check('daemon.ps1 presente', fs.existsSync(path.join(BRIDGE, 'daemon.ps1')));
    check('daemon.sh presente', fs.existsSync(path.join(BRIDGE, 'daemon.sh')));
    check('daemon.mjs (despachador) presente', fs.existsSync(path.join(BRIDGE, 'daemon.mjs')));

    let bashOk = false;
    let bashDetalle = '';
    try {
      execFileSync('bash', ['-n', path.join(BRIDGE, 'daemon.sh')], { stdio: ['pipe', 'pipe', 'pipe'] });
      bashOk = true;
    } catch (err) {
      bashDetalle = (err.stderr || '').toString().slice(0, 200) || err.message;
    }
    check('daemon.sh parsea con bash -n', bashOk, bashDetalle);
  });

  await group('daemon.sh cubre los mismos verbos que daemon.ps1', () => {
    const sh = fs.readFileSync(path.join(BRIDGE, 'daemon.sh'), 'utf8');
    // Paridad de superficie: si una plataforma ofrece un verbo y la otra no, la
    // documentacion y la skill de setup tienen que ramificar, y esas copias se
    // desincronizan. Ver la cabecera de daemon.mjs.
    for (const verbo of ['install', 'uninstall', 'start', 'stop', 'status', 'logs']) {
      check(`daemon.sh implementa '${verbo}'`, new RegExp(`^\\s*${verbo}\\)`, 'm').test(sh));
    }
    check('usa systemd --user, no una unidad de sistema', /systemctl --user/.test(sh));
    check('los logs van al journal', /journalctl --user/.test(sh));
    check('avisa sobre linger', /enable-linger/.test(sh));
  });

  await group('La unidad de systemd esta bien formada', () => {
    // Se RENDERIZA la unidad de verdad, no se inspecciona el script: los dos
    // fallos que esto atrapa -StartLimit en la seccion equivocada y una
    // dependencia contra un target del gestor de sistema- no se ven leyendo el
    // heredoc, y ninguna simulacion de plataforma los detecta.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-unit-'));
    const render = path.join(dir, 'render.sh');
    fs.writeFileSync(render, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'BRIDGE_DIR="/home/u/repo/telegram-bridge"',
      'BOT_SCRIPT="$BRIDGE_DIR/bot.js"',
      `UNIT_DIR="${dir.replace(/\\/g, '/')}/unit"`,
      'UNIT_FILE="$UNIT_DIR/lagrange-telegram-bridge.service"',
      `eval "$(sed -n '/^write_unit()/,/^}/p' "${path.join(BRIDGE, 'daemon.sh').replace(/\\/g, '/')}")"`,
      // La segunda ruta es la del BINARIO, no el comando renombrado en v0.5.0.
      // El guardia de nombres no puede distinguirlos, de ahi la marca.
      'write_unit "/usr/bin/node" "/home/u/.local/bin/agy"', // old-name-ok
      'cat "$UNIT_FILE"'
    ].join('\n'));

    let unidad = '';
    try {
      unidad = execFileSync('bash', [render], { encoding: 'utf8', timeout: 20000 });
    } catch (err) {
      unidad = '';
      check('la unidad se puede renderizar', false, (err.stderr || err.message || '').toString().slice(0, 200));
    }

    if (unidad) {
      // Se recorren las lineas en vez de usar un regex sobre todo el fichero.
      // Con regex, un COMENTARIO que mencione "[Service]" -y la unidad tiene
      // uno, explicando por que StartLimit* no va ahi- se toma por el comienzo
      // de la seccion. Un parser de secciones de verdad reconoce la cabecera
      // solo cuando ocupa la linea entera, igual que hace systemd.
      const secciones = {};
      let actual = null;
      for (const linea of unidad.split(/\r?\n/)) {
        const cabecera = linea.match(/^\[([A-Za-z]+)\]\s*$/);
        if (cabecera) { actual = cabecera[1]; secciones[actual] = []; continue; }
        if (actual) secciones[actual].push(linea);
      }
      const seccion = (nombre) => (secciones[nombre] || []).join('\n');
      const unit = seccion('Unit');
      const service = seccion('Service');

      check('tiene las tres secciones', /\[Unit\]/.test(unidad) && /\[Service\]/.test(unidad) && /\[Install\]/.test(unidad));

      // systemd movio StartLimit* a [Unit] en la v229. En [Service] se ignoran
      // y systemd avisa de clave desconocida, asi que el limite de reinicios
      // simplemente no existiria.
      check('StartLimitBurst va en [Unit]', /StartLimitBurst=/.test(unit), unit.slice(0, 120));
      check('StartLimitIntervalSec va en [Unit]', /StartLimitIntervalSec=/.test(unit));
      check('StartLimit* NO esta en [Service]', !/StartLimit/.test(service));

      // Un servicio de usuario no puede depender de un target del gestor de
      // sistema; el Wants= solo genera ruido.
      check('no depende de network-online.target', !/^\s*(Wants|After|Requires)=network/m.test(unidad), unidad.match(/^\s*(Wants|After|Requires)=.*/m)?.[0] || '');

      // El fallo mas probable del primer arranque en Linux: sin PATH explicito,
      // resolveAgyBin() no encuentra agy aunque funcione en la terminal.
      check('fija un PATH explicito', /^Environment=PATH=/m.test(service), service.slice(0, 200));
      check('el PATH incluye el directorio de node', /Environment=PATH=[^\n]*\/usr\/bin/.test(service));
      check('el PATH incluye el directorio de agy detectado', /Environment=PATH=[^\n]*\/home\/u\/\.local\/bin/.test(service));

      check('ExecStart usa rutas absolutas', /^ExecStart=\/usr\/bin\/node \/home\/u\/repo\/telegram-bridge\/bot\.js$/m.test(service));
      check('WorkingDirectory apunta al bridge', /^WorkingDirectory=\/home\/u\/repo\/telegram-bridge$/m.test(service));
      check('reinicia solo ante fallo', /^Restart=on-failure$/m.test(service));
      check('la salida va al journal', /^StandardOutput=journal$/m.test(service));
      check('se instala en default.target', /WantedBy=default\.target/.test(unidad));
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await group('El guard de directorio estable existe en AMBAS plataformas', () => {
    const ps1 = fs.readFileSync(path.join(BRIDGE, 'daemon.ps1'), 'utf8');
    const sh = fs.readFileSync(path.join(BRIDGE, 'daemon.sh'), 'utf8');

    check('daemon.ps1 tiene el guard', /Assert-DirectorioEstable/.test(ps1));
    check('daemon.sh tiene el guard', /assert_directorio_estable/.test(sh));
    check('daemon.ps1 admite -Force', /\[switch\]\$Force/.test(ps1));
    check('daemon.sh admite --force', /--force/.test(sh));

    // Ambos deben reconocer las dos carpetas gestionadas. Reconocer solo `cache`
    // dejaria pasar una instalacion desde el clon del marketplace.
    for (const [nombre, src] of [['daemon.ps1', ps1], ['daemon.sh', sh]]) {
      check(`${nombre} reconoce plugins/cache`, /plugins.{0,3}(cache)/.test(src));
      check(`${nombre} reconoce plugins/marketplaces`, /marketplaces/.test(src));
    }
  });

  await group('El despachador elige por plataforma', () => {
    // Linux: debe llegar a daemon.sh. Sin systemd en esta maquina, el propio
    // script se queja de systemctl — que es la prueba de que el despacho llego.
    const linux = correrDespachador('linux', 'status');
    const salidaLinux = `${linux.stdout || ''}${linux.stderr || ''}`;
    check('linux enruta a daemon.sh', /systemctl|systemd|Unidad|unidad/i.test(salidaLinux), salidaLinux.slice(0, 200));
    check('linux NO invoca powershell', !/powershell/i.test(salidaLinux), salidaLinux.slice(0, 200));

    // macOS: limite declarado, no un fallo accidental.
    const mac = correrDespachador('darwin', 'install');
    const salidaMac = `${mac.stdout || ''}${mac.stderr || ''}`;
    check('macOS falla con codigo distinto de cero', mac.status !== 0, String(mac.status));
    check('macOS nombra la plataforma', /darwin/.test(salidaMac), salidaMac.slice(0, 200));
    check('macOS ofrece la alternativa manual', /npm run bridge/.test(salidaMac));
    check('macOS explica por que no hay launchd', /sin probar|a\s*medias/i.test(salidaMac), salidaMac.slice(0, 300));
    check('macOS aclara que las notificaciones siguen funcionando', /notificaciones salientes/.test(salidaMac));

    const desconocido = correrDespachador('linux', 'frobnicate');
    check('un verbo invalido se rechaza', desconocido.status !== 0);
  });

  await group('Los scripts de npm son los mismos en toda plataforma', () => {
    const raiz = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const bridge = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'package.json'), 'utf8'));

    for (const verbo of ['', ':check', ':install', ':uninstall', ':start', ':stop', ':logs']) {
      const enBridge = `daemon${verbo}`;
      const enRaiz = `bridge:daemon${verbo}`;
      check(`telegram-bridge expone '${enBridge}'`, !!bridge.scripts[enBridge]);
      check(`la raiz expone '${enRaiz}'`, !!raiz.scripts[enRaiz]);
    }

    // Ningun script puede invocar powershell directamente: eso es justo lo que
    // rompia en Linux antes del despachador.
    const conPowershell = Object.entries(bridge.scripts)
      .filter(([k, v]) => k.includes('daemon') && /powershell/i.test(v))
      .map(([k]) => k);
    check('ningun script de daemon llama a powershell directamente', conPowershell.length === 0, conPowershell.join(', '));
  });

  await group('Voicebox falla rapido fuera de Windows', () => {
    // Antes, el fallback `~/AppData/Roaming` construia una ruta imposible en
    // Linux y waitForVoiceboxGeneration sondeaba 90 s antes de reportar un
    // timeout que culpaba a Voicebox.
    const script = `
      const n = await import(${JSON.stringify(require('url').pathToFileURL(path.join(BRIDGE, 'notify.js')).href)});
      console.log('BASE=' + n.resolveVoiceboxBaseDir().base);
      console.log('SNAPSHOT=' + JSON.stringify(n.getVoiceboxGenerationsSnapshot()));
      const t0 = Date.now();
      try { await n.waitForVoiceboxGeneration({ timeoutMs: 90000 }); console.log('NOLANZO'); }
      catch (e) { console.log('MS=' + (Date.now() - t0)); console.log('MSG=' + e.message); }
    `;
    const r = spawnSync(process.execPath, ['--require', PRELOAD, '--input-type=module', '-e', script], {
      env: { ...process.env, FAKE_PLATFORM: 'linux', VOICEBOX_DIR: '' },
      encoding: 'utf8',
      timeout: 30000
    });
    const salida = `${r.stdout || ''}${r.stderr || ''}`;

    check('sin ruta conocida fuera de Windows', /BASE=null/.test(salida), salida.slice(0, 200));
    check('el snapshot es vacio, no un error', /SNAPSHOT=\[\]/.test(salida), salida.slice(0, 200));

    const ms = salida.match(/MS=(\d+)/);
    check('lanza de inmediato, no tras el timeout', !!ms && Number(ms[1]) < 5000, ms ? `${ms[1]}ms` : 'no lanzo');
    check('el mensaje nombra la plataforma', /MSG=.*linux/.test(salida), salida.slice(0, 300));
    check('el mensaje ofrece VOICEBOX_DIR', /VOICEBOX_DIR/.test(salida));
    check('aclara que el resto del bridge sigue', /notificaciones/.test(salida));
  });

  try { fs.unlinkSync(PRELOAD); } catch {}
  report();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
