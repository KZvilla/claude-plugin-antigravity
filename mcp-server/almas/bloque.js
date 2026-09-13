/**
 * FEAT-043 — El bloque `<alma>`: cómo un alma pide guardar algo.
 *
 * agy no puede llamar a una tool del plugin (no está en el `mcp_config.json`
 * del usuario), así que se usa el patrón que ya funciona en
 * `mcp-server/agents/aprendizaje.js`: una cola estructurada al final de la
 * respuesta. Es lo más barato —no hay una segunda llamada al modelo— y lo más
 * fiel: el alma sabe mejor que un parser qué vale la pena recordar. A cambio no
 * es garantía, así que el parser es tolerante y la ausencia del bloque no es un
 * error.
 *
 * Las entradas se direccionan por id (`m3`, `u2`) y no por texto: cada turno es
 * una llamada sin reintento, y un substring con una letra de diferencia
 * fallaría en silencio.
 */

const APERTURA = '<alma>';
const CIERRE = '</alma>';
const MAX_OPERACIONES = 4;
const MAX_TEXTO = 300;

/** La consigna que se agrega al prompt. Corta y al final, para no correrle el foco al mensaje. */
function instruccionDeCierre() {
  return [
    '',
    '---',
    'Si algo de esta conversación te sirve para la próxima vez, agregá al final un bloque así:',
    '',
    APERTURA,
    'recordar: <algo que quieras recordar vos>',
    'sobre-vos: <algo que aprendiste del usuario>',
    'reemplazar m3: <la versión corregida>',
    'olvidar u2',
    CIERRE,
    '',
    `Una operación por línea, máximo ${MAX_OPERACIONES}. Los ids salen de tu memoria, tal como`,
    'aparecen ahí. Si no aprendiste nada nuevo, omití el bloque entero: una memoria',
    'vacía es peor que ninguna. Lo que escribas ahí no se le muestra al usuario.'
  ].join('\n');
}

function recortar(texto) {
  return String(texto || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXTO);
}

/** Los marcadores de la plantilla no son contenido: si vuelven, no se guardan. */
function esPlantilla(texto) {
  return /^<[^>]*>$/.test(texto.trim());
}

function parsearLinea(linea) {
  let m = /^recordar\s*:\s*(.+)$/i.exec(linea);
  if (m) return { tipo: 'agregar', prefijo: 'm', texto: recortar(m[1]) };

  m = /^sobre[\s-]?vos\s*:\s*(.+)$/i.exec(linea);
  if (m) return { tipo: 'agregar', prefijo: 'u', texto: recortar(m[1]) };

  m = /^reemplaz[aá]r?\s+([mu])(\d+)\s*:\s*(.+)$/i.exec(linea);
  if (m) return { tipo: 'reemplazar', prefijo: m[1].toLowerCase(), id: `${m[1].toLowerCase()}${m[2]}`, texto: recortar(m[3]) };

  m = /^olvid[aá]r?\s+([mu])(\d+)\s*$/i.exec(linea);
  if (m) return { tipo: 'olvidar', prefijo: m[1].toLowerCase(), id: `${m[1].toLowerCase()}${m[2]}` };

  return null;
}

/**
 * Separa la respuesta visible del bloque.
 *
 * El texto que el modelo escriba DESPUÉS del cierre se conserva: recortar hasta
 * el final borraría una despedida legítima. Solo un bloque sin cerrar se lleva
 * lo que queda.
 */
function extraerBloque(textoCrudo) {
  const texto = String(textoCrudo || '');
  const inicio = texto.lastIndexOf(APERTURA);
  if (inicio === -1) return { respuesta: texto.trim(), operaciones: [] };

  const finCierre = texto.indexOf(CIERRE, inicio);
  const cuerpo = finCierre === -1
    ? texto.slice(inicio + APERTURA.length)
    : texto.slice(inicio + APERTURA.length, finCierre);
  const antes = texto.slice(0, inicio);
  const despues = finCierre === -1 ? '' : texto.slice(finCierre + CIERRE.length);
  const respuesta = `${antes}\n${despues}`.replace(/\n{3,}/g, '\n\n').trim();

  const operaciones = [];
  for (const lineaCruda of cuerpo.split(/\r?\n/)) {
    if (operaciones.length >= MAX_OPERACIONES) break;
    const linea = lineaCruda.replace(/^\s*[-*•]\s*/, '').trim();
    if (!linea) continue;
    const op = parsearLinea(linea);
    if (!op) continue;
    if (op.texto !== undefined && (!op.texto || esPlantilla(op.texto))) continue;
    operaciones.push(op);
  }

  return { respuesta, operaciones };
}

module.exports = { APERTURA, CIERRE, MAX_OPERACIONES, MAX_TEXTO, instruccionDeCierre, extraerBloque };
