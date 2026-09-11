/**
 * BE-015 — Reglas de compatibilidad entre `--model` y `--effort` del CLI de agy.
 *
 * Son reglas del CLI, no de ningun subsistema: las usan el servidor MCP, el
 * cast de agentes persistidos y el bot de Telegram. Un solo lugar para que el
 * proximo endurecimiento de agy se corrija una vez.
 *
 * El incidente del 2026-09-11: agy empezo a abortar con "--effort is not
 * supported for the current model" cuando recibia `--effort` sin `--model` y su
 * settings.json resolvia Claude Opus.
 */

/**
 * ¿Se le puede mandar `--effort` a este modelo sin que agy aborte?
 *
 * Lista blanca y no negra: solo la familia Gemini sin sufijo admite el flag.
 * Claude y GPT-OSS lo rechazan, y un id sufijado (`-high`) ya fija el
 * esfuerzo. Una familia nueva cae del lado seguro: sin flag.
 *
 * Sin modelo devuelve `false`: agy elige entonces el de su `settings.json`, que
 * puede ser Opus, y ese fue exactamente el incidente (`--model ""`).
 */
function modeloAdmiteEsfuerzo(modelo) {
  if (!modelo || typeof modelo !== 'string') return false;
  if (/-(low|medium|high)$/i.test(modelo)) return false;
  return /^gemini/i.test(modelo);
}

/**
 * Esfuerzo a pasar como `--effort`, o `null` para no pasar el flag.
 *
 * Un pedido explicito se respeta siempre: si no encaja con el modelo, lo
 * rechaza `validarModeloEsfuerzo` antes del spawn con un mensaje claro, en vez
 * de descartarlo en silencio. Un valor por defecto (config, entorno, el `low`
 * de la narracion) solo se aplica cuando el modelo lo admite con certeza.
 */
function esfuerzoParaCli({ modelo, pedido, porDefecto }) {
  if (pedido) return pedido;
  if (porDefecto && modeloAdmiteEsfuerzo(modelo)) return porDefecto;
  return null;
}

// Los modelos de agy no aceptan cualquier esfuerzo. `agy models` los lista con
// el sufijo incorporado, y la familia Pro solo existe en low y high:
//
//   gemini-3.8-flash-high|medium|low     gemini-3.7-flash-high|medium|low     gemini-3.1-pro-high|low
//
// Pasar el nombre corto es valido -- agy lo resuelve con --effort -- pero
// `--model gemini-3.1-pro --effort medium` es un error que solo aparece tras
// arrancar el proceso, con un mensaje que llega envuelto en JSON.
const ESFUERZOS_POR_FAMILIA = [
  { patron: /pro/i, permitidos: ['low', 'high'] }
];

/**
 * Valida los `cliArgs` ya armados antes del spawn. Devuelve el mensaje de error
 * o `null`.
 *
 * Los valores por defecto ya no llegan aca en combinaciones invalidas (los
 * filtra `esfuerzoParaCli`): lo que se valida es un pedido explicito.
 *
 * Limite conocido: un `--effort` explicito SIN `--model` no se puede validar,
 * porque el modelo lo resuelve agy desde su propio settings.json. Rechazarlo
 * romperia el caso legitimo (agy con Gemini por defecto), asi que pasa y, si
 * no encaja, el error lo da agy.
 */
function validarModeloEsfuerzo(cliArgs) {
  const i = cliArgs.indexOf('--model');
  const j = cliArgs.indexOf('--effort');
  if (i === -1 || j === -1) return null;
  const modelo = cliArgs[i + 1];
  const esfuerzo = cliArgs[j + 1];
  if (typeof modelo !== 'string' || typeof esfuerzo !== 'string') return null;

  if (/^(claude|gpt-oss)/i.test(modelo)) {
    return `El modelo "${modelo}" no admite effort ("${esfuerzo}" pedido). `
      + 'Quita `effort` de la llamada o usa un modelo Gemini sin sufijo.';
  }

  if (/-(low|medium|high)$/i.test(modelo)) {
    return `El modelo "${modelo}" ya fija el esfuerzo en su nombre y choca con effort "${esfuerzo}". `
      + 'Quita `effort` o pasa el nombre corto del modelo.';
  }

  for (const { patron, permitidos } of ESFUERZOS_POR_FAMILIA) {
    if (patron.test(modelo) && !permitidos.includes(esfuerzo.toLowerCase())) {
      return `El modelo "${modelo}" no admite effort "${esfuerzo}". `
        + `Disponibles para esa familia: ${permitidos.join(', ')}. `
        + `Ejecuta \`agy models\` para ver la lista completa.`;
    }
  }
  return null;
}

module.exports = { modeloAdmiteEsfuerzo, esfuerzoParaCli, validarModeloEsfuerzo };
