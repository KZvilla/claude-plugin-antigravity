/**
 * FEAT-018 — Registro de agentes persistidos.
 *
 * La identidad de un agente vive en dos lados y conviene no confundirlos:
 *
 *   1. `~/.gemini/config/agents/<nombre>/agent.md` — lo lee Antigravity. Su
 *      frontmatter `tools:` es el unico enforcement duro verificado: las tools
 *      nativas que no estan listadas directamente no existen para el agente.
 *   2. `~/.claude/antigravity-agents.json` — lo lee el plugin. Guarda de que
 *      SKILL sale cada agente, si es read-only y a que proyecto pertenece.
 *
 * El registro NO vive en el frontmatter del SKILL a proposito: los `agency-*`
 * son archivos del usuario, el plugin no los distribuye, y su frontmatter
 * (`name, description, risk, source, date_added`) no declara tools.
 *
 * Advertencia central de este modulo: `agy --agent <nombre-inexistente>` NO
 * falla. Corre con el agente por defecto y las tools completas. Verificado el
 * 2026-09-10. Por eso `verificarResuelve()` no es opcional antes de castear un
 * agente que se declaro read-only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { leerJson, guardarJson } = require('./almacen.js');

/**
 * Inventario nativo observado (built-in `code-writer` de agy, 2026-09-10).
 * Lo que no esta aca no se puede pedir.
 */
const TOOLS_LECTURA = [
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
  'read_url_content',
  'search_web',
  'send_message',
  'manage_task'
];

const TOOLS_ESCRITURA = [
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'notebook_edit',
  'run_command'
];

/**
 * SEC-010 — Estas llegan siempre, se declaren o no. Con ellas el agente
 * alcanza todo el roster MCP del usuario, asi que un agente "read-only" es
 * tan read-only como ese roster. No es un bug del plugin: es el limite real
 * de la garantia, y se informa en cada cast.
 */
const TOOLS_INYECTADAS = ['call_mcp_tool', 'list_resources', 'read_resource', 'manage_task'];

function rutaRegistro(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'antigravity-agents.json');
}

function dirAgentesAgy(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'config', 'agents');
}

function dirSkills(homeDir = os.homedir()) {
  return path.join(homeDir, '.gemini', 'config', 'skills');
}

/**
 * Igual que `estado.js`: marca `_ilegible` para que quien escriba no pise un
 * archivo que no entendió. Perder el registro es peor que perder el estado —
 * un agente sin entrada deja de resolver y `cast_agent` lo rechaza (falla
 * cerrado, que es lo correcto), pero el usuario se queda sin sus registros.
 */
function leerRegistro(homeDir = os.homedir()) {
  const { datos, ilegible } = leerJson(rutaRegistro(homeDir));
  const registro = datos && typeof datos.agents === 'object' && datos.agents ? datos : { agents: {} };
  Object.defineProperty(registro, '_ilegible', { value: ilegible, enumerable: false });
  return registro;
}

function guardarRegistro(registro, homeDir = os.homedir()) {
  guardarJson(rutaRegistro(homeDir), { agents: registro.agents }, { ilegible: registro._ilegible });
}

/** Un nombre de agente es un segmento de path: nunca puede escaparse del directorio. */
function nombreValido(nombre) {
  return typeof nombre === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(nombre);
}

/** Lee el cuerpo de un SKILL, descartando su frontmatter YAML. */
function leerCuerpoSkill(nombreSkill, homeDir = os.homedir()) {
  if (!nombreValido(nombreSkill)) return null;
  const ruta = path.join(dirSkills(homeDir), nombreSkill, 'SKILL.md');
  let crudo;
  try {
    crudo = fs.readFileSync(ruta, 'utf8');
  } catch {
    return null;
  }
  const coincidencia = crudo.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return (coincidencia ? coincidencia[1] : crudo).trim();
}

