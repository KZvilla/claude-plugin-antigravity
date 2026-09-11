/**
 * El servidor MCP no depende de Claude Code (FEAT-037, rebanada de docs + test).
 *
 * El acoplamiento con Claude Code está en cómo se lo registra —`.mcp.json` usa
 * `${CLAUDE_PLUGIN_ROOT}`—, no en el servidor: es JSON-RPC por stdio y ningún
 * módulo lee variables `CLAUDE_*`. Esta suite fija eso, para que el README
 * pueda seguir diciendo «apuntá tu cliente a mcp-server/index.js» sin mentir.
 *
 * `tools/list` solo no alcanzaba: devuelve un arreglo fijo en memoria. Se hace
 * además un `tools/call` real (auditoría del plan), con una tool que no lanza
 * `agy`, y con el home redirigido a un temporal: lo que el servidor lea o
 * escriba bajo `~/.claude` no toca el del usuario.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

async function main() {
  const previo = {
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sin-claude-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sin-claude-cwd-'));
  delete process.env.CLAUDE_PLUGIN_ROOT;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  // startServer copia process.env: el hijo nace sin CLAUDE_PLUGIN_ROOT, con el
  // home temporal y parado fuera del repo y de la carpeta del plugin.
  const server = startServer({ cwd });
  try {
    await group('arranca sin CLAUDE_PLUGIN_ROOT y fuera del repo', async () => {
      const init = await server.initialize();
      check('initialize responde', !!(init.result && init.result.serverInfo), JSON.stringify(init).slice(0, 200));
      const nombres = (((await server.listTools()).result || {}).tools || []).map((t) => t.name);
      for (const t of ['agy_run', 'agy_plan', 'agy_usage', 'cast_agent', 'telegram_notify']) {
        check(`tools/list trae ${t}`, nombres.includes(t));
      }
    });

    await group('una tool corre de verdad (tools/call), no solo el catálogo', async () => {
      const r = await server.callTool('agy_usage', {});
      const texto = (((r.result || {}).content || [])[0] || {}).text || '';
      check('agy_usage responde sin error', !r.error && !(r.result && r.result.isError), JSON.stringify(r).slice(0, 200));
      check('con su informe', texto.includes('Usage Metrics'), texto.slice(0, 120));
    });
  } finally {
    await server.stop();
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    removeFixture(cwd);
    removeFixture(home);
  }

  process.exit(report() ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
