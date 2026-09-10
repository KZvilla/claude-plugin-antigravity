/**
 * FEAT-022 — Orquestacion de un cast, compartida por la tool MCP `cast_agent`
 * y por el comando `/cast` del bot de Telegram.
 *
 * Vivia inline en el handler de `index.js`. Se extrajo para que el bot no la
 * duplicara: la parte que importa aca es `verificarResuelve`, el guardarrail
 * contra el fail-open de `agy --agent <inexistente>` (corre el agente por
 * defecto con escritura completa). Dos copias de ese guardarrail son dos
 * lugares donde se puede olvidar.
 *
 * Lo que este modulo NO hace: formatear para el canal, encolar, ni lanzar
 * procesos. El spawn lo hace `ejecutar`, inyectado por el llamante, que es
 * quien conoce su entorno (el bot sanea secretos; el MCP registra uso).
 *
 * Contrato de `ejecutar(cliArgs, { cwd, timeoutMinutes, onSpawn })`:
 *   → { success, data: { response, conversation_id, usage } | null,
 *       rawOutput, error, cancelled }
 * Es la forma que ya devuelve `executeAgy` del servidor MCP.
 */

const os = require('node:os');
const registro = require('./registry.js');
const estado = require('./estado.js');
const memoria = require('./memoria.js');
const aprendizaje = require('./aprendizaje.js');

/**
 * ¿Este `conversation_id` es el hilo de algun agente persistido?
 *
 * Lo usa el bot para negarse a retomar ese hilo por un camino que no pase
 * `--agent` (`/resume`, `exec_plan`, texto suelto): retomarlo asi corre el
 * agente por defecto, con escritura, sobre la conversacion de un agente que se
 * declaro de solo lectura.
 */
function esHiloDeAgente(conversationId, homeDir = os.homedir()) {
  if (!conversationId) return false;
  const agentes = estado.leerEstado(homeDir).agents;
  return Object.values(agentes).some(a => a && a.conversation_id === conversationId);
}

/**
 * Castea un agente registrado.
 *
 * Nunca lanza por un fallo del cast: devuelve `{ ok: false, error }`. Solo
 * lanza por un error de programacion del llamante (falta `agyBin` o
 * `ejecutar`), porque sin `agyBin` la verificacion no se puede hacer y seguir
 * sin ella es exactamente el fail-open que este modulo existe para evitar.
 */