function listarSkills(homeDir = os.homedir()) {
  try {
    return fs.readdirSync(dirSkills(homeDir), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => fs.existsSync(path.join(dirSkills(homeDir), n, 'SKILL.md')))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Materializa `~/.gemini/config/agents/<nombre>/agent.md`.
 *
 * El cuerpo del SKILL pasa a ser el system prompt del agente; `tools:` recorta
 * su inventario nativo. Para un agente read-only eso saca write_to_file,
 * replace_file_content y run_command del contexto — no como instruccion, sino
 * como ausencia.
 */
function instalarAgente(nombre, opciones = {}, homeDir = os.homedir()) {
  if (!nombreValido(nombre)) {
    throw new Error(`Nombre de agente invalido: "${nombre}". Solo letras, digitos, guion y guion bajo.`);
  }

  const nombreSkill = opciones.skill;
  const cuerpo = leerCuerpoSkill(nombreSkill, homeDir);
  if (!cuerpo) {
    throw new Error(`No se pudo leer el SKILL "${nombreSkill}" en ${dirSkills(homeDir)}.`);
  }

  const readOnly = opciones.readOnly !== false;
  const tools = opciones.tools && opciones.tools.length
    ? opciones.tools
    : (readOnly ? TOOLS_LECTURA : [...TOOLS_LECTURA, ...TOOLS_ESCRITURA]);

  const descripcion = (opciones.description || `Agente persistido Lagrange derivado de ${nombreSkill}`)
    .replace(/\r?\n/g, ' ')
    .slice(0, 300);

  const frontmatter = [
    '---',
    `name: ${nombre}`,
    `description: ${descripcion}`,
    'tools:',
    ...tools.map(t => `    - ${t}`),
    '---',
    ''
  ].join('\n');

  const encabezado = [
    '# Agent System Instructions',
    '',
    `Sos **${nombre}**, un agente persistido de Lagrange. Tu identidad y tu criterio`,
    'estan definidos por lo que sigue y no cambian entre invocaciones.',
    ''
  ].join('\n');

  const aviso = readOnly
    ? [
        '## Limite de tu rol',
        '',
        'No editas archivos ni ejecutas comandos: esas tools no existen en tu contexto.',
        'Tu trabajo es opinar, revisar, planificar y alertar. Si una tarea requiere',
        'escribir codigo, decilo explicitamente en tu respuesta en vez de intentarlo.',
        ''
      ].join('\n')
    : '';

  // El addendum acota un SKILL escrito para otro contexto (uno que ordena
  // correr comandos, o citar un estandar que este repo no tiene). Va al final
  // porque tiene que prevalecer sobre el cuerpo. Un re-register sin addendum
  // conserva el anterior: perderlo en silencio devolveria al agente las
  // instrucciones que se le quisieron sacar. `''` lo borra a proposito.
  const registro = leerRegistro(homeDir);
  const previo = registro.agents[nombre];
  const addendum = typeof opciones.addendum === 'string'
    ? opciones.addendum.trim()
    : (previo && previo.skill === nombreSkill && previo.addendum) || '';

  const bloqueAddendum = addendum
    ? [
        '',
        '## Adaptacion a este proyecto',
        '',
        'Lo que sigue prevalece sobre todo lo anterior cuando se contradicen.',
        '',
        addendum,
        ''
      ].join('\n')
    : '';

  const destino = path.join(dirAgentesAgy(homeDir), nombre);
  fs.mkdirSync(destino, { recursive: true });
  const rutaAgente = path.join(destino, 'agent.md');
  fs.writeFileSync(rutaAgente, `${frontmatter}\n${encabezado}${aviso}\n${cuerpo}\n${bloqueAddendum}`, 'utf8');

  registro.agents[nombre] = {
    skill: nombreSkill,
    read_only: readOnly,
    tools,
    addendum: addendum || null,
    project_id: opciones.projectId || null,
    agent_md: rutaAgente,
    registrado: new Date().toISOString()
  };
  guardarRegistro(registro, homeDir);

  return registro.agents[nombre];
}

function desinstalarAgente(nombre, homeDir = os.homedir()) {
  if (!nombreValido(nombre)) throw new Error(`Nombre de agente invalido: "${nombre}".`);
  const destino = path.join(dirAgentesAgy(homeDir), nombre);
  try { fs.rmSync(destino, { recursive: true, force: true }); } catch {}
  const registro = leerRegistro(homeDir);
  const existia = Boolean(registro.agents[nombre]);
  delete registro.agents[nombre];
  guardarRegistro(registro, homeDir);
  return existia;
}

/**
 * Le pregunta a agy que agentes resuelve de verdad. Es la unica fuente
 * confiable: el registro del plugin dice que *deberia* existir, `agy agents`
 * dice que existe.
 *
 * Los agentes con `hidden: true` (como el built-in `code-writer`) no aparecen
 * aca, lo cual esta bien: tampoco los casteamos.
 */
function agentesResueltos(agyBin, opciones = {}) {
  return new Promise(resolve => {
    execFile(agyBin, ['agents'], { timeout: opciones.timeoutMs || 10000, encoding: 'utf8' }, (err, stdout) => {
      if (err && !stdout) return resolve({ ok: false, agentes: [], motivo: err.message });
      const agentes = String(stdout || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        // La salida es una lista de nombres a secas; cualquier linea decorativa
        // que agy agregue en el futuro no pasa este filtro y no se confunde
        // con un agente.
        .filter(l => nombreValido(l));
      return resolve({ ok: true, agentes });
    });
  });
}

/**
 * El guardarrail contra el fail-open. Devuelve `{ ok }` y, cuando falla, un
 * motivo que se le pueda mostrar al usuario tal cual.
 */
async function verificarResuelve(nombre, agyBin, opciones = {}) {
  const res = await agentesResueltos(agyBin, opciones);
  if (!res.ok) {
    return {
      ok: false,
      motivo: `no se pudo consultar \`agy agents\` (${res.motivo}). Se aborta el cast: `
        + '`--agent` falla abierto y correr sin verificar entregaria un agente con escritura completa.'
    };
  }
  if (!res.agentes.includes(nombre)) {
    return {
      ok: false,
      motivo: `Antigravity no resuelve el agente "${nombre}". `
        + `Agentes disponibles: ${res.agentes.length ? res.agentes.join(', ') : '(ninguno)'}. `
        + 'Registralo con `cast_agent` action:"register" antes de castearlo.'
    };
  }
  return { ok: true };
}

/** Vista combinada: lo que el plugin cree que existe vs. lo que agy resuelve. */
async function listar(agyBin, homeDir = os.homedir()) {
  const registro = leerRegistro(homeDir);
  const res = await agentesResueltos(agyBin);
  const resueltos = new Set(res.agentes);
  return Object.entries(registro.agents).map(([nombre, entrada]) => ({
    nombre,
    ...entrada,
    resuelve: resueltos.has(nombre)
  }));
}

module.exports = {
  TOOLS_LECTURA,
  TOOLS_ESCRITURA,
  TOOLS_INYECTADAS,
  rutaRegistro,
  dirAgentesAgy,
  dirSkills,
  leerRegistro,
  guardarRegistro,
  nombreValido,
  leerCuerpoSkill,
  listarSkills,
  instalarAgente,
  desinstalarAgente,
  agentesResueltos,
  verificarResuelve,
  listar
};
