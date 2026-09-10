/**
 * FEAT-018 — Estado persistido de los agentes casteados.
 *
 * Lo unico que hace falta guardar para que un agente sea "persistente" es su
 * `conversation_id`: con el, `agy --conversation <id>` continua el hilo exacto
 * de la vez anterior. El criterio acumulado no vive aca, vive en mcp-memory.
 *
 * Los estados que se guardan son los observables del RFC §4. `Corriendo` no se
 * persiste a proposito: mientras un cast corre, el propio proceso es la
 * evidencia, y un flag en disco solo sirve para quedar mintiendo si el proceso
 * muere de golpe.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function rutaEstado(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'antigravity-agents-state.json');
}

function leerEstado(homeDir = os.homedir()) {
  try {
    const datos = JSON.parse(fs.readFileSync(rutaEstado(homeDir), 'utf8'));
    return datos && typeof datos.agents === 'object' && datos.agents ? datos : { agents: {} };
  } catch {
    return { agents: {} };
  }
}

function guardarEstado(estado, homeDir = os.homedir()) {
  const ruta = rutaEstado(homeDir);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const temporal = `${ruta}.tmp`;
  fs.writeFileSync(temporal, JSON.stringify(estado, null, 2), 'utf8');
  fs.renameSync(temporal, ruta);
}

function estadoDe(nombre, homeDir = os.homedir()) {
  return leerEstado(homeDir).agents[nombre] || null;
}

/** El `conversation_id` guardado, o null si el agente nunca fue casteado. */
function hiloDe(nombre, homeDir = os.homedir()) {
  const entrada = estadoDe(nombre, homeDir);
  return (entrada && entrada.conversation_id) || null;
}

/**
 * Cierra un cast: guarda el hilo para la proxima vez y lleva la cuenta.
 * Read-modify-write con rename atomico; dos casts simultaneos del mismo agente
 * no son un caso que valga la pena bloquear, pero un archivo truncado si
 * romperia la continuidad de todos los agentes.
 */
function registrarCast(nombre, datos = {}, homeDir = os.homedir()) {
  const estado = leerEstado(homeDir);
  const previo = estado.agents[nombre] || { casts: 0 };
  estado.agents[nombre] = {
    ...previo,
    // Un cast que no devolvio conversation_id no debe borrar el hilo anterior.
    conversation_id: datos.conversationId || previo.conversation_id || null,
    estado: 'inactivo',
    ultimo_cast: new Date().toISOString(),
    ultimo_cwd: datos.cwd || previo.ultimo_cwd || null,
    casts: (previo.casts || 0) + 1
  };
  guardarEstado(estado, homeDir);
  return estado.agents[nombre];
}

/** Olvida el hilo de un agente sin tocar su memoria de largo plazo. */
function olvidarHilo(nombre, homeDir = os.homedir()) {
  const estado = leerEstado(homeDir);
  if (!estado.agents[nombre]) return false;
  estado.agents[nombre] = {
    ...estado.agents[nombre],
    conversation_id: null,
    estado: 'registrado'
  };
  guardarEstado(estado, homeDir);
  return true;
}

module.exports = {
  rutaEstado,
  leerEstado,
  guardarEstado,
  estadoDe,
  hiloDe,
  registrarCast,
  olvidarHilo
};
