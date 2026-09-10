/**
 * FEAT-024 — Cliente MCP de memoria para el servidor del plugin.
 *
 * El servidor MCP de Lagrange es zero-dependency y hasta ahora no hablaba con
 * `mcp-memory` en absoluto. `cast_agent` necesita dos cosas de ese servicio:
 * rehidratar el criterio acumulado de un agente antes de castearlo, y cerrar
 * la sesion cuando el turno termina.
 *
 * Regla de oro de este modulo: NUNCA tirar una excepcion hacia el camino del
 * cast. Un servicio de memoria caido degrada la calidad del cast, no lo
 * cancela. Todas las funciones publicas devuelven `null` o un objeto con
 * `{ ok: false, motivo }` y dejan que el llamador siga.
 *
 * Transporte: Streamable HTTP (MCP 2024-11-05). El servicio responde tanto
 * `application/json` como `text/event-stream` segun el momento, asi que se
 * parsean los dos.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT_MS_POR_DEFECTO = 8000;
const NOMBRE_SERVIDOR = 'mcp-memory';

/**
 * Descubre donde vive el servicio de memoria.
 *
 * Prioridad:
 *   1. Variables de entorno (LAGRANGE_MEMORY_URL / LAGRANGE_MEMORY_TOKEN).
 *   2. ~/.gemini/config/mcp_config.json, que es donde agy ya lo tiene
 *      configurado. Se lee, no se escribe: es infraestructura del usuario.
 *
 * El token vive solo en memoria del proceso. No se persiste ni se loguea.
 */
function descubrirConfig(homeDir = os.homedir()) {
  if (process.env.LAGRANGE_MEMORY_URL) {
    const headers = {};
    if (process.env.LAGRANGE_MEMORY_TOKEN) {
      headers.Authorization = `Bearer ${process.env.LAGRANGE_MEMORY_TOKEN}`;
    }
    return { url: process.env.LAGRANGE_MEMORY_URL, headers, origen: 'env' };
  }

  const rutaConfig = path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
  let crudo;
  try {
    crudo = fs.readFileSync(rutaConfig, 'utf8');
  } catch {
    return null;
  }

  let datos;
  try {
    datos = JSON.parse(crudo);
  } catch {
    return null;
  }

  const entrada = datos && datos.mcpServers && datos.mcpServers[NOMBRE_SERVIDOR];
  if (!entrada) return null;

  // El servicio se declara con `url` (y a veces `serverUrl`, como voicebox).
  const url = entrada.url || entrada.serverUrl;
  if (!url || !/^https?:\/\//i.test(url)) return null;

  return { url, headers: { ...(entrada.headers || {}) }, origen: rutaConfig };
}

/**
 * El transporte devuelve JSON plano o un stream SSE con `data:` por linea.
 * Se acepta cualquiera de los dos en vez de asumir uno: cual llega depende
 * del Accept negociado y de la version del servicio.
 */
function parsearCuerpo(texto) {
  const limpio = (texto || '').trim();
  if (!limpio) return null;

  if (limpio.startsWith('{')) {
    try { return JSON.parse(limpio); } catch { return null; }
  }

  for (const linea of limpio.split(/\r?\n/)) {
    if (!linea.startsWith('data:')) continue;
    const carga = linea.slice(5).trim();
    if (!carga || carga === '[DONE]') continue;
    try { return JSON.parse(carga); } catch { /* seguir buscando */ }
  }
  return null;
}

/**
 * Una sesion MCP contra el servicio. Se abre por cast y se descarta: mantener
 * la sesion viva entre casts no compensa la complejidad de invalidarla.
 */
class ClienteMemoria {
  constructor(config, opciones = {}) {
    this.config = config;
    this.timeoutMs = opciones.timeoutMs || TIMEOUT_MS_POR_DEFECTO;
    this.sessionId = null;
    this.siguienteId = 1;
    this.inicializado = false;
    this.ultimoError = null;
  }

  async _post(cuerpo) {
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), this.timeoutMs);
    try {
      const cabeceras = {
        'content-type': 'application/json',
        // Pedir los dos formatos: el servicio elige.
        accept: 'application/json, text/event-stream',
        ...this.config.headers
      };
      if (this.sessionId) cabeceras['mcp-session-id'] = this.sessionId;

      const respuesta = await fetch(this.config.url, {
        method: 'POST',
        headers: cabeceras,
        body: JSON.stringify(cuerpo),
        signal: controlador.signal
      });

      const nuevaSesion = respuesta.headers.get('mcp-session-id');
      if (nuevaSesion) this.sessionId = nuevaSesion;

      if (!respuesta.ok) {
        this.ultimoError = `HTTP ${respuesta.status}`;
        return null;
      }

      return parsearCuerpo(await respuesta.text());
    } catch (err) {
      this.ultimoError = err.name === 'AbortError'
        ? `sin respuesta en ${this.timeoutMs}ms`
        : err.message;
      return null;
    } finally {
      clearTimeout(reloj);
    }
  }

  async inicializar() {
    if (this.inicializado) return true;
    const res = await this._post({
      jsonrpc: '2.0',
      id: this.siguienteId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lagrange-cast', version: '1.0.0' }
      }
    });
    if (!res || !res.result) return false;
    this.inicializado = true;
    return true;
  }

  async llamar(nombreTool, argumentos) {
    if (!(await this.inicializar())) return null;
    const res = await this._post({
      jsonrpc: '2.0',
      id: this.siguienteId++,
      method: 'tools/call',
      params: { name: nombreTool, arguments: argumentos }
    });
    if (!res) return null;
    if (res.error) {
      this.ultimoError = res.error.message || 'error del servicio';
      return null;
    }
    return res.result || null;
  }
}

