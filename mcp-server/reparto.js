/**
 * Validación del reparto de tareas atómicas para el fan-out (FEAT-004).
 *
 * El paralelismo solo es rentable si las tareas son disjuntas EN ARCHIVOS. Los
 * worktrees aíslan la ejecución, no la integración: si dos subagentes tocan el
 * mismo archivo, el conflicto no desaparece, se traslada al merge, y el tiempo
 * ganado en paralelo se devuelve resolviéndolo a mano.
 *
 * Por eso cada tarea declara qué archivos toca y este módulo rechaza el lote
 * ANTES de crear worktrees o gastar cuota. Fallar temprano y barato.
 *
 * Forma de una tarea:
 *   { id, prompt, archivos: string[], modelo?, effort?, soloLectura? }
 *
 * Las rutas se declaran relativas a la raíz del repositorio. Una ruta terminada
 * en `/` denota un subárbol completo.
 */
const path = require('node:path');

const EFFORTS_VALIDOS = new Set(['low', 'medium', 'high']);

/**
 * Lleva una ruta declarada a forma canónica para poder compararlas entre sí:
 * separadores unificados, `./` inicial fuera, barras repetidas colapsadas.
 * Se conserva la barra final, que es la que distingue un subárbol de un archivo.
 */
function normalizarRuta(ruta) {
  const texto = String(ruta || '').trim().replace(/\\/g, '/');
  const esDirectorio = texto.endsWith('/');
  const limpio = texto
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '');
  return { ruta: limpio, esDirectorio, original: String(ruta || '') };
}

function esAbsoluta(texto) {
  const t = String(texto || '').replace(/\\/g, '/');
  return t.startsWith('/') || /^[a-zA-Z]:\//.test(t);
}

function tieneTraversal(rutaNormalizada) {
  return rutaNormalizada.split('/').includes('..');
}

/**
 * ¿`a` contiene a `b`, o son la misma? La comparación es por segmentos: `src/a`
 * no es ancestro de `src/abc`, aunque lo sea como prefijo de texto.
 *
 * Se compara sin distinguir mayúsculas: en Windows y macOS `src/A.js` y
 * `src/a.js` son el mismo archivo, y dar por disjunto lo que el sistema de
 * ficheros considera igual es exactamente el fallo que este módulo evita.
 */
function solapan(a, b) {
  const x = a.ruta.toLowerCase();
  const y = b.ruta.toLowerCase();
  if (x === y) return true;

  const esAncestro = (padre, hijo) => hijo.startsWith(padre + '/');
  // Un archivo suelto no contiene a nadie; solo los subárboles pueden.
  if (a.esDirectorio && esAncestro(x, y)) return true;
  if (b.esDirectorio && esAncestro(y, x)) return true;
  return false;
}

/**
 * Valida un lote de tareas atómicas.
 *
 * @param {Array} tareas
 * @returns {{ valido: boolean, errores: string[], conflictos: Array, avisos: string[], tareas: Array }}
 */
