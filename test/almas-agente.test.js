/**
 * Almas, fase 0: el agente `lagrange-alma`. `tools: []` literal (no `tools:`
 * sin ítems, que agy interpreta como un set de lectura), instalación
 * idempotente fuera del registro de agentes casteables, y argumentos sin skip.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');
const agente = require('../mcp-server/almas/agente.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'almas-agente-'));

async function main() {
  await group('contenido del agent.md', () => {
    const c = agente.contenidoAgente();
    check('tools: [] literal', /^tools: \[\]$/m.test(c));
    check('no la clave vacía', !/^tools:\s*$/m.test(c));
    check('nombre lagrange-alma', /^name: lagrange-alma$/m.test(c));
  });

  await group('instalación', () => {
    const a = agente.asegurarAgente(home);
    check('primera vez escribe', a.cambiado && fs.readFileSync(a.ruta, 'utf8') === agente.contenidoAgente());
    check('en config/agents/lagrange-alma', a.ruta === path.join(home, '.gemini', 'config', 'agents', 'lagrange-alma', 'agent.md'));
    check('segunda vez no reescribe', !agente.asegurarAgente(home).cambiado);
    fs.writeFileSync(a.ruta, 'algo distinto');
    check('si cambió, lo restituye', agente.asegurarAgente(home).cambiado && fs.readFileSync(a.ruta, 'utf8') === agente.contenidoAgente());
    check('no toca el registro de agentes', !fs.existsSync(path.join(home, '.claude', 'antigravity-agents.json')));
  });

  await group('argumentos', () => {
    const flash = agente.argsBase({ modelo: 'gemini-3.8-flash' });
    check('agente y json', flash.join(' ').startsWith('--agent lagrange-alma --output-format json'));
    check('flash lleva --effort low', flash.join(' ').includes('--model gemini-3.8-flash --effort low'), flash.join(' '));
    check('nunca skip', ![flash, agente.argsBase(), agente.argsBase({ modelo: 'claude-opus-4-8' })]
      .some(a => a.includes('--dangerously-skip-permissions')));
    const claude = agente.argsBase({ modelo: 'claude-opus-4-8' });
    check('Claude sin --effort', !claude.includes('--effort'), claude.join(' '));
    const sufijo = agente.argsBase({ modelo: 'gemini-3.8-flash-high' });
    check('modelo con sufijo sin --effort', !sufijo.includes('--effort'));
    check('esfuerzo explícito se respeta', agente.argsBase({ modelo: 'gemini-3.8-flash', esfuerzo: 'high' }).includes('high'));
    const vacio = agente.argsBase();
    check('sin modelo: ni --model ni --effort', !vacio.includes('--model') && !vacio.includes('--effort'));
  });

  fs.rmSync(home, { recursive: true, force: true });
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
