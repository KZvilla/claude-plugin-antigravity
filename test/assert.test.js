/**
 * El harness no deja pasar un FAIL (plan-tests-bash, A): una suite que llama a
 * report() sin process.exit tiene que salir distinto de cero, porque run.js
 * solo mira el código de salida. Así se escondían los fallos de daemon-platform.
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const ASSERT = path.join(__dirname, 'lib', 'assert.js');

function correrHijo(ok) {
  const codigo = `const { check, report } = require(${JSON.stringify(ASSERT)}); check('x', ${ok}); report();`;
  return spawnSync(process.execPath, ['-e', codigo], { encoding: 'utf8', timeout: 30000 });
}

async function main() {
  await group('report() fija el código de salida', () => {
    const mal = correrHijo(false);
    check('un FAIL sin process.exit sale distinto de cero', mal.status !== 0, String(mal.status));
    const bien = correrHijo(true);
    check('todo en verde sale en 0', bien.status === 0, String(bien.status));
  });
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
