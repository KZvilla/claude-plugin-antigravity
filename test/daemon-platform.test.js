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
