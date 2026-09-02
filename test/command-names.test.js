/**
 * Slash-command names must stay consistent across the whole plugin.
 *
 * Regression context: v0.5.0 renamed the nine commands (`/agy-plan` ->
 * `/antigravity:plan`, and so on) and the `antigravity` skill to `agy-cli`;
 * v0.6.0 then renamed the plugin itself, so the prefix is now `/lagrange:`. old-name-ok
 * A first sweep only covered commands/, skills/ and agents/, which left four
 * stale references in mcp-server/index.js. Three were cosmetic. The fourth was
 * not:
 *
 *     const isOnlyNarrationCommand = targetUserMsg.text.startsWith('/agy-narrate')
 *
 * That string decides whether `narrate` describes the previous real task or the
 * narration request itself. Under the new name it simply stopped matching —
 * no error, no failing test, just a subtly wrong summary. It was noticed only
 * because an unrelated command printed a stale tip in its own output.
 *
 * So this suite checks both directions: no source file may reference a command
 * name that no longer exists, and every `/lagrange:x` mentioned anywhere
 * must resolve to a real command or skill.
 */
const fs = require('fs');
const path = require('path');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');

// docs/ is gitignored working material and deliberately records old names as
// history; node_modules is not ours.
const SKIP_DIRS = new Set(['node_modules', '.git', 'docs']);
const SCAN_EXT = new Set(['.js', '.mjs', '.md', '.json', '.ps1', '.sh', '.py']);

// The pre-0.5.0 command names, as words. `agy-cli` is deliberately absent: it
// is the current skill. A bare `agy` is absent too — it is the binary.
// The trailing (?![-\w]) keeps unrelated identifiers out: `agy-research-` is a
// tmpdir prefix in research.test.js, not a command.
const OLD_NAMES = /\bagy-(?:narrate-voices|narrate|research|summary|review|audit|plan|usage)(?![-\w])/g;

// A line may name an old command on purpose — to explain why it is gone, or to
// keep reading records that still carry it. Mark those with `old-name-ok`
// rather than widening the pattern, so each exemption is visible where it
// applies and a genuinely stale reference cannot hide behind it.
const ALLOW_MARKER = /old-name-ok/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function realNames() {
  const commands = fs.readdirSync(path.join(REPO_ROOT, 'commands'))
    .filter(f => f.endsWith('.md'))
    .map(f => path.basename(f, '.md'));
  const skills = fs.readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  return { commands, skills, all: new Set([...commands, ...skills]) };
}

function main() {
  const { commands, skills, all } = realNames();
  const files = walk(REPO_ROOT);

  const stale = [];
  const dangling = [];

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    // This file spells out the old forms in order to match them.
    if (rel === 'test/command-names.test.js') continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

    lines.forEach((line, i) => {
      if (ALLOW_MARKER.test(line)) return;

      // Old shape. Matching on `/agy-...` alone is not enough: an escaped
      // regex literal writes it as `\/(agy-narrate)`, where the paren splits
      // the slash from the name and the guard sees nothing. The first version
      // of this check had exactly that hole. So match the old names as words,
      // wherever they appear.
      for (const m of line.matchAll(OLD_NAMES)) {
        stale.push(`${rel}:${i + 1}  ${m[0]}`);
      }
      // A bare `/agy` used as a command (the binary name on its own is fine).
      for (const m of line.matchAll(/\/agy(?![\w\-/])/g)) {
        stale.push(`${rel}:${i + 1}  ${m[0]}`);
      }

      // New shape: every /lagrange:x must exist.
      for (const m of line.matchAll(/\/lagrange:([a-z][a-z-]*)/g)) {
        if (!all.has(m[1])) dangling.push(`${rel}:${i + 1}  /lagrange:${m[1]}`);
      }
    });
  }

  return group('Command names are consistent repo-wide', () => {
    // El recuento es deliberado, no incidental: cada comando entra en el menu
    // de `/` de todos los usuarios del plugin y compite por su atencion. Que
    // este numero falle al anadir uno obliga a justificar el alta en vez de
    // dejar que la superficie crezca sola.
    check('ten commands present', commands.length === 10, `found ${commands.length}: ${commands.join(', ')}`);
    check('three skills present', skills.length === 3, `found ${skills.length}: ${skills.join(', ')}`);
    check('no command carries the redundant agy- prefix',
      commands.every(c => !c.startsWith('agy-')), commands.filter(c => c.startsWith('agy-')).join(', '));
    check('no skill is named after the plugin',
      !skills.includes('lagrange'), '/lagrange:lagrange would be unreachable noise');

    check('no stale pre-0.5.0 command references', stale.length === 0,
      stale.slice(0, 8).join(' | '));
    check('every /lagrange:x resolves to a real command or skill', dangling.length === 0,
      dangling.slice(0, 8).join(' | '));

    // Each command must carry frontmatter the slash menu can show.
    for (const name of commands) {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'commands', `${name}.md`), 'utf8')
        .replace(/\r\n/g, '\n');
      const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
      const desc = fm && fm[1].split('\n').find(l => l.startsWith('description:'));
      check(`${name}.md has a description`, !!desc && desc.length > 20, desc || 'missing');
    }
  }).then(report);
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
