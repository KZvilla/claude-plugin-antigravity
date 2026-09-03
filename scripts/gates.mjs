#!/usr/bin/env node
/**
 * Corre todas las puertas de validacion y verifica cada una con su propio
 * codigo de salida.
 *
 * Existe por un fallo concreto y repetido: al medir a mano se escribe
 *
 *     node test/narrate.test.js | tail -5   # EXIT=0
 *
 * y ese 0 es el del `tail`, no el del test. La suite puede estar en rojo y el
 * comando reporta verde. Lo mismo con `npm test && npm run validate | grep OK`:
 * en cuanto hay un pipe o un encadenado, el codigo que sobrevive no es el que
 * interesa.
 *
 * La invariante ya estaba escrita en AGENTS.md y aun asi se rompio mientras se
 * trabajaba sobre el codigo que la documentaba. Una regla que hay que recordar
 * en cada comando no es una regla, es una apuesta: aca cada puerta corre
 * aislada, se captura su `status` y se reporta la tabla completa aunque alguna
 * falle -- parar en la primera esconde cuantas mas estan rotas.
 *
 *   node scripts/gates.mjs            todas
 *   node scripts/gates.mjs --quick    solo las rapidas (sin el bridge)
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const soloRapidas = process.argv.includes('--quick');

// En Windows `npm` es `npm.cmd`, y desde Node 18.20 spawnSync rechaza los .cmd
// con shell:false (EINVAL). Hace falta shell para esas, y conviene ser preciso
// sobre por que eso NO reintroduce el problema que este script resuelve: lo que
// enmascara un codigo de salida es la tuberia o el encadenado -- en `a | b` el
// codigo es el de `b`. Lanzar UN solo comando a traves del shell propaga su
// codigo tal cual. Aqui nunca se construye un pipe ni un &&.
const esWin = process.platform === 'win32';
const npmCmd = esWin ? 'npm.cmd' : 'npm';

const PUERTAS = [
  // Las de node se lanzan sin shell: no lo necesitan.
  { nombre: 'unit (narrate)', cmd: process.execPath, args: ['test/narrate.test.js'], shell: false, rapida: true },
  { nombre: 'npm test', cmd: process.execPath, args: ['test/run.js'], shell: false, rapida: true },
  { nombre: 'release:check', cmd: process.execPath, args: ['scripts/stamp-release.mjs', '--check'], shell: false, rapida: true },
  // Estas pasan por npm o por el CLI de claude.
  { nombre: 'test:mcp', cmd: npmCmd, args: ['run', '--silent', 'test:mcp'], shell: esWin, rapida: true },
  { nombre: 'bridge:test', cmd: npmCmd, args: ['run', '--silent', 'bridge:test'], shell: esWin, rapida: false },
  { nombre: 'validate', cmd: npmCmd, args: ['run', '--silent', 'validate'], shell: esWin, rapida: true }
];

const aCorrer = soloRapidas ? PUERTAS.filter(p => p.rapida) : PUERTAS;
const resultados = [];

for (const puerta of aCorrer) {
  const t0 = Date.now();
  // stdio 'pipe': la salida se guarda y solo se imprime si la puerta falla.
  // Nada de pipes de shell -- `status` es el del proceso, sin intermediarios.
  const r = spawnSync(puerta.cmd, puerta.args, {
    cwd: raiz,
    encoding: 'utf8',
    shell: Boolean(puerta.shell),
    stdio: 'pipe'
  });

  const codigo = r.status === null ? 1 : r.status;
  resultados.push({
    nombre: puerta.nombre,
    codigo,
    segundos: (Date.now() - t0) / 1000,
    salida: `${r.stdout || ''}${r.stderr || ''}`.trim(),
    fallo: r.error ? r.error.message : null
  });

  process.stdout.write(`${codigo === 0 ? 'PASS' : 'FAIL'}  ${puerta.nombre}\n`);
}

const rotas = resultados.filter(r => r.codigo !== 0);

console.log('\n' + '-'.repeat(52));
for (const r of resultados) {
  console.log(`  ${String(r.codigo).padStart(3)}  ${r.nombre.padEnd(20)} ${r.segundos.toFixed(1)}s`);
}
console.log('-'.repeat(52));
console.log(`${resultados.length - rotas.length}/${resultados.length} puertas en verde${soloRapidas ? ' (modo --quick)' : ''}`);

if (rotas.length) {
  for (const r of rotas) {
    console.log(`\n=== ${r.nombre} (exit ${r.codigo}) ===`);
    if (r.fallo) console.log(`no se pudo ejecutar: ${r.fallo}`);
    // Solo la cola: lo que importa de una suite rota esta al final.
    console.log(r.salida.split('\n').slice(-25).join('\n'));
  }
}

process.exit(rotas.length ? 1 : 0);
