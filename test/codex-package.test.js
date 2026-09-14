/**
 * FEAT-006 / BE-014 — El paquete Codex es un overlay aditivo: comparte
 * version, skills y servidor con Claude, pero usa su propio manifest y un
 * cwd relativo que Codex resuelve contra la raiz instalada del plugin.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const ROOT = path.join(__dirname, '..');

function json(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function dentroDeRoot(ruta) {
  const relativa = path.relative(ROOT, ruta);
  return relativa === '' || (!relativa.startsWith('..') && !path.isAbsolute(relativa));
}

async function main() {
  const paquete = json('package.json');
  const claude = json('.claude-plugin/plugin.json');
  const marketClaude = json('.claude-plugin/marketplace.json');
  const mcpClaude = json('.mcp.json');
  const codex = json('.codex-plugin/plugin.json');
  const marketCodex = json('.agents/plugins/marketplace.json');
  const hooksCodex = json('hooks/hooks.json');
  const entradaClaude = marketClaude.plugins.find(p => p.name === 'lagrange');
  const entradaCodex = marketCodex.plugins.find(p => p.name === 'lagrange');

  await group('manifest y versiones de ambos hosts', () => {
    check('el manifest Codex se llama lagrange', codex.name === 'lagrange', codex.name);
    check('la version es semver estricta', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(codex.version), codex.version);
    const versiones = [paquete.version, claude.version, marketClaude.metadata?.version, entradaClaude?.version, codex.version];
    check('las cinco versiones coinciden', new Set(versiones).size === 1, versiones.join(' / '));
    check('Codex descubre las skills compartidas', codex.skills === './skills/' && fs.existsSync(path.join(ROOT, 'skills')));
    check('Codex declara los hooks de sesión', codex.hooks === './hooks/hooks.json' && Boolean(hooksCodex.hooks?.SessionStart && hooksCodex.hooks?.SessionEnd));
    const hookInicio = hooksCodex.hooks.SessionStart[0].hooks[0];
    check('el hook resuelve PLUGIN_ROOT en ambos shells',
      hookInicio.command.includes('$PLUGIN_ROOT') && hookInicio.commandWindows.includes('$env:PLUGIN_ROOT'),
      JSON.stringify(hookInicio));
    check('no hay una copia de skills dentro del overlay', !fs.existsSync(path.join(ROOT, '.codex-plugin', 'skills')));
  });

  await group('los dos manifests apuntan al mismo MCP con resolucion propia', () => {
    const servidorCodex = codex.mcpServers?.lagrange;
    const servidorClaude = mcpClaude.mcpServers?.lagrange;
    check('Codex declara stdio y node', servidorCodex?.type === 'stdio' && servidorCodex?.command === 'node', JSON.stringify(servidorCodex));
    check('Codex usa un entrypoint relativo', JSON.stringify(servidorCodex?.args) === JSON.stringify(['mcp-server/index.js']), JSON.stringify(servidorCodex?.args));
    check('Codex fija cwd en la raiz del plugin', servidorCodex?.cwd === '.', servidorCodex?.cwd);
    check('Claude conserva CLAUDE_PLUGIN_ROOT', JSON.stringify(servidorClaude?.args) === JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/mcp-server/index.js']), JSON.stringify(servidorClaude?.args));
    const entryCodex = path.resolve(ROOT, servidorCodex.cwd, servidorCodex.args[0]);
    const entryClaude = path.resolve(ROOT, servidorClaude.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', ''));
    check('ambos resuelven el mismo entrypoint', entryCodex === entryClaude && fs.existsSync(entryCodex), `${entryCodex} / ${entryClaude}`);
    check('el entrypoint permanece dentro del paquete', dentroDeRoot(entryCodex), entryCodex);
    const serializado = JSON.stringify({ servidorCodex, servidorClaude });
    check('no hay fallback ni shell embebido', !/\$\{[^}]+:-|\|\||\b(?:sh|bash|cmd)\s+(?:-c|\/c)\b/i.test(serializado), serializado);
  });

  await group('marketplace Codex raiz validable', () => {
    check('nombre de marketplace estable', marketCodex.name === 'kzvilla-lagrange-codex', marketCodex.name);
    check('la entrada existe una sola vez', marketCodex.plugins.filter(p => p.name === 'lagrange').length === 1);
    check('el source local monta la raiz', entradaCodex?.source?.source === 'local' && entradaCodex?.source?.path === './', JSON.stringify(entradaCodex?.source));
    check('policies explicitas', entradaCodex?.policy?.installation === 'AVAILABLE' && entradaCodex?.policy?.authentication === 'ON_INSTALL', JSON.stringify(entradaCodex?.policy));
    check('categoria explicita', entradaCodex?.category === 'Developer Tools', entradaCodex?.category);
    const pluginRoot = path.resolve(ROOT, entradaCodex.source.path);
    check('el source queda dentro del paquete', dentroDeRoot(pluginRoot), pluginRoot);
    check('el source contiene el manifest Codex', fs.existsSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json')));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