/** Aplana el `content` de un resultado MCP a texto plano. */
function textoDeResultado(resultado) {
  if (!resultado || !Array.isArray(resultado.content)) return '';
  return resultado.content
    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n')
    .trim();
}

/**
 * BE-015 — Rehidratacion. No se construye un motor propio: el servicio ya
 * expone `get_bootstrap_profile`, que arma el perfil de comportamiento de un
 * agente respetando un budget de tokens. Reimplementarlo con memory_search +
 * memory_list seria peor y mas caro.
 *
 * Devuelve `{ ok: true, texto }`, o `{ ok: false, motivo }` si no hay servicio.
 * Nunca lanza.
 */
async function rehidratar(agentId, opciones = {}) {
  const config = opciones.config || descubrirConfig();
  if (!config) {
    return { ok: false, motivo: 'no hay servicio de memoria configurado' };
  }

  const cliente = new ClienteMemoria(config, { timeoutMs: opciones.timeoutMs });
  const argumentos = {
    agent_ids: [agentId],
    budget_tokens: opciones.budgetTokens || 2048
  };
  if (opciones.projectId) argumentos.project_id = opciones.projectId;
  if (opciones.taskSummary) argumentos.task_summary = opciones.taskSummary;

  const resultado = await cliente.llamar('get_bootstrap_profile', argumentos);
  if (!resultado) {
    return { ok: false, motivo: cliente.ultimoError || 'sin respuesta' };
  }

  const texto = textoDeResultado(resultado);
  if (!texto) return { ok: false, motivo: 'perfil vacio' };

  const util = perfilConSustancia(texto);
  if (!util) {
    // El servicio devuelve el perfil envuelto en marcadores aunque no tenga
    // nada que decir (p. ej. con el bootstrap deshabilitado). Inyectar ese
    // cascaron en el prompt es peor que no inyectar nada: le ensucia la
    // consigna al agente y encima se lo cobra en tokens.
    return { ok: false, motivo: motivoDePerfilVacio(texto) };
  }
  return { ok: true, texto: util };
}

const MARCADORES_PERFIL = [
  /^=+\s*BEHAVIORAL PROFILE.*?=+$/im,
  /^=+\s*END PROFILE\s*=+$/im
];

/**
 * Devuelve el contenido real del perfil, o null si lo unico que vino fueron
 * marcadores y avisos del servicio.
 */