function validarReparto(tareas) {
  const errores = [];
  const avisos = [];
  const conflictos = [];

  if (!Array.isArray(tareas) || tareas.length === 0) {
    return { valido: false, errores: ['El reparto debe ser un array con al menos una tarea.'], conflictos, avisos, tareas: [] };
  }

  const vistas = new Set();
  const normalizadas = [];

  for (let i = 0; i < tareas.length; i++) {
    const t = tareas[i] || {};
    const etiqueta = t.id ? `tarea "${t.id}"` : `tarea #${i + 1}`;

    if (!t.id || typeof t.id !== 'string' || !t.id.trim()) {
      errores.push(`${etiqueta}: falta \`id\` (string no vacío).`);
    } else if (vistas.has(t.id)) {
      errores.push(`${etiqueta}: \`id\` duplicado.`);
    } else {
      vistas.add(t.id);
    }

    if (!t.prompt || typeof t.prompt !== 'string' || !t.prompt.trim()) {
      errores.push(`${etiqueta}: falta \`prompt\` (string no vacío).`);
    }

    if (t.effort !== undefined && !EFFORTS_VALIDOS.has(t.effort)) {
      errores.push(`${etiqueta}: effort "${t.effort}" inválido. Válidos: ${[...EFFORTS_VALIDOS].join(', ')}.`);
    }

    if (!Array.isArray(t.archivos) || t.archivos.length === 0) {
      errores.push(`${etiqueta}: debe declarar \`archivos\` (array no vacío). Sin declaración de alcance no se puede validar disjunción.`);
      normalizadas.push({ tarea: t, rutas: [] });
      continue;
    }

    const rutas = [];
    const dentroDeLaTarea = new Set();
    for (const bruto of t.archivos) {
      if (typeof bruto !== 'string' || !bruto.trim()) {
        errores.push(`${etiqueta}: entrada de \`archivos\` vacía o no textual.`);
        continue;
      }
      if (esAbsoluta(bruto)) {
        errores.push(`${etiqueta}: "${bruto}" es una ruta absoluta. Las rutas se declaran relativas a la raíz del repositorio; una absoluta se saltaría el worktree.`);
        continue;
      }
      const n = normalizarRuta(bruto);
      if (!n.ruta) {
        errores.push(`${etiqueta}: "${bruto}" no es una ruta utilizable.`);
        continue;
      }
      if (tieneTraversal(n.ruta)) {
        errores.push(`${etiqueta}: "${bruto}" contiene ".." y podría salirse del worktree.`);
        continue;
      }
      const clave = n.ruta.toLowerCase() + (n.esDirectorio ? '/' : '');
      if (dentroDeLaTarea.has(clave)) {
        avisos.push(`${etiqueta}: "${bruto}" declarado más de una vez.`);
        continue;
      }
      dentroDeLaTarea.add(clave);
      rutas.push(n);
    }

    normalizadas.push({ tarea: t, rutas });
  }

  // Disjunción entre tareas. Con lotes de unas pocas decenas el par a par es
  // holgadamente suficiente y deja el motivo del choque explícito.
  for (let i = 0; i < normalizadas.length; i++) {
    for (let j = i + 1; j < normalizadas.length; j++) {
      const a = normalizadas[i];
      const b = normalizadas[j];
      for (const ra of a.rutas) {
        for (const rb of b.rutas) {
          if (!solapan(ra, rb)) continue;
          conflictos.push({
            tareas: [a.tarea.id || `#${i + 1}`, b.tarea.id || `#${j + 1}`],
            rutas: [ra.original, rb.original],
            motivo: ra.ruta.toLowerCase() === rb.ruta.toLowerCase()
              ? 'el mismo archivo en ambas tareas'
              : 'una de las rutas contiene a la otra'
          });
        }
      }
    }
  }

  return {
    valido: errores.length === 0 && conflictos.length === 0,
    errores,
    conflictos,
    avisos,
    tareas: normalizadas.map(n => n.tarea)
  };
}

/**
 * Render legible del veredicto, para que el orquestador lo devuelva tal cual
 * cuando rechaza un lote.
 */
function explicarReparto(resultado) {
  if (resultado.valido) {
    const n = resultado.tareas.length;
    const extra = resultado.avisos.length ? `\n\nAvisos:\n${resultado.avisos.map(a => `- ${a}`).join('\n')}` : '';
    return `Reparto válido: ${n} tarea(s) disjuntas en archivos.${extra}`;
  }

  const partes = ['Reparto RECHAZADO. No se crean worktrees ni se gasta cuota.'];

  if (resultado.errores.length) {
    partes.push(`\nErrores:\n${resultado.errores.map(e => `- ${e}`).join('\n')}`);
  }

  if (resultado.conflictos.length) {
    const lineas = resultado.conflictos.map(c =>
      `- ${c.tareas.join(' ↔ ')}: ${c.rutas.join('  /  ')} (${c.motivo})`
    );
    partes.push(
      `\nSolapamientos (${resultado.conflictos.length}):\n${lineas.join('\n')}\n\n`
      + 'Los worktrees aíslan la ejecución, no la integración: estas tareas '
      + 'chocarían en el merge. Redividí el trabajo para que no compartan archivos, '
      + 'o ejecutá las que solapan en serie.'
    );
  }

  if (resultado.avisos.length) {
    partes.push(`\nAvisos:\n${resultado.avisos.map(a => `- ${a}`).join('\n')}`);
  }

  return partes.join('\n');
}

module.exports = {
  EFFORTS_VALIDOS,
  normalizarRuta,
  solapan,
  validarReparto,
  explicarReparto
};
