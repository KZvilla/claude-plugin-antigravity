/**
 * FEAT-007 — Las skills son la fachada semantica compartida. Los hosts pueden
 * prefijar tools de MCP de manera distinta, y las capacidades que leen sesion
 * o UI de Claude deben declararse Claude-only antes de sugerir su uso.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, 'skills');
const dirs = fs.readdirSync(SKILLS, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
const fuentes = new Map(dirs.map(name => [
  name,
  fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
]));
const todo = [...fuentes.values()].join('\n');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');

async function main() {
  await group('los manifests compartidos conservan una sola fachada', () => {
    check('siguen siendo cinco skills', dirs.length === 5, dirs.join(', '));
    for (const [name, source] of fuentes) {
      const manifestName = source.match(/^---\n[\s\S]*?^name:\s*([^\n]+)$/m)?.[1]?.trim();
      check(`${name}: nombre coincide con el directorio`, manifestName === name, String(manifestName));
    }
    check('ninguna skill fija el prefijo de Claude', !/mcp__lagrange__/i.test(todo));
    check('ninguna skill fija el prefijo de opencode', !/lagrange_agy_/i.test(todo));
  });

  await group('cada flujo central se descubre por nombre semantico', () => {
    for (const tool of [
      'agy_run', 'agy_plan', 'agy_review', 'agy_audit', 'agy_research',
      'agy_usage', 'agy_status', 'agy_set_config', 'agy_fanout',
      'cast_agent', 'agy_alma', 'agy_say', 'telegram_notify'
    ]) {
      check(`guia ${tool}`, new RegExp(`\\b${tool}\\b`).test(todo));
    }
  });

  await group('las excepciones de host fallan de forma explicita', () => {
    check('summary se declara Claude-only antes de sus instrucciones',
      /Platform boundary[\s\S]{0,300}Claude Code only[\s\S]{0,400}do not call it/i.test(fuentes.get('session-summary')));
    check('agy-cli niega summary de Codex y ofrece su mecanismo nativo',
      /Do not call this from Codex[\s\S]{0,250}Codex's own handoff\/context facilities/i.test(fuentes.get('agy-cli')));
    check('agy-cli niega narrate de Codex y deriva a agy_say',
      /In Codex, never substitute `agy_narrate`[\s\S]{0,180}`agy_say`/i.test(fuentes.get('agy-cli')));
    check('setup no toca statusLine desde Codex',
      /Claude Code only in the current MVP[\s\S]{0,250}skip this track without editing `~\/\.claude\/settings\.json`/i.test(fuentes.get('setup')));
    check('fanout no promete statusline Codex',
      /statusline (?:is|es) Claude Code-only en el MVP; no se anuncia en\s+Codex/i.test(fuentes.get('fanout')));
    check('la skill adversarial no depende de Claude', !/\bClaude Code\b/.test(fuentes.get('adversarial-review')));
  });

  await group('README ensena el paquete Codex real y sus limites', () => {
    check('instala el marketplace repo-local', /codex plugin marketplace add \/absolute\/path\/to\/claude-plugin-antigravity/.test(readme));
    check('instala lagrange por selector', /codex plugin add lagrange@kzvilla-lagrange-codex/.test(readme));
    check('ya no receta config.toml manual para Codex', !/\[mcp_servers\.lagrange\]/.test(readme));
    check('documenta la matriz de capacidad', /\| Capability \| Claude Code \| Codex MVP \|/.test(readme));
    check('summary Codex figura no soportado', /agy_session_summary[^\n]*\| Full \| Not supported for the current Codex thread/.test(readme));
    check('narrate Codex deriva a agy_say', /Automatic checkpoint narration with `agy_narrate`[^\n]*Not supported; use `agy_say`/.test(readme));
    check('el estado compartido sigue explicito', /state under `~\/\.claude\/` during the\s+MVP/.test(readme));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
