#!/usr/bin/env node
/**
 * Despachador del daemon por plataforma.
 *
 * Existe para que `npm run bridge:daemon:*` sea literalmente el mismo comando
 * en Windows y en Linux. La alternativa -documentar dos invocaciones distintas-
 * obliga a la guia de instalacion, al README y a la skill de setup a ramificar
 * por plataforma en su texto, y esas tres copias se desincronizan.
 *
 *   Windows  ->  daemon.ps1   (Task Scheduler)
 *   Linux    ->  daemon.sh    (systemd --user)
 *   macOS    ->  no soportado, con un mensaje que dice que hacer
 *
 * Sobre macOS: el analogo seria un plist de launchd. No se incluye uno sin
 * probar. Un gestor de servicios a medias es peor que no tenerlo: falla en el
 * arranque del sistema, cuando nadie mira, y el usuario cree que tiene un
 * daemon. Se declara el limite y se ofrece la ruta manual, que si funciona.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const comando = process.argv[2] || 'status';
const extra = process.argv.slice(3);

const VERBOS = new Set(['install', 'uninstall', 'start', 'stop', 'status', 'logs', 'check']);
if (!VERBOS.has(comando)) {
  console.error(`[bridge] Comando desconocido: ${comando}`);
  console.error(`[bridge] Usa uno de: ${[...VERBOS].join(', ')}`);
  process.exit(1);
}

/**
 * `check` es una validacion de sintaxis del script del daemon, no una
 * operacion sobre el servicio. Se comprueba el script de ESTA plataforma: pedir
 * a Linux que parsee PowerShell -o al reves- solo produce un fallo sin sentido.
 */
function comandoCheck() {
  if (process.platform === 'win32') {
    return {
      exe: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'daemon.ps1').Path,[ref]$null,[ref]$e); " +
        "if($e){$e|ForEach-Object{Write-Host ('L'+$_.Extent.StartLineNumber+': '+$_.Message)}; exit 1} else {Write-Host 'daemon.ps1: parse OK'}"]
    };
  }
  return { exe: 'bash', args: ['-n', path.join(__dirname, 'daemon.sh')], okMsg: 'daemon.sh: parse OK' };
}

function resolver() {
  if (comando === 'check') return comandoCheck();

  if (process.platform === 'win32') {
    return {
      exe: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'daemon.ps1'), comando, ...extra]
    };
  }

  if (process.platform === 'linux') {
    return { exe: 'bash', args: [path.join(__dirname, 'daemon.sh'), comando, ...extra] };
  }

  return null;
}

const objetivo = resolver();

if (!objetivo) {
  console.error(`[bridge] No hay gestor de servicios soportado para ${process.platform}.`);
  console.error('');
  console.error('  Soportados: Windows (Task Scheduler) y Linux (systemd --user).');
  console.error('');
  console.error('  En macOS el bridge funciona igual, solo que sin daemon. Arrancalo a mano:');
  console.error('');
  console.error('    npm run bridge');
  console.error('');
  console.error('  Para que arranque solo, escribe tu propia unidad de launchd apuntando a');
  console.error(`    ${path.join(__dirname, 'bot.js')}`);
  console.error('  Deliberadamente no se incluye una sin probarla: un gestor de servicios a');
  console.error('  medias falla en el arranque del sistema, cuando nadie esta mirando.');
  console.error('');
  console.error('  Nada de esto afecta a las notificaciones salientes ni a las notas de voz,');
  console.error('  que no necesitan el daemon.');
  process.exit(1);
}

const hijo = spawn(objetivo.exe, objetivo.args, { cwd: __dirname, stdio: 'inherit' });

hijo.on('error', (err) => {
  console.error(`[bridge] No se pudo ejecutar ${objetivo.exe}: ${err.message}`);
  process.exit(1);
});

hijo.on('close', (code) => {
  if (code === 0 && objetivo.okMsg) console.log(objetivo.okMsg);
  process.exit(code ?? 1);
});
