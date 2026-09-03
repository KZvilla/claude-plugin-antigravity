/**
 * Verificacion de un documento de resumen contra verdad de campo.
 *
 * Por que no es un segundo pase de LLM: un modelo revisando a otro relee el
 * mismo material y puede alucinar igual, o firmar lo que ve. Aca se compara
 * contra datos que ya estan extraidos mecanicamente -- los `facts` del log y
 * el propio git -- asi que el verificador no puede inventar: o el sha esta en
 * `git log` o no esta.
 *
 * Alcance deliberadamente estrecho. Solo se afirma lo que se puede comprobar:
 * shas presentados como commits, la version que el documento declara como
 * final, y la cobertura de archivos. Lo que exige juicio (si una causa
 * atribuida es fiel al transcript) no se decide aqui.
 *
 * Leccion incorporada, aprendida midiendo: un hex de 8 caracteres es
 * indistinguible de un sha corto. Un auditor ingenuo marco `d572a2f0` como
 * commit inventado cuando era el UUID de otra sesion, citado correctamente.
 * Por eso solo se marca un hex si el propio documento lo presenta como commit.
 */

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Un hex suelto no es un commit. Solo cuenta si el texto lo etiqueta como tal.
// El hueco NO puede excluir el backtick: la forma habitual de citar un commit
// es precisamente `abc1234` entre comillas invertidas, y excluirlo dejaba pasar
// el caso mas comun. La ventana corta y la exigencia de la palabra delante son
// lo que evita cruzar de una frase a otra.
const PATRONES_COMMIT = [
  /\bcommits?[^\n]{0,40}?\b([0-9a-f]{7,40})\b/gi,
  /\bsha[^\n]{0,30}?\b([0-9a-f]{7,40})\b/gi,
  /\bgit\s+(?:show|revert|cherry-pick|checkout)\s+`?([0-9a-f]{7,40})\b/gi
];

// Frases con las que un documento declara donde termino la sesion.
const PATRONES_VERSION_FINAL = [
  /(?:cerr[oó]|termin[oó]|finaliz[oó]|qued[oó]|concluy[oó])[^.\n]{0,60}?\b(v?\d+\.\d+\.\d+)\b/gi,
  /\b(?:versi[oó]n|version)\s+final[^.\n]{0,30}?\b(v?\d+\.\d+\.\d+)\b/gi,
  /\bestado final[^.\n]{0,40}?\b(v?\d+\.\d+\.\d+)\b/gi
];

function normalizarVersion(v) {
  return String(v).replace(/^v/, '');
}

function capturarTodo(texto, patrones) {
  const encontrados = new Set();
  for (const re of patrones) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(texto)) !== null) encontrados.add(m[1]);
  }
  return [...encontrados];
}

/**
 * Extrae del documento solo las afirmaciones comprobables.
 */
function extraerAfirmaciones(texto) {
  const t = String(texto || '');

  // Los UUID se retiran antes de buscar shas: sus primeros 8 caracteres son
  // hex validos y generan falsos positivos.
  const sinUuid = t.replace(RE_UUID, ' [uuid] ');

  return {
    shasComoCommit: capturarTodo(sinUuid, PATRONES_COMMIT).map(s => s.toLowerCase()),
    versionesFinales: capturarTodo(t, PATRONES_VERSION_FINAL).map(normalizarVersion),
    archivosCitados: [...new Set((t.match(/`([^`\n]*[\/\\][^`\n]*\.[a-z]{1,5})`/gi) || [])
      .map(s => s.replace(/`/g, '').trim()))]
  };
}

/**
 * Ultima version que aparece en la linea de tiempo derivada: es la version en
 * la que la sesion realmente termino.
 */
function versionFinalReal(facts) {
  if (!facts || !Array.isArray(facts.milestones)) return null;
  let ultima = null;
  for (const h of facts.milestones) {
    const vs = String(h.command).match(/\bv?\d+\.\d+\.\d+\b/g);
    if (vs && vs.length) ultima = normalizarVersion(vs[vs.length - 1]);
  }
  return ultima;
}

