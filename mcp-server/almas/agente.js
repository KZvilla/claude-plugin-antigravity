/**
 * FEAT-041 — El agente `lagrange-alma`: la barrera dura de las llamadas del alma.
 *
 * Las llamadas que leen memoria (chat de Telegram, reacciones, consolidación de
 * la charla) corren como este agente. Tiene que ser así por dos hechos de agy
 * verificados en vivo el 2026-09-12:
 *
 *   1. `tools: []` (lista de flujo vacía) deja al agente SIN tools nativas: ni
 *      escritura, ni `run_command`, ni siquiera `view_file`. En cambio `tools:`
 *      sin ítems NO es vacío: agy le da un set de lectura por defecto. Por eso
 *      el frontmatter se escribe acá literal y no pasa por
 *      `registry.instalarAgente`, que además cambia una lista vacía por
 *      `TOOLS_LECTURA`.
 *   2. agy fija la identidad del hilo en su PRIMER turno: `--agent` en un
 *      `--conversation` posterior se ignora sin aviso. Todo hilo del alma tiene
 *      que nacer con este agente; nunca se "convierte" un hilo existente.
 *
 * Lo que sigue llegando es el roster MCP del usuario (`call_mcp_tool`, SEC-010).
 * Sin `--dangerously-skip-permissions`, agy lo niega sola, y por eso
 * `argsBase` nunca lo agrega.
 *
 * El agente NO se registra en `antigravity-agents.json`: no es un agente
 * casteable y no tiene que aparecer en `cast_agent` ni en el tablero.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registro = require('../agents/registry.js');
const { esfuerzoParaCli } = require('../lib/cli-compat.js');
const { escribirAtomico } = require('./archivos.js');

const AGENTE = 'lagrange-alma';

function contenidoAgente() {
  return [
    '---',
    `name: ${AGENTE}`,
    'description: Voz de un alma de Lagrange. Sin herramientas, solo conversa.',
    'tools: []',
    '---',
    '',
    '# Agent System Instructions',
    '',
    'Sos la voz de un alma del plugin Lagrange. Tu identidad, tu forma de hablar y tu',
    'memoria llegan en cada mensaje, dentro de la consigna: seguilas.',
    '',
    'No tenés herramientas y no las necesitás. No leas archivos, no ejecutes nada y no',
    'navegues. Respondé solo con texto.',
    ''
  ].join('\n');
}

function rutaAgente(homeDir = os.homedir()) {
  return path.join(registro.dirAgentesAgy(homeDir), AGENTE, 'agent.md');
}

/** Escribe el `agent.md` solo si falta o cambió. Devuelve `{ruta, cambiado}`. */
function asegurarAgente(homeDir = os.homedir()) {
  const ruta = rutaAgente(homeDir);
  const contenido = contenidoAgente();
  let actual = null;
  try { actual = fs.readFileSync(ruta, 'utf8'); } catch {}
  if (actual === contenido) return { ruta, cambiado: false };
  escribirAtomico(ruta, contenido);
  return { ruta, cambiado: true };
}

/**
 * Argumentos base de una llamada del alma. Nunca lleva skip. `--effort` solo
 * cuando el modelo lo admite o se pidió explícito: con Claude o un modelo con
 * sufijo, agy aborta si lo recibe.
 */
function argsBase({ modelo, esfuerzo } = {}) {
  const args = ['--agent', AGENTE, '--output-format', 'json'];
  if (modelo) args.push('--model', modelo);
  const efectivo = esfuerzoParaCli({ modelo, pedido: esfuerzo, porDefecto: 'low' });
  if (efectivo) args.push('--effort', efectivo);
  return args;
}

/**
 * El guardarraíl contra el fail-open de `--agent`: si agy no resuelve el
 * nombre, la llamada no corre. Mismo criterio que `registry.verificarResuelve`,
 * con un motivo que apunta a la tool correcta.
 */
async function verificar(agyBin, opciones = {}) {
  const res = await registro.agentesResueltos(agyBin, opciones);
  if (!res.ok) {
    return {
      ok: false,
      motivo: `no se pudo consultar \`agy agents\` (${res.motivo}). Sin esa verificación no se lanza: \`--agent\` falla abierto.`
    };
  }
  if (!res.agentes.includes(AGENTE)) {
    return { ok: false, motivo: `Antigravity no resuelve \`${AGENTE}\`. Instalalo con \`agy_alma action:"agente"\`.` };
  }
  return { ok: true };
}

module.exports = { AGENTE, contenidoAgente, rutaAgente, asegurarAgente, argsBase, verificar };