function perfilConSustancia(texto) {
  let cuerpo = texto;
  for (const marcador of MARCADORES_PERFIL) cuerpo = cuerpo.replace(marcador, '');
  cuerpo = cuerpo
    .split(/\r?\n/)
    .filter(l => !/bootstrap disabled/i.test(l))
    .filter(l => !/^\s*set\s+[A-Z_]+=.*to enable/i.test(l))
    .join('\n')
    .trim();
  // Un perfil que no llega a una frase no es criterio acumulado, es ruido.
  return cuerpo.length >= 40 ? texto.trim() : null;
}

function motivoDePerfilVacio(texto) {
  if (/bootstrap disabled/i.test(texto)) {
    return 'el servicio tiene el bootstrap deshabilitado (MCP_BOOTSTRAP_ENABLED)';
  }
  return 'el agente todavia no tiene criterio acumulado';
}

/**
 * Cierre de sesion del agente. La contraparte de `rehidratar`: lo que el
 * agente aprendio en este turno queda disponible para el proximo cast.
 */
async function cerrarSesion(agentId, datos = {}, opciones = {}) {
  const config = opciones.config || descubrirConfig();
  if (!config) return { ok: false, motivo: 'no hay servicio de memoria configurado' };

  const cliente = new ClienteMemoria(config, { timeoutMs: opciones.timeoutMs });
  const resultado = await cliente.llamar('commit_session_legacy', {
    agent_id: agentId,
    session_id: datos.sessionId || `cast_${Date.now().toString(36)}`,
    task_summary: (datos.taskSummary || '').slice(0, 2000),
    outcome: datos.outcome || 'success',
    decisions: datos.decisions || [],
    errors: datos.errors || [],
    user_corrections: datos.userCorrections || [],
    belief_updates: datos.beliefUpdates || []
  });

  if (!resultado) return { ok: false, motivo: cliente.ultimoError || 'sin respuesta' };
  return { ok: true };
}

/**
 * FEAT-020 — Una observacion suelta del agente. El aislamiento es por
 * `agent_id` (ver §3.1 del RFC): el eje `store` no sirve porque
 * get_bootstrap_profile y commit_session_legacy no lo aceptan. El tag
 * `agent:<name>` queda igual para poder filtrar a mano.
 */
async function guardarObservacion(agentId, contenido, opciones = {}) {
  const config = opciones.config || descubrirConfig();
  if (!config) return { ok: false, motivo: 'no hay servicio de memoria configurado' };

  const etiquetas = [`agent:${agentId}`, ...(opciones.tags || [])];
  if (opciones.projectId) etiquetas.push(`project:${opciones.projectId}`);

  const cliente = new ClienteMemoria(config, { timeoutMs: opciones.timeoutMs });
  const argumentos = {
    content: contenido,
    store: opciones.store || 'agents',
    metadata: { tags: etiquetas.join(','), type: opciones.tipo || 'observation' }
  };
  if (opciones.conversationId) argumentos.conversation_id = opciones.conversationId;

  const resultado = await cliente.llamar('memory_store', argumentos);
  if (!resultado) return { ok: false, motivo: cliente.ultimoError || 'sin respuesta' };
  return { ok: true };
}

/**
 * SEC-010 — Que servidores MCP alcanza un agente, sea read-only o no.
 * `call_mcp_tool` se inyecta siempre, asi que esta lista es el limite real de
 * la garantia de "solo lectura" y se le muestra al usuario en cada cast.
 */
function serversMcpDelUsuario(homeDir = os.homedir()) {
  try {
    const datos = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf8')
    );
    return Object.entries(datos.mcpServers || {})
      .filter(([, v]) => !v || v.disabled !== true)
      .map(([k]) => k)
      .sort();
  } catch {
    return [];
  }
}

module.exports = {
  descubrirConfig,
  serversMcpDelUsuario,
  rehidratar,
  cerrarSesion,
  guardarObservacion,
  // Exportados para los tests.
  ClienteMemoria,
  parsearCuerpo,
  textoDeResultado
};
