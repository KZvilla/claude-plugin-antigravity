/**
 * FEAT-023 — Los datos que alimentan la pestaña `/agents` del visor.
 *
 * QUE MUESTRA Y QUE NO
 * --------------------
 * El RFC original pedía cuatro cosas para esta vista. Dos siguen en pie y dos
 * murieron, y conviene que quede escrito para que nadie las busque:
 *
 *   ✅ Matriz de identidades — registro + si `agy agents` lo resuelve.
 *   ✅ Criterio acumulado — las decisiones y correcciones que el agente fue
 *      dejando en mcp-memory. Es lo unico de esta vista que la terminal no
 *      puede dar comodo, y por eso es el centro de la pagina.
 *   ❌ Decision gates interactivos — `FEAT-019` se descarto; no hay ninguna
 *      escalacion que resolver.
 *   ❌ Estado "corriendo" en vivo — `cast_agent` es sincronico dentro del
 *      servidor MCP y no deja rastro en disco mientras corre, asi que ningun
 *      otro proceso puede saberlo. Los estados observables son los del §4 del
 *      RFC y ninguno es "corriendo".
 *
 * Nada de esto toca `agy` ni la memoria por su cuenta: el llamador decide
 * cuando pedir cada cosa, porque la matriz es barata (disco) y el criterio es
 * una llamada de red con timeout.
 */

const os = require('node:os');
const registro = require('./registry.js');
const estadoAgentes = require('./estado.js');

/**
 * Estado observable de un agente. Deliberadamente pobre: son los cuatro que se
 * pueden LEER, no los que estaria bueno tener.
 */
function estadoObservable(entradaRegistro, entradaEstado) {
  if (!entradaRegistro) return 'huerfano';
  if (!entradaEstado || !entradaEstado.conversation_id) return 'registrado';
  return 'inactivo';
}

/**
 * La matriz de identidades. Solo disco y un `agy agents`; no habla con la
 * memoria.
 *
 * `resuelve: false` es el dato importante de esta tabla: un agente que el
 * registro conoce pero que Antigravity no resuelve no se puede castear, porque
 * `--agent` falla abierto y correrlo entregaria el agente por defecto con
 * escritura completa.
 */
async function matriz(agyBin, homeDir = os.homedir()) {
  const reg = registro.leerRegistro(homeDir);
  const est = estadoAgentes.leerEstado(homeDir);

  const resueltos = await registro.agentesResueltos(agyBin);
  const setResueltos = new Set(resueltos.agentes);

  const nombres = new Set([...Object.keys(reg.agents), ...Object.keys(est.agents)]);

  const agentes = [...nombres].sort().map(nombre => {
    const r = reg.agents[nombre] || null;
    const e = est.agents[nombre] || null;
    return {
      nombre,
      skill: r ? r.skill : null,
      readOnly: r ? r.read_only !== false : null,
      projectId: r ? r.project_id : null,
      tools: r ? r.tools || [] : [],
      registrado: r ? r.registrado : null,
      // Un agente con hilo guardado pero sin entrada en el registro quedo
      // huerfano (lo desregistraron sin olvidar el hilo). No es un error, pero
      // hay que verlo.
      enRegistro: Boolean(r),
      resuelve: setResueltos.has(nombre),
      conversationId: e ? e.conversation_id : null,
      casts: e ? e.casts || 0 : 0,
      ultimoCast: e ? e.ultimo_cast : null,
      ultimoCwd: e ? e.ultimo_cwd : null,
      estado: estadoObservable(r, e)
    };
  });

  return {
    agentes,
    // Si no se pudo consultar agy, `resuelve` es falso para todos y eso seria
    // una mentira alarmante. El tablero lo dice en vez de pintarlos en rojo.
    agyDisponible: resueltos.ok,
    motivoAgy: resueltos.ok ? null : resueltos.motivo,
    estadoIlegible: Boolean(est._ilegible),
    registroIlegible: Boolean(reg._ilegible)
  };
}

module.exports = { matriz, estadoObservable };
