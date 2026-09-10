/**
 * El lado de escritura de la memoria de un agente persistido.
 *
 * POR QUE ESTE MODULO EXISTE
 * --------------------------
 * `cast_agent` llamaba a `commit_session_legacy` con los arrays vacios, y el
 * servicio, con arrays vacios, guarda una sola observacion de tipo
 * `session_legacy`. Pero `get_bootstrap_profile` solo lee observaciones de
 * tipo `decision` y `user_correction` (mas las notas de tipo `mistake`), asi
 * que `session_legacy` no lo lee nunca nadie. El loop estaba abierto: cada
 * cast escribia una fila que la rehidratacion ignoraba, y el agente arrancaba
 * de cero para siempre.
 *
 * De los cuatro canales que acepta el servicio, solo dos sirven acá:
 *
 *   decisions        -> observacion `decision`, CON agent_id. La lee el
 *                       bootstrap con filtro estricto. Es el canal bueno.
 *   user_corrections -> observacion `user_correction`, CON agent_id. Idem.
 *   errors           -> se convierten en `mistake_note_add`, que NO recibe
 *                       agent_id. Quedan sin dueño, y el bootstrap comparte
 *                       las notas sin dueño con TODOS los agentes. Mandar
 *                       errores por acá contamina a los demas agentes, asi
 *                       que este modulo no los usa a proposito.
 *   (vacio)          -> `session_legacy`, que no se lee. Inutil.
 *
 * COMO SE OBTIENE EL CONTENIDO
 * ----------------------------
 * Se lo pedimos al propio agente, en el mismo turno: una cola estructurada al
 * final de su respuesta. Es lo mas barato (no hay segunda llamada al modelo) y
 * lo mas fiel (el agente sabe lo que concluyo mejor que un parser). A cambio
 * no es garantia: un agente puede no emitir el bloque. Por eso el parser es
 * tolerante, la ausencia no es un error, y el cast informa cuantas entradas
 * capturo — que no aparezca el dato es la señal de que el agente no colaboro.
 */

const MAX_ENTRADAS = 6;
const MAX_CARACTERES = 400;

const APERTURA = '<memoria>';
const CIERRE = '</memoria>';

/**
 * La instruccion que se le agrega al prompt del cast. Corta y al final, para
 * no correrle el foco al pedido real del usuario.
 */
function instruccionDeCierre() {
  return [
    '',
    '---',
    'Al terminar tu respuesta, y solo si aprendiste algo que te sirva la proxima',
    'vez que te convoquen sobre este proyecto, agrega un bloque final asi:',
    '',
    APERTURA,
    'decision: que concluiste :: por que',
    'correccion: lo que creias :: lo que resulto ser cierto',
    CIERRE,
    '',
    `Una entrada por linea, maximo ${MAX_ENTRADAS}. Escribi criterio reutilizable`,
    '(convenciones del proyecto, trampas conocidas, preferencias del equipo), no',
    'el resumen de lo que acabas de decir. Si no aprendiste nada nuevo, omiti el',
    'bloque entero: una memoria vacia es peor que ninguna.'
  ].join('\n');
}

function recortar(texto) {
  return String(texto || '').trim().replace(/\s+/g, ' ').slice(0, MAX_CARACTERES);
}

/**
 * Separa la respuesta visible del bloque de memoria y devuelve las entradas
 * ya con la forma que espera `commit_session_legacy`.
 *
 * Tolerante a proposito: acepta viñetas, acepta que falte el `::`, y si el
 * agente abrio el bloque sin cerrarlo toma hasta el final. Un bloque mal
 * formado no puede costarle al usuario la respuesta del agente.
 */
function extraerAprendizaje(textoCrudo) {
  const texto = String(textoCrudo || '');
  const vacio = { respuesta: texto.trim(), decisions: [], userCorrections: [] };

  const inicio = texto.lastIndexOf(APERTURA);
  if (inicio === -1) return vacio;

  const finCierre = texto.indexOf(CIERRE, inicio);
  const cuerpo = finCierre === -1
    ? texto.slice(inicio + APERTURA.length)
    : texto.slice(inicio + APERTURA.length, finCierre);

  // La respuesta visible es todo lo de afuera del bloque. Si el agente puso
  // algo despues del cierre (raro pero pasa), no se descarta.
  const antes = texto.slice(0, inicio);
  const despues = finCierre === -1 ? '' : texto.slice(finCierre + CIERRE.length);
  const respuesta = `${antes}${despues}`.trim();

  const decisions = [];
  const userCorrections = [];

  for (const lineaCruda of cuerpo.split(/\r?\n/)) {
    if (decisions.length + userCorrections.length >= MAX_ENTRADAS) break;

    const linea = lineaCruda.replace(/^\s*[-*•]\s*/, '').trim();
    if (!linea) continue;

    const separado = linea.match(/^(decision|decisi[oó]n|correccion|correcci[oó]n)\s*:\s*(.*)$/i);
    if (!separado) continue;

    const tipo = separado[1].toLowerCase().startsWith('d') ? 'decision' : 'correccion';
    const resto = separado[2];
    // El `::` es lo pedido, pero un agente que use `—` o nada igual aporta.
    const partes = resto.split(/\s*::\s*|\s+—\s+/);
    const primero = recortar(partes[0]);
    const segundo = recortar(partes.slice(1).join(' :: '));

    if (!primero) continue;
    // Una plantilla sin completar no es criterio: es el ejemplo del prompt
    // rebotando. Guardarla envenena el bootstrap de ese agente para siempre.
    if (/^(que concluiste|lo que creias)$/i.test(primero)) continue;

    if (tipo === 'decision') decisions.push({ what: primero, why: segundo });
    else userCorrections.push({ original: primero, corrected_to: segundo });
  }

  return { respuesta: respuesta || texto.trim(), decisions, userCorrections };
}

module.exports = {
  MAX_ENTRADAS,
  MAX_CARACTERES,
  instruccionDeCierre,
  extraerAprendizaje
};