function nombreBase(ruta) {
  return String(ruta).replace(/\\/g, '/').split('/').pop().toLowerCase();
}

// Palabras demasiado comunes para que su presencia demuestre nada.
const VACIAS = new Set([
  'cada', 'para', 'como', 'donde', 'porque', 'sobre', 'entre', 'desde', 'hasta',
  'entonces', 'siempre', 'nunca', 'entre', 'entrega', 'cuando', 'tiene', 'tienen',
  'debe', 'deben', 'puede', 'pueden', 'hacer', 'hace', 'esta', 'estan', 'este',
  'with', 'that', 'this', 'from', 'must', 'each', 'their', 'there', 'where', 'which'
]);

/**
 * Terminos por los que se puede reconocer un punto clave dentro del documento.
 *
 * Un punto clave se parafrasea al resumirlo, asi que buscarlo literal no sirve.
 * Se buscan sus terminos distintivos: identificadores de codigo, rutas, flags y
 * numeros, que son justamente lo que un resumen fiel conserva textual.
 */
function terminosDistintivos(punto) {
  const t = String(punto || '');
  const terminos = new Set();

  // Identificadores y rutas: lo que trae punto, guion bajo o barra.
  for (const m of t.match(/[A-Za-z_$][\w$]*(?:[._\-\/][\w$]+)+/g) || []) terminos.add(m.toLowerCase());
  // Flags de linea de comandos y variables de shell.
  for (const m of t.match(/(?:--?[a-z][\w-]+|\$\?|\$[A-Z_]+)/g) || []) terminos.add(m.toLowerCase());
  // Numeros con forma de dato (versiones, conteos, tamanos).
  for (const m of t.match(/\b\d+(?:[.\/]\d+)+\b|\b\d{2,}\b/g) || []) terminos.add(m.toLowerCase());
  // Si nada de lo anterior aparecio, las palabras largas hacen de respaldo.
  if (!terminos.size) {
    for (const m of t.toLowerCase().match(/[a-záéíóúñ]{6,}/g) || []) {
      if (!VACIAS.has(m)) terminos.add(m);
    }
  }
  return [...terminos];
}

/**
 * Comprueba que cada punto clave que paso quien invoca quedo representado.
 *
 * Existe porque hay una clase de contenido que se perdio en 6 de 6 corridas,
 * con los dos modelos y a la mitad del contexto util: las reglas de metodo
 * -- invariantes que la sesion establecio a golpes, como verificar cada puerta
 * con su propio codigo de salida, o truncar un comando en la linea que abre un
 * heredoc. No es saturacion de contexto: es que estan diluidas en el transcript
 * y nada las marca. Quien invoca la herramienta si las conoce, y al declararlas
 * se vuelven verdad de campo comprobable.
 */
function verificarPuntosClave(texto, puntos) {
  const t = String(texto || '').toLowerCase();
  const faltantes = [];
  for (const punto of puntos || []) {
    const terminos = terminosDistintivos(punto);
    if (!terminos.length) continue;
    if (!terminos.some(term => t.includes(term))) {
      faltantes.push({ punto: String(punto), terminos });
    }
  }
  return faltantes;
}

/**
 * @param {string} texto documento generado
 * @param {object} ctx { facts, shasReales: string[], tagsReales: string[], keyPoints: string[] }
 * @returns {{hallazgos: Array, bloqueantes: number, resumen: string}}
 */
