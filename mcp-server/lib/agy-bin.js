/**
 * Dónde está el binario de Antigravity.
 *
 * Vivía dentro de `mcp-server/index.js`, que es el servidor MCP entero y no se
 * puede requerir desde otro proceso. `mcp-server/almas/consolidar.js` corre
 * suelto (lo lanza `stop` de la charla de voz, desacoplado) y necesita lo
 * mismo, así que la resolución vive acá y la comparten los dos.
 *
 * `telegram-bridge/executor.js` mantiene su propia copia a propósito: es ESM y
 * no puede importar CommonJS. Es la misma duplicación deliberada que documenta
 * `spoken-text.js` para `redactSecrets`. Si se toca una, tocar la otra.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function resolveAgyBin() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'agy.exe' : 'agy';

  // 1. Try PATH (using execFileSync without shell interpolation)
  try {
    const file = isWin ? 'where.exe' : 'which';
    const found = execFileSync(file, [binName], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {}

  // 2. Try default Windows LocalAppData path
  if (isWin && process.env.LOCALAPPDATA) {
    const localPath = path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }

  // 3. Fallback to binName in PATH
  return binName;
}

module.exports = { resolveAgyBin };
