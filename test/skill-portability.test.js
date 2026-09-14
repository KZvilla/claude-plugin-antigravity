/**
 * FEAT-007 — Las skills son la fachada semantica compartida. Los hosts pueden
 * prefijar tools de MCP de manera distinta, y las capacidades que leen sesion
 * o UI de un host deben declarar su frontera antes de sugerir su uso.
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
    check('summary declara el hook confiable y el fallo cerrado de Codex',
      /Host boundary[\s\S]{0,500}Codex[\s\S]{0,300}hook must be trusted[\s\S]{0,350}fails closed/i.test(fuentes.get('session-summary')));
    check('agy-cli exige identidad no ambigua para summary de Codex',
      /agy_session_summary[\s\S]{0,700}Codex requires[\s\S]{0,350}ambiguous state fails closed/i.test(fuentes.get('agy-cli')));
    check('agy-cli deriva narrate a agy_say si el hook no esta disponible',
      /In Codex[\s\S]{0,220}agy_narrate[\s\S]{0,250}`agy_say`[\s\S]{0,100}do not guess/i.test(fuentes.get('agy-cli')));
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
    check('summary Codex exige confiar el hook', /agy_session_summary[^\n]*\| Full \| Full after trusting the packaged session hook/.test(readme));
    check('narrate Codex usa el hook o deriva a agy_say', /Automatic checkpoint narration with `agy_narrate`[^\n]*trusting the packaged session hook; otherwise use `agy_say`/.test(readme));
    check('el estado compartido sigue explicito', /state under `~\/\.claude\/` during the\s+MVP/.test(readme));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
