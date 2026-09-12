/**
 * FEAT-041 — Bitácora de un alma: una línea JSON por interacción.
 *
 * La escribe el código, no el modelo, así que el registro es fiel: qué pasó,
 * en qué superficie, cuándo, y qué se rechazó y por qué (nunca el texto
 * rechazado). Las superficies inyectan solo las últimas entradas; el archivo
 * rota para no crecer sin límite.
 */

const { conLock, escribirAtomico, leerTexto } = require('./archivos.js');
const { rutasDe } = require('./rutas.js');

const MAX_LINEAS = 500;
const CONSERVAR = 200;
const MAX_CAMPO = 300;

function recortarCampos(entrada) {
  const salida = {};
  for (const [k, v] of Object.entries(entrada || {})) {
    if (k === 'ts') continue;
    salida[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_CAMPO) : v;
  }
  return salida;
}

/** Agrega una entrada con `ts` puesto acá. Devuelve `{lineas, rotado}`. */
function anotar(clave, entrada, env = process.env) {
  const ruta = rutasDe(clave, env).diario;
  const linea = JSON.stringify({ ts: new Date().toISOString(), ...recortarCampos(entrada) });

  return conLock(ruta, () => {
    let lineas = leerTexto(ruta).split(/\r?\n/).filter(l => l.trim());
    lineas.push(linea);
    const rotado = lineas.length > MAX_LINEAS;
    if (rotado) lineas = lineas.slice(-CONSERVAR);
    escribirAtomico(ruta, lineas.join('\n') + '\n');
    return { lineas: lineas.length, rotado };
  });
}

/** Las últimas `n` entradas legibles. Una línea rota se saltea, no tumba el diario. */
function ultimas(clave, n = 5, env = process.env) {
  const ruta = rutasDe(clave, env).diario;
  const salida = [];
  for (const linea of leerTexto(ruta).split(/\r?\n/)) {
    if (!linea.trim()) continue;
    try {
      const obj = JSON.parse(linea);
      if (obj && typeof obj === 'object') salida.push(obj);
    } catch {}
  }
  return salida.slice(-n);
}

module.exports = { MAX_LINEAS, CONSERVAR, anotar, ultimas };
