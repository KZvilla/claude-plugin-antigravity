/** Tiny test harness: no dependencies, readable output, non-zero exit on failure. */

const results = [];

function check(label, condition, detail) {
  results.push({ label, ok: !!condition, detail });
  return !!condition;
}

function group(name, fn) {
  console.log(`\n${name}`);
  const before = results.length;
  return Promise.resolve(fn()).then(() => {
    for (const r of results.slice(before)) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
    }
  });
}

function report() {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  return failed.length === 0;
}

module.exports = { check, group, report };