function auditarDocumento(texto, ctx = {}) {
  const t = String(texto || '');
  const facts = ctx.facts || {};
  const shasReales = ctx.shasReales || [];
  const tags = new Set((ctx.tagsReales || []).map(normalizarVersion));
  const hallazgos = [];

  const af = extraerAfirmaciones(t);

  // 1. Shas presentados como commits que no existen en el repositorio.
  for (const sha of af.shasComoCommit) {
    const existe = shasReales.some(real => real.toLowerCase().startsWith(sha));
    if (!existe) {
      hallazgos.push({
        severidad: 'bloqueante',
        tipo: 'sha_inexistente',
        detalle: `El documento cita \`${sha}\` como commit y no es prefijo de ningun commit del repositorio.`
      });
    }
  }

  // 2. La version declarada como final tiene que coincidir con el ultimo hito.
  const real = versionFinalReal(facts);
  for (const v of af.versionesFinales) {
    if (real && v !== real) {
      hallazgos.push({
        severidad: 'bloqueante',
        tipo: 'version_final_incorrecta',
        detalle: `El documento declara que la sesion termino en v${v}, pero el ultimo hito de la linea de tiempo es v${real}.`
      });
    } else if (!real && tags.size && !tags.has(v)) {
      hallazgos.push({
        severidad: 'aviso',
        tipo: 'version_sin_tag',
        detalle: `Se declara v${v} como estado final y no existe un tag con ese nombre.`
      });
    }
  }

  // 2b. La version real de cierre tiene que aparecer, si o si.
  //
  // Este es el chequeo que atrapa los fallos que de verdad ocurrieron. Los dos
  // resumenes malos no declaraban una version equivocada con una formula
  // detectable: uno decia "a lo largo de varias versiones (desde la v0.9.0
  // hasta la v0.11.8)" y el otro "se preparo el release de la version 0.9.0".
  // Ninguna frase encaja en un patron de "cerro en X", pero en ambos faltaba
  // 0.12.1, que es donde la sesion realmente termino. Exigir que la version
  // final aparezca es mecanico y no depende de como este redactada.
  if (real) {
    const apareceReal = new RegExp(`v?${real.replace(/\./g, '\\.')}\\b`).test(t);
    if (!apareceReal) {
      hallazgos.push({
        severidad: 'bloqueante',
        tipo: 'version_final_ausente',
        detalle: `La sesion termino en v${real} (ultimo hito de la linea de tiempo) y el documento no la menciona en ningun lado.`
      });
    }
  }

  // 2c. Puntos clave declarados por quien invoca: verdad de campo directa.
  for (const f of verificarPuntosClave(t, ctx.keyPoints)) {
    hallazgos.push({
      severidad: 'bloqueante',
      tipo: 'punto_clave_ausente',
      detalle: `No aparece el punto clave declarado: "${f.punto.slice(0, 140)}" (se buscaron: ${f.terminos.slice(0, 6).join(', ')}).`
    });
  }

  // 3. Cobertura: archivos que el log dice que se tocaron y el documento omite.
  const citados = new Set(af.archivosCitados.map(nombreBase));
  const omitidos = (facts.modifiedFiles || [])
    .map(nombreBase)
    .filter((b, i, arr) => arr.indexOf(b) === i)
    .filter(b => !citados.has(b) && !t.toLowerCase().includes(b));
  if (omitidos.length) {
    hallazgos.push({
      severidad: 'aviso',
      tipo: 'archivos_omitidos',
      detalle: `${omitidos.length} de ${new Set((facts.modifiedFiles || []).map(nombreBase)).size} archivos tocados no se mencionan: ${omitidos.slice(0, 12).join(', ')}${omitidos.length > 12 ? ', ...' : ''}`
    });
  }

  // 4. Fallos de herramienta registrados pero ningun veredicto negativo escrito.
  if ((facts.errors || []).length && !/(fall|error|rojo|failed)/i.test(t)) {
    hallazgos.push({
      severidad: 'aviso',
      tipo: 'fallos_no_reportados',
      detalle: `El log registra ${facts.errors.length} salidas con error y el documento no menciona ningun fallo.`
    });
  }

  const bloqueantes = hallazgos.filter(h => h.severidad === 'bloqueante').length;
  const resumen = hallazgos.length
    ? `${hallazgos.length} hallazgo(s), ${bloqueantes} bloqueante(s)`
    : 'sin hallazgos';

  return { hallazgos, bloqueantes, resumen };
}

