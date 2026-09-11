#!/usr/bin/env node
/**
 * Keeper de Voicebox: dueño único del server headless.
 *
 * Existe porque la descarga por inactividad necesita alguien que sobreviva a
 * las sesiones: cada Claude Code tiene su propio servidor MCP, que muere al
 * cerrarse, y Voicebox no descarga modelos por su cuenta.
 *
 * Lo lanza `ensureVoicebox` (voicebox-server.js) desacoplado y sin heredar
 * stdio. Dos modos:
 * - con `--exe`: lanza el server con `--parent-pid <este pid>` y lo administra
 *   (descarga por inactividad, apagado con POST /shutdown);
 * - sin `--exe`: el server ya corría. Si lo había lanzado un keeper que murió,
 *   lo adopta; si no (GUI), solo lo observa para la statusline.
 *
 * Cada 10 s escribe `estado.json`, que es lo único que lee la statusline.
 */
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const vb = require('./voicebox-server.js');

const CICLO_MS = 10000;
const GRACIA_ARRANQUE_MS = 90000;

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] [keeper ${process.pid}] ${msg}\n`);
}

function parsearArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

/**
 * Toma keeper.pid. Si hay otro keeper vivo: con `--exe` (el server está caído
 * y hay que levantarlo) se lo reemplaza; sin `--exe` se cede. Devuelve
 * `{ previo }` con el contenido del keeper anterior, o null si hay que salir.
 */
function reclamarKeeperPid(rutas, conExe) {
  let previo = null;
  try { previo = JSON.parse(fs.readFileSync(rutas.keeperPid, 'utf8')); } catch {}

  let lock = vb.tomarLock(rutas.keeperPid);
  if (!lock && conExe && previo && previo.pid && previo.pid !== process.pid) {
    log(`Reemplazo al keeper ${previo.pid}: el server está caído y hay que levantarlo.`);
    try { process.kill(previo.pid); } catch {}
    try { fs.unlinkSync(rutas.keeperPid); } catch {}
    lock = vb.tomarLock(rutas.keeperPid);
  }
  return lock ? { lock, previo } : null;
}

async function main() {
  const args = parsearArgs(process.argv.slice(2));
  const baseUrl = args.url || `http://127.0.0.1:${vb.PUERTO_POR_DEFECTO}`;
  const puerto = args.port || String(vb.puertoDeUrl(baseUrl));
  const rutas = vb.rutasEstado();
  vb.asegurarDirEstado();

  const reclamo = reclamarKeeperPid(rutas, Boolean(args.exe));
  if (!reclamo) {
    log('Ya hay un keeper vivo; salgo.');
    return;
  }

  let ownsServer = false;
  const inicio = Date.now();

  if (args.exe) {
    const fd = fs.openSync(rutas.serverLog, 'a');
    try {
      const server = spawn(args.exe, ['--host', '127.0.0.1', '--port', puerto, '--data-dir', args['data-dir'], '--parent-pid', String(process.pid)], {
        windowsHide: true,
        stdio: ['ignore', fd, fd]
      });
      server.on('error', err => log(`El server no arrancó: ${err.message}`));
      server.on('exit', code => log(`El proceso lanzado salió con código ${code} (PyInstaller puede seguir en un hijo).`));
      log(`Server lanzado: ${args.exe} (pid ${server.pid}).`);
    } finally {
      fs.closeSync(fd);
    }
    ownsServer = true;
  } else {
    const previo = reclamo.previo;
    if (previo && previo.ownsServer && previo.pid !== process.pid && !vb.pidVivo(previo.pid)) {
      ownsServer = true;
      log(`Adopto el server que había lanzado el keeper ${previo.pid}, que ya no existe.`);
    } else {
      log('El server no es mío (GUI): modo solo lectura.');
    }
  }

  vb.escribirAtomico(rutas.keeperPid, JSON.stringify({ pid: process.pid, ts: Date.now(), ownsServer, puerto: Number(puerto) }));

  let terminando = false;
  const terminar = async (motivo, apagar) => {
    if (terminando) return;
    terminando = true;
    log(`Termino: ${motivo}.`);
    if (apagar) await vb.apagarServer(baseUrl);
    try { fs.unlinkSync(rutas.estado); } catch {}
    try {
      const k = JSON.parse(fs.readFileSync(rutas.keeperPid, 'utf8'));
      if (k.pid === process.pid) fs.unlinkSync(rutas.keeperPid);
    } catch {}
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(sig, () => { terminar(`señal ${sig}`, ownsServer); });
  }

  const vistoDesde = {};
  let fallosSeguidos = 0;
  let algunaVezSano = false;

  const ciclo = async () => {
    const h = await vb.salud(baseUrl, 3000);
    if (!h.ok) {
      // Mientras arranca, CUDA tarda ~4 s y CPU ~14 s: no contar esos fallos.
      if (algunaVezSano || Date.now() - inicio > GRACIA_ARRANQUE_MS) fallosSeguidos++;
    } else {
      algunaVezSano = true;
      fallosSeguidos = 0;
    }

    let modelos = [];
    if (h.ok) {
      try { modelos = await vb.estadoModelos(baseUrl); } catch (err) { log(`/models/status falló: ${err.message}`); }
    }
    const ahora = Date.now();
    const cargadosInfo = modelos.filter(m => m.loaded);
    const cargados = cargadosInfo.map(m => m.model_name);
    for (const n of cargados) if (!vistoDesde[n]) vistoDesde[n] = ahora;
    for (const n of Object.keys(vistoDesde)) if (!cargados.includes(n)) delete vistoDesde[n];

    const cfg = vb.leerConfigVoicebox();
    const idleUnloadMs = cfg.voiceboxIdleUnloadMinutes * 60000;
    const idleShutdownMs = cfg.voiceboxIdleShutdownMinutes * 60000;
    // Un pin o un uso de OmniVoice no son de este server: no pueden impedir
    // que Voicebox descargue ni se apague (OmniVoice se gestiona solo).
    const pinModel = vb.pinDeVoicebox(vb.leerPin());
    const usosCrudos = vb.usosSinOmni(vb.leerUsos());
    // Uso de clientes que no pasan por el plugin (GUI, scripts): Voicebox lo
    // expone en /tasks/active y /history. Sin esto, el keeper descargaba un
    // modelo a mitad de una generación ajena.
    if (ownsServer && h.ok) {
      const [activas, historial] = await Promise.all([vb.generacionesActivas(baseUrl), vb.historialReciente(baseUrl)]);
      const externos = vb.usosDesdeVoicebox({ historial, activas, cargados, ahora });
      for (const [m, ms] of Object.entries(externos)) usosCrudos[m] = Math.max(usosCrudos[m] || 0, ms);
    }
    const usos = vb.usosEfectivos({ cargados, usos: usosCrudos, vistoDesde });
    const ultimoUso = Math.max(inicio, ...Object.values(usosCrudos).filter(Number.isFinite));

    const decision = vb.decidirAccionKeeper({ pinModel, cargados, usos, ahora, idleUnloadMs, idleShutdownMs, ownsServer, ultimoUso, fallosSeguidos });

    if (decision.accion === 'salir') return terminar('el server no responde hace 3 ciclos', false);
    if (decision.accion === 'apagar') return terminar(`sin uso hace más de ${cfg.voiceboxIdleShutdownMinutes} min`, true);
    if (decision.accion === 'descargar') {
      for (const n of decision.modelos) {
        try {
          await vb.descargarModelo(baseUrl, n);
          log(`Descargado por inactividad: ${n}.`);
        } catch (err) {
          log(`No se pudo descargar ${n}: ${err.message}`);
        }
      }
    }

    if (h.ok) {
      const quedan = decision.accion === 'descargar' ? cargadosInfo.filter(m => !decision.modelos.includes(m.model_name)) : cargadosInfo;
      const estado = {
        actualizado: new Date(ahora).toISOString(),
        pid: process.pid,
        modo: ownsServer ? 'propio' : 'gui',
        puerto: Number(puerto),
        variante: h.info.backend_variant || null,
        gpu: h.info.gpu_type || null,
        cargados: quedan.map(m => ({ nombre: m.model_name, mb: m.size_mb || null })),
        pin: pinModel,
        vram: vb.vramNvidia(),
        liberaEnMin: ownsServer
          ? vb.minutosParaLiberar({ pinModel, cargados: quedan.map(m => m.model_name), usos, ahora, idleUnloadMs })
          : null
      };
      try { vb.escribirAtomico(rutas.estado, JSON.stringify(estado)); } catch (err) { log(`No se pudo escribir estado.json: ${err.message}`); }
    }
  };

  const bucle = async () => {
    try { await ciclo(); } catch (err) { log(`Ciclo falló: ${err.message}`); }
    if (!terminando) setTimeout(bucle, CICLO_MS);
  };
  bucle();
}

main().catch(err => {
  log(`Error fatal: ${err.stack || err.message}`);
  process.exit(1);
});
