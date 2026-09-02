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
    // La lista de candidatos del .env no puede reescribirse a mano en el
    // script: si diverge de bridgeEnvCandidates(), el daemon informa de un
    // fichero mientras el bot carga otro. Se le pregunta a paths.js.
    check('no duplica la lista de candidatos del .env',
      !/BRIDGE_DIR\/\.\.\/\.env/.test(sh), 'daemon.sh reescribe a mano las rutas del .env');
    check('consulta paths.js para el .env', /bridgeEnvCandidates/.test(sh));
    check('avisa de un .env de menor precedencia', /IGNORA|NO se usa/.test(sh));

    check('usa systemd --user, no una unidad de sistema', /systemctl --user/.test(sh));
    check('los logs van al journal', /journalctl --user/.test(sh));
    check('avisa sobre linger', /enable-linger/.test(sh));
    // Se informa en un solo sitio: `install` termina llamando a `status`, asi
    // que comprobarlo en ambos lo imprimia dos veces en cada instalacion.
    check('el estado de linger se informa una sola vez',
      (sh.match(/loginctl show-user/g) || []).length === 1,
      `${(sh.match(/loginctl show-user/g) || []).length} comprobaciones`);
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
      // `test_prerequisites` comprueba que exista bot.js, asi que se apunta al
      // real: lo que se ejercita es el cableado, no un arbol falso.
      `BRIDGE_DIR="${BRIDGE.replace(/\\/g, '/')}"`,
      'BOT_SCRIPT="$BRIDGE_DIR/bot.js"',
      `UNIT_DIR="${dir.replace(/\\/g, '/')}/unit"`,
      'UNIT_FILE="$UNIT_DIR/lagrange-telegram-bridge.service"',
      `DATA_DIR="${dir.replace(/\\/g, '/')}/data"`,
      "C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_OFF=''",
      // Se cargan las funciones REALES del script, no reimplementaciones.
      `SCRIPT="${path.join(BRIDGE, 'daemon.sh').replace(/\\/g, '/')}"`,
      `eval "$(sed -n '/^info()/,/^fail()/p' "$SCRIPT")"`,
      `eval "$(sed -n '/^test_prerequisites()/,/^}/p' "$SCRIPT")"`,
      `eval "$(sed -n '/^write_unit()/,/^}/p' "$SCRIPT")"`,
      // Se ejercita el CABLEADO COMPLETO: test_prerequisites y luego
      // write_unit con lo que aquella produzca. La primera version de este
      // test llamaba a write_unit con argumentos limpios hechos a mano, asi
      // que validaba la plantilla pero no como se obtienen sus argumentos —
      // y el bug vivia justo ahi: test_prerequisites devolvia la ruta por
      // stdout, el mismo canal por el que imprime ok/info/warn, de modo que
      // ExecStart acababa con "[OK] Node v22..." dentro y systemd rechazaba
      // la unidad. Un test que salta una costura no cubre esa costura.
      'PREREQ_NODE_PATH=""',
      'PREREQ_AGY_PATH=""',
      'test_prerequisites >/dev/null 2>&1 || true',
      'write_unit "$PREREQ_NODE_PATH" "$PREREQ_AGY_PATH"',
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
      const lineaPath = (service.match(/^Environment=.*PATH=.*/m) || [''])[0];
      const lineaExec = (service.match(/^ExecStart=.*/m) || [''])[0];

      check('fija un PATH explicito', /^Environment="PATH=/m.test(service), service.slice(0, 200));
      check('el PATH empieza por un directorio absoluto', /^Environment="PATH=\/[^:\n]+:/m.test(service), lineaPath);

      // LA comprobacion que importa, y la que la version anterior de este test
      // no podia hacer porque llamaba a write_unit con argumentos limpios:
      // ExecStart tiene que ser exactamente dos rutas. Con el bug de stdout
      // llevaba "[OK] Node v22.15.1" delante, y systemd rechazaba la unidad
      // con "Executable name contains special characters".
      const sinDiagnosticos = (s) => !/\[OK\]|\[bridge\]|\[!\]|\[ERROR\]|Node v/.test(s);

      // Las comillas NO se aplican igual en todos los ajustes de systemd, y
      // equivocarse rompe la unidad de dos maneras distintas:
      //
      //   ExecStart= es una linea de comandos, se divide por espacios. SIN
      //   comillas, un clon en "~/mis proyectos/" parte la ruta en dos.
      //
      //   WorkingDirectory= toma el valor literal. CON comillas, la comilla
      //   entra en la ruta y systemd rechaza con "path is not absolute".
      //
      // Las dos reglas se afirman aqui porque cada una se descubrio rompiendo
      // la otra.
      check('ExecStart son exactamente dos rutas entrecomilladas',
        /^ExecStart="[^"]+" "[^"]+"$/m.test(service), lineaExec);
      check('ExecStart apunta a bot.js', /^ExecStart="[^"]+" "[^"]*bot\.js"$/m.test(service), lineaExec);
      check('ExecStart no lleva diagnosticos dentro', sinDiagnosticos(lineaExec), lineaExec);
      check('el PATH no lleva diagnosticos dentro', sinDiagnosticos(lineaPath), lineaPath);

      const lineaWD = (service.match(/^WorkingDirectory=.*/m) || [''])[0];
      check('WorkingDirectory NO va entrecomillado', /^WorkingDirectory=[^"]/.test(lineaWD), lineaWD);
      check('WorkingDirectory es una ruta absoluta', /^WorkingDirectory=(\/|[A-Za-z]:\/)/.test(lineaWD), lineaWD);
      check('WorkingDirectory apunta al bridge', /telegram-bridge$/.test(lineaWD), lineaWD);

      // Environment= si interpreta comillas, y con ellas admite un PATH con
      // espacios. Es la forma que documenta systemd: Environment="VAR=valor".
      check('Environment va entrecomillado entero', /^Environment="PATH=[^"]+"$/m.test(service), lineaPath);
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