function renderAuditoria(auditoria) {
  if (!auditoria || !auditoria.hallazgos.length) {
    return '**Verificacion mecanica:** sin hallazgos (shas, version final y cobertura de archivos comprobados contra el log y contra git).';
  }
  const lineas = [`**Verificacion mecanica:** ${auditoria.resumen}`, ''];
  for (const h of auditoria.hallazgos) {
    lineas.push(`- ${h.severidad === 'bloqueante' ? '❌' : '⚠️'} \`${h.tipo}\` — ${h.detalle}`);
  }
  return lineas.join('\n');
}

/**
 * Prompt del pase adversarial. Solo para lo que NO se puede comprobar
 * mecanicamente: fidelidad de las causas atribuidas y del veredicto de las
 * pruebas. Los hallazgos deterministas ya vienen dados, no hay que re-derivarlos.
 */
function getStrictReviewPrompt(documento, auditoria) {
  const mecanicos = auditoria && auditoria.hallazgos.length
    ? auditoria.hallazgos.map(h => `- [${h.severidad}] ${h.tipo}: ${h.detalle}`).join('\n')
    : '- (ninguno)';

  return `You are auditing a session handoff document against the session transcript that follows. You are the last check before this document is handed to someone who will act on it without access to the transcript.

A mechanical verifier already checked commit SHAs, the declared final version, and file coverage. Its findings:
${mecanicos}

Do NOT repeat that work. Your job is only what a machine cannot check:

1. **Unsupported causation.** The document says "we did X because Y". Is Y actually in the transcript, or was it inferred to make the story coherent?
2. **Test verdicts.** Every claim that something passed or failed must trace to an actual command output in the transcript. A suite reported as green that was never run green is the worst defect possible here.
3. **Invented specifics.** Numbers, counts, file names, flags, error messages stated as fact but absent from the transcript.
4. **Method rules dropped.** Invariants the session established the hard way — an ordering that must hold, a flag that must not be quoted, how a verification must be run. These are the most expensive thing to lose and the first thing summaries drop.

Output exactly two sections and nothing else:

## VEREDICTO
One line: \`APROBADO\` or \`RECHAZADO\`. Say RECHAZADO if any claim in category 1, 2 or 3 is unsupported.

## HALLAZGOS
One bullet per problem: the quoted claim, why the transcript does not support it, and the correction if the transcript gives one. If there are none, write "ninguno".

Judge only against the transcript. If the transcript does not settle something, say so rather than assuming the document is right.

---

## DOCUMENT UNDER REVIEW

${documento}`;
}

/**
 * Los puntos clave van al principio del prompt, no al final: son lo unico que
 * no se puede volver a derivar del log.
 */
function renderKeyPoints(puntos) {
  if (!puntos || !puntos.length) return '';
  const lineas = puntos.map((p, i) => `${i + 1}. ${p}`);
  return '## Key Points — declared by the agent that ran the session\n\n'
    + 'These were flagged live, by someone who was there, as the things worth keeping. They are usually method rules and invariants: findings that are diffuse in the transcript and that summaries drop first.\n\n'
    + 'Every one of them MUST appear in your document, stated explicitly and with whatever evidence the transcript gives for it. Do not compress them away, do not merge them into a general statement. A document that omits one of these has failed regardless of how good the rest is.\n\n'
    + lineas.join('\n');
}

module.exports = {
  extraerAfirmaciones,
  versionFinalReal,
  auditarDocumento,
  renderAuditoria,
  renderKeyPoints,
  terminosDistintivos,
  verificarPuntosClave,
  getStrictReviewPrompt
};