async function castear({ agent, prompt, cwd, agyBin, ejecutar, homeDir = os.homedir(), opciones = {} }) {
  if (!agyBin) throw new Error('castear: falta `agyBin`, sin el no se puede verificar el agente.');
  if (typeof ejecutar !== 'function') throw new Error('castear: falta `ejecutar`.');
  if (!agent) return { ok: false, error: 'Falta el nombre del agente.' };
  if (!prompt) return { ok: false, error: 'Falta el pedido.' };

  const entrada = registro.leerRegistro(homeDir).agents[agent];
  if (!entrada) {
    return { ok: false, noRegistrado: true, error: `\`${agent}\` no esta registrado como agente persistido.` };
  }
  if (opciones.soloLectura && !entrada.read_only) {
    return {
      ok: false,
      entrada,
      error: `\`${agent}\` es read/write, y por este canal solo se castean agentes read-only.`
    };
  }

  const verificacion = await registro.verificarResuelve(agent, agyBin);
  if (!verificacion.ok) {
    return { ok: false, entrada, error: `No se casteo \`${agent}\`: ${verificacion.motivo}` };
  }

  const usarMemoria = opciones.memory !== false;
  // Solo para tests: apuntar a un servicio falso sin tocar el descubrimiento.
  const opcionesMemoria = opciones.memoriaConfig
    ? { config: opciones.memoriaConfig, timeoutMs: opciones.memoriaTimeoutMs }
    : {};
  let contexto = null;
  let motivoSinMemoria = usarMemoria ? null : 'memoria desactivada';
  if (usarMemoria) {
    const rehidratacion = await memoria.rehidratar(agent, {
      projectId: opciones.projectId || entrada.project_id || undefined,
      taskSummary: prompt,
      budgetTokens: opciones.budgetTokens,
      ...opcionesMemoria
    });
    if (rehidratacion.ok) contexto = rehidratacion.texto;
    else motivoSinMemoria = rehidratacion.motivo;
  }

  const hiloGuardado = opciones.fresh ? null : estado.hiloDe(agent, homeDir);
  const effort = opciones.effort || 'high';
  const model = opciones.model || null;
  const timeoutMinutes = opciones.timeoutMinutes || 15;

  const cliArgs = ['--output-format', 'json', '--agent', agent, '--dangerously-skip-permissions'];
  // Segunda capa para read-only: `--mode plan` si es un flag real del CLI. El
  // allowlist de tools y esto se cubren mutuamente; ninguno alcanza solo.
  if (entrada.read_only) cliArgs.push('--mode', 'plan');
  cliArgs.push('--effort', effort);
  if (model) cliArgs.push('--model', model);
  if (hiloGuardado) cliArgs.push('--conversation', hiloGuardado);

  // El contexto rehidratado va antes del pedido y marcado como tal: sin la
  // marca el agente lo lee como parte de la consigna de hoy.
  let promptCast = contexto
    ? `<contexto-recuperado>\nLo que ya sabés de trabajos anteriores:\n\n${contexto}\n</contexto-recuperado>\n\n${prompt}`
    : prompt;

  // El workspace elegido fija desde donde arranca agy, no que puede leer: no
  // hay allowlist de rutas en el CLI, y un agente read-only alcanza cualquier
  // ruta legible por el usuario (visto: arrancado en un frontend, reviso el
  // backend en WSL). Esto es una instruccion, no un control. La usa el bot,
  // donde la respuesta sale del equipo.
  if (opciones.alcance) {
    promptCast += `\n\n<alcance>\nEl usuario eligio trabajar sobre ${opciones.alcance}. `
      + 'Lee solo dentro de esa carpeta. Si para responder necesitas otra ruta (otro repo, WSL, '
      + 'tu home), no la leas: decí cual y para que, y que el usuario decida.\n</alcance>';
  }

  // Sin esto el agente no acumula nada: la cola estructurada es lo que llena
  // `decisions`, el unico canal que rehidrata con el `agent_id` puesto. Con la
  // memoria apagada no se pide: seria pagar tokens por algo que no se guarda.
  if (usarMemoria) promptCast += `\n${aprendizaje.instruccionDeCierre()}`;
  cliArgs.push('-p', promptCast);

  // Reloj de pared de ESTE turno. `duration_seconds` de agy es el acumulado de
  // toda la conversacion: con un hilo continuado, el pie llego a decir 32404 s
  // para un turno de minutos.
  const inicio = Date.now();
  const resultado = await ejecutar(cliArgs, { cwd, timeoutMinutes, onSpawn: opciones.onSpawn });
  const duracion = (Date.now() - inicio) / 1000;
  const datos = resultado.data || {};
  const hiloNuevo = datos.conversation_id || hiloGuardado || null;

  const base = {
    entrada,
    conversationId: hiloNuevo,
    continuado: Boolean(hiloGuardado),
    duracion,
    usage: datos.usage || null,
    model,
    effort,
    timeoutMinutes,
    memoria: { usada: usarMemoria, recuperada: Boolean(contexto), motivo: motivoSinMemoria, guardadas: 0 }
  };

  // El hilo se guarda incluso si el turno fallo o se cancelo: si agy llego a
  // abrir conversacion, perderla obliga a re-explicarle todo al agente.
  // Solo un turno exitoso cuenta como cast; uno fallido o cancelado guarda el
  // hilo pero no suma.
  if (hiloNuevo) {
    estado.registrarCast(agent, {
      conversationId: hiloNuevo,
      cwd,
      contar: Boolean(resultado.success && !resultado.cancelled)
    }, homeDir);
  }

  // Cancelado: no se extrae aprendizaje de una salida trunca ni se cierra la
  // sesion en la memoria. No hay un `outcome` verificado para "abortado".
  if (resultado.cancelled) {
    return { ...base, ok: false, cancelled: true, error: resultado.error || 'Cast cancelado.' };
  }
  if (!resultado.success) {
    return { ...base, ok: false, error: resultado.error || 'El cast fallo sin detalle.' };
  }

  const crudo = datos.response || resultado.rawOutput || '(sin respuesta)';
  // El bloque de memoria es plomeria: se saca de lo que ve el usuario.
  const aprendido = usarMemoria
    ? aprendizaje.extraerAprendizaje(crudo)
    : { respuesta: crudo, decisions: [], userCorrections: [] };
  // `extraidas` es lo que el agente emitio; `guardadas`, lo que la memoria
  // acepto. Antes se informaba lo primero como si fuera lo segundo.
  const extraidas = aprendido.decisions.length + aprendido.userCorrections.length;
  let guardadas = 0;
  let motivoCierre = null;

  if (usarMemoria) {
    // Best-effort: que la memoria no acepte el cierre no invalida el trabajo.
    // `errors` va vacio a proposito: el servicio los convierte en notas sin
    // `agent_id`, y el bootstrap las comparte con TODOS los agentes.
    const cierre = await memoria.cerrarSesion(agent, {
      sessionId: hiloNuevo || undefined,
      taskSummary: prompt,
      outcome: extraidas > 0 ? 'success' : 'partial',
      decisions: aprendido.decisions,
      userCorrections: aprendido.userCorrections
    }, opcionesMemoria);
    if (cierre.ok) guardadas = extraidas;
    else motivoCierre = cierre.motivo || 'la memoria no acepto el cierre';
  }

  return {
    ...base,
    ok: true,
    respuesta: aprendido.respuesta,
    memoria: { ...base.memoria, extraidas, guardadas, motivoCierre }
  };
}

module.exports = { castear, esHiloDeAgente };
