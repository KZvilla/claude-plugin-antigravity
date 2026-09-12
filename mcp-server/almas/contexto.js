/**
 * FEAT-042 — Lo que un alma aporta al prompt de una llamada.
 *
 * Fase 1: solo la identidad (`alma.md`), para las narraciones. La memoria
 * contradice la regla REWRITE ONLY de las narraciones (RFC §5.1) y llega en la
 * fase 2, con la primera superficie conversacional. Hasta entonces pedirla
 * lanza, para que nadie la use a medias.
 */

const { rutasDe } = require('./rutas.js');
const { leerTexto } = require('./archivos.js');
const { MAX_ALMA } = require('./semilla.js');

/**
 * `{texto, largo, recortado}` o `null` si no hay `alma.md`. Un alma de más de
 * `MAX_ALMA` caracteres se corta en el último salto de línea antes del tope
 * (o en el tope, si no hay ninguno), para no dejar una frase a la mitad.
 */
function identidad(clave, env = process.env) {
  const texto = leerTexto(rutasDe(clave, env).alma).trim();
  if (!texto) return null;
  if (texto.length <= MAX_ALMA) return { texto, largo: texto.length, recortado: false };
  const corte = texto.lastIndexOf('\n', MAX_ALMA);
  const recorte = (corte > 0 ? texto.slice(0, corte) : texto.slice(0, MAX_ALMA)).trimEnd();
  return { texto: recorte, largo: texto.length, recortado: true };
}

function componerContexto(clave, { conMemoria = false } = {}, env = process.env) {
  if (conMemoria) throw new Error('La memoria en el contexto llega en la fase 2.');
  const id = identidad(clave, env);
  return id ? id.texto : null;
}

module.exports = { identidad, componerContexto };
