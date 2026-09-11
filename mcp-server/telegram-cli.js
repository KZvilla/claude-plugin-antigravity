/**
 * Puente entre el servidor MCP y la CLI de `telegram-bridge/notify.js`.
 *
 * Vive fuera de index.js para poder probarlo: index.js no exporta nada.
 *
 * El contrato de la CLI es «la ÚLTIMA línea de stdout es un JSON». El parse
 * anterior (`JSON.parse(stdout.trim())`) exigía que stdout fuera SOLO ese JSON,
 * y un aviso de diagnóstico que se colaba antes —`askTelegramQuestion`
 * escribía «Esperando respuesta…» en stdout— hacía que todo `telegram_ask`
 * respondido volviera como «Process exited with code 0».
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NOTIFY_POR_DEFECTO = path.join(__dirname, '..', 'telegram-bridge', 'notify.js');

/**
 * Último objeto JSON de la salida, recorriendo las líneas de abajo hacia
 * arriba. `null` si ninguna línea es un objeto: un array o un número no son el
 * contrato.
 */
function parsearSalidaJson(stdout) {
  const lineas = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lineas.length - 1; i >= 0; i--) {
    try {
      const valor = JSON.parse(lineas[i]);
      if (valor && typeof valor === 'object' && !Array.isArray(valor)) return valor;
    } catch {}
  }
  return null;
}

/**
 * Lanza `notify.js <command> -` con el payload por stdin y devuelve
 * `{ ok, ...lo que diga el JSON }` o `{ ok: false, error }`.
 */
function invokeTelegramBridge(command, payload = {}, { notifyScript = NOTIFY_POR_DEFECTO } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(notifyScript)) {
      return resolve({ ok: false, error: 'telegram-bridge/notify.js not found' });
    }

    const timeoutSec = (payload.timeoutSeconds || payload.timeout_seconds || 300) + 15;
    const child = spawn(process.execPath, [notifyScript, command, '-'], {
      shell: false,
      cwd: path.dirname(notifyScript),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, error: `Telegram operation timed out after ${timeoutSec}s` });
    }, timeoutSec * 1000);

    child.stdin.write(JSON.stringify(payload) + '\n');
    child.stdin.end();

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parsearSalidaJson(stdout);
      if (parsed) {
        // Un JSON de un proceso que salió con error no es un éxito.
        const ok = code === 0 && parsed.ok !== false;
        resolve({
          ...parsed,
          ok,
          ...(ok || parsed.error ? {} : { error: stderr.trim() || `notify.js salió con código ${code}` })
        });
        return;
      }
      resolve({
        ok: false,
        raw: stdout.trim().slice(0, 500),
        error: stderr.trim() || `La salida de notify.js no trae JSON (código ${code}).`
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

module.exports = { invokeTelegramBridge, parsearSalidaJson };
