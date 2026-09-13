/**
 * FEAT-041 — La primera versión de `alma.md`, sembrada desde un perfil de
 * Voicebox.
 *
 * Desde que existe, manda el archivo: lo edita el usuario y un cambio posterior
 * en Voicebox no lo pisa. Re-sembrar con `forzar` guarda antes una copia en
 * `alma.md.anterior`, porque un forzar por error no puede borrar sin retorno lo
 * que el usuario escribió a mano.
 *
 * La búsqueda del perfil es directa y sin fallback, a propósito: sembrar el
 * alma de otra voz es peor que no sembrar. Por eso no se usa
 * `resolveVoiceProfile` (index.js), que cae a una voz por idioma o a la
 * primera de la lista.
 */

const fs = require('node:fs');
const { claveDeVoz, rutasDe } = require('./rutas.js');
const { conLock, escribirAtomico } = require('./archivos.js');

const IDIOMAS = { es: 'español', en: 'inglés' };

// Lo que entra de `alma.md` en el contexto de una llamada (fase 1 en
// adelante). Vive acá porque este módulo es el dueño del archivo, y `ver` avisa
// si el alma se pasa.
const MAX_ALMA = 2000;

/**
 * El perfil cuyo nombre es la voz pedida. Primero por clave exacta; si no hay,
 * por prefijo de segmento en cualquier sentido ("diego" ↔ "diego-alvarez"),
 * nunca por prefijo suelto ("ana" no es "anabel"). Con cero o más de un
 * candidato, `null`.
 */
function perfilPorNombre(perfiles, voz) {
  if (!Array.isArray(perfiles) || !perfiles.length) return null;
  const buscada = claveDeVoz(voz);
  if (!buscada) return null;

  const conClave = perfiles
    .filter(p => p && typeof p.name === 'string')
    .map(p => ({ p, clave: claveDeVoz(p.name) }))
    .filter(x => x.clave);

  const exactos = conClave.filter(x => x.clave === buscada);
  if (exactos.length === 1) return exactos[0].p;
  if (exactos.length > 1) return null;

  const porSegmento = conClave.filter(x =>
    x.clave.startsWith(`${buscada}-`) || buscada.startsWith(`${x.clave}-`)
  );
  return porSegmento.length === 1 ? porSegmento[0].p : null;
}

function campo(valor, respaldo) {
  const texto = typeof valor === 'string' ? valor.trim() : '';
  return texto || respaldo;
}

/** Los respaldos son los mismos que usa `getPersonaPrompt` (spoken-text.js). */
function textoSemilla(perfil, hoy = new Date().toISOString().slice(0, 10)) {
  const nombre = campo(perfil.name, 'Voz');
  const codigo = campo(perfil.language, 'es').toLowerCase().slice(0, 2);
  const idioma = IDIOMAS[codigo] || campo(perfil.language, 'español');
  return [
    `# ${nombre}`,
    '',
    `<!-- Semilla de Lagrange, generada el ${hoy} desde el perfil de Voicebox. Editala a gusto: desde ahora manda este archivo. -->`,
    '',
    '## Cómo sos',
    '',
    campo(perfil.personality, 'Natural and expressive'),
    '',
    '## Quién sos',
    '',
    campo(perfil.description, 'Voice Assistant'),
    '',
    '## Idioma',
    '',
    `Hablás en ${idioma}.`,
    ''
  ].join('\n');
}

/**
 * Escribe `alma.md` para `clave`. Sin `forzar`, un alma existente no se toca.
 * Devuelve `{creado, existia, ruta, respaldo}`.
 */
function sembrar(clave, perfil, opciones = {}) {
  if (!perfil || !campo(perfil.name, '')) throw new Error('El perfil no tiene nombre.');
  const rutas = rutasDe(clave, opciones.env || process.env);

  return conLock(rutas.alma, () => {
    const existia = fs.existsSync(rutas.alma);
    if (existia && !opciones.forzar) return { creado: false, existia, ruta: rutas.alma, respaldo: null };

    let respaldo = null;
    if (existia) {
      fs.copyFileSync(rutas.alma, rutas.anterior);
      respaldo = rutas.anterior;
    }
    escribirAtomico(rutas.alma, textoSemilla(perfil, opciones.hoy));
    return { creado: true, existia, ruta: rutas.alma, respaldo };
  });
}

module.exports = { MAX_ALMA, perfilPorNombre, textoSemilla, sembrar };
