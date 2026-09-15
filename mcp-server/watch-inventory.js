/**
 * FEAT-050 — Read model local-first para Lagrange Watch.
 *
 * No conoce HTTP ni HTML. El resumen solo toca disco; las fronteras lentas
 * (`agy`, Voicebox y mcp-memory) viven en funciones explícitas bajo demanda.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DIR_WORKTREES } = require('./fanout-estado.js');
const registro = require('./agents/registry.js');
const estadoAgentes = require('./agents/estado.js');
const memoriaAgentes = require('./agents/memoria.js');
const almas = require('./almas/index.js');
const voicebox = require('./voicebox-server.js');
const omnivoice = require('./omnivoice.js');

function iso(ahora = Date.now) {
  const valor = typeof ahora === 'function' ? ahora() : ahora;
  return new Date(valor).toISOString();
}

function motivoSeguro(err) {
  return String(err && err.message ? err.message : err || 'error desconocido')
    .split(/\r?\n/)[0]
    .slice(0, 300);
}

function meta(origen, disponibilidad, ahora, extra = {}) {
  return {
    origen,
    disponibilidad,
    carga: disponibilidad === 'available' ? 'loaded' : 'not_loaded',
    resolucion: 'not_applicable',
    consultado: iso(ahora),
    editable: false,
    advertencias: [],
    ...extra
  };
}

function inspeccionarLotes(repoPath) {
  const dir = path.join(repoPath, DIR_WORKTREES);
  let nombres;
  try {
    nombres = fs.readdirSync(dir).filter(n => n.startsWith('.fanout-status-') && n.endsWith('.json'));
  } catch {
    return { lotes: [], ilegibles: 0 };
  }
  const lotes = [];
  let ilegibles = 0;
  for (const nombre of nombres) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, nombre), 'utf8'));
      if (!d || typeof d.slug !== 'string' || !d.slug) throw new Error('estado inválido');
      const tareas = Object.values(d.tareas || {});
      lotes.push({
        slug: d.slug,
        iniciado: d.iniciado || null,
        actualizado: d.actualizado || null,
        terminado: d.terminado || null,
        tareas: tareas.length,
        estado: d.terminado ? 'terminado' : (tareas.some(t => t && (t.estado === 'corriendo' || t.estado === 'reintentando')) ? 'activo' : 'inactivo')
      });
    } catch {
      ilegibles++;
    }
  }
  lotes.sort((a, b) => String(b.actualizado || '').localeCompare(String(a.actualizado || '')));
  return { lotes, ilegibles };
}

function resumenLocal({ repoPath, homeDir, env = process.env, ahora = Date.now } = {}) {
  const reg = registro.leerRegistro(homeDir);
  const est = estadoAgentes.leerEstado(homeDir);
  const claves = almas.rutas.listarClaves(env);
  const hilos = almas.hilos.leerEstado(env);
  const cache = omnivoice.estadoCacheVoces(env);
  const lotes = inspeccionarLotes(repoPath);
  return {
    consultado: iso(ahora),
    lotes,
    agentes: {
      registrados: Object.keys(reg.agents).length,
      conHilo: Object.values(est.agents).filter(a => a && a.conversation_id).length,
      registro: reg._ilegible ? 'corrupt' : 'available',
      estado: est._ilegible ? 'corrupt' : 'available'
    },
    almas: {
      cantidad: claves.length,
      conHilo: Object.values(hilos.almas).filter(a => a && a.conversation_id).length,
      estado: hilos._ilegible ? 'corrupt' : 'available'
    },
    perfiles: {
      cache: cache.ilegible ? 'corrupt' : (cache.existe ? 'available' : 'missing'),
      cantidadCache: cache.datos && Array.isArray(cache.datos.perfiles) ? cache.datos.perfiles.length : 0,
      actualizado: cache.datos ? cache.datos.actualizado || null : null,
      remoto: 'not_loaded'
    }
  };
}

function listarAlmas({ env = process.env, ahora = Date.now } = {}) {
  const estado = almas.hilos.leerEstado(env);
  const items = almas.rutas.listarClaves(env).map(clave => {
    const r = almas.rutas.rutasDe(clave, env);
    let memoria = null;
    try { memoria = almas.recuerdos.leer(r.memoria, 'm'); } catch {}
    const hilo = estado.almas[clave] || null;
    return {
      clave,
      archivos: {
        alma: fs.existsSync(r.alma),
        memoria: fs.existsSync(r.memoria),
        diario: fs.existsSync(r.diario)
      },
      recuerdos: memoria ? almas.recuerdos.entradas(memoria).length : null,
      hilo: hilo ? {
        activo: Boolean(hilo.conversation_id),
        turnos: hilo.turnos || 0,
        ultimoTurno: hilo.ultimo_turno || null
      } : null,
      ...meta('LOCAL', 'available', ahora)
    };
  });
  return { ok: true, almas: items, estadoIlegible: Boolean(estado._ilegible), consultado: iso(ahora) };
}

function detalleAlma(clave, { env = process.env, ahora = Date.now } = {}) {
  almas.rutas.validarClave(clave);
  const r = almas.rutas.rutasDe(clave, env);
  if (!fs.existsSync(r.dir)) return null;
  const identidad = almas.archivos.leerTexto(r.alma);
  const memoria = almas.recuerdos.leer(r.memoria, 'm');
  const estado = almas.hilos.leerEstado(env);
  return {
    ok: true,
    clave,
    identidad,
    memoria: {
      entradas: almas.recuerdos.entradas(memoria),
      usado: almas.recuerdos.usado(memoria),
      tope: almas.recuerdos.TOPE_MEMORIA
    },
    diario: almas.diario.ultimas(clave, 20, env),
    hilo: estado.almas[clave] || null,
    estadoIlegible: Boolean(estado._ilegible),
    ...meta('LOCAL', 'available', ahora)
  };
}

function memoriaUsuario({ env = process.env, ahora = Date.now } = {}) {
  const ruta = almas.rutas.rutaUsuario(env);
  const existe = fs.existsSync(ruta);
  const modelo = almas.recuerdos.leer(ruta, 'u');
  return {
    ok: true,
    memoria: {
      entradas: almas.recuerdos.entradas(modelo),
      usado: almas.recuerdos.usado(modelo),
      tope: almas.recuerdos.TOPE_USUARIO
    },
    ...meta('LOCAL', existe ? 'available' : 'missing', ahora)
  };
}

function descripcionActual(texto) {
  const m = /^description:\s*(.*)$/m.exec(String(texto || '').replace(/\r\n/g, '\n'));
  return m ? m[1] : null;
}

function normalizarEol(texto) {
  return String(texto || '').replace(/\r\n/g, '\n');
}

async function detalleAgente(nombre, { homeDir, agyBin, ahora = Date.now, timeoutMs = 10000, agentesResueltos = registro.agentesResueltos } = {}) {
  if (!registro.nombreValido(nombre)) throw new Error('agente invalido');
  const reg = registro.leerRegistro(homeDir);
  const est = estadoAgentes.leerEstado(homeDir);
  const entrada = reg.agents[nombre] || null;
  const hilo = est.agents[nombre] || null;
  if (!entrada && !hilo) return null;

  const rutaMd = path.join(registro.dirAgentesAgy(homeDir), nombre, 'agent.md');
  let actual = null;
  try { actual = fs.readFileSync(rutaMd, 'utf8'); } catch {}
  const cuerpoSkill = entrada ? registro.leerCuerpoSkill(entrada.skill, homeDir) : null;
  let esperado = null;
  if (entrada && cuerpoSkill) {
    const readOnly = entrada.read_only !== false;
    const tools = Array.isArray(entrada.tools) && entrada.tools.length
      ? entrada.tools
      : (readOnly ? registro.TOOLS_LECTURA : [...registro.TOOLS_LECTURA, ...registro.TOOLS_ESCRITURA]);
    esperado = registro.renderizarAgentMd({
      nombre,
      nombreSkill: entrada.skill,
      cuerpo: cuerpoSkill,
      readOnly,
      tools,
      description: descripcionActual(actual),
      addendum: entrada.addendum || ''
    });
  }
  const divergente = !actual || !esperado || normalizarEol(actual) !== normalizarEol(esperado);
  const resueltos = await agentesResueltos(agyBin, { timeoutMs });
  const resuelve = resueltos.ok ? resueltos.agentes.includes(nombre) : null;
  const advertencias = [];
  if (reg._ilegible) advertencias.push('registro ilegible');
  if (est._ilegible) advertencias.push('estado de agentes ilegible');
  if (!cuerpoSkill) advertencias.push('SKILL ausente o ilegible');
  if (!actual) advertencias.push('agent.md ausente o ilegible');
  if (!resueltos.ok) advertencias.push(`agy unavailable: ${motivoSeguro(resueltos.motivo)}`);
  return {
    ok: true,
    nombre,
    registro: entrada ? {
      skill: entrada.skill || null,
      readOnly: entrada.read_only !== false,
      projectId: entrada.project_id || null,
      tools: entrada.tools || [],
      addendum: entrada.addendum || null,
      registrado: entrada.registrado || null
    } : null,
    hilo,
    skill: cuerpoSkill,
    agentMd: actual,
    materializado: Boolean(actual),
    divergente,
    resuelve,
    ...meta(actual ? 'GENERATED' : 'UNAVAILABLE', actual ? 'available' : 'missing', ahora, {
      resolucion: divergente ? 'divergent' : (resuelve === true ? 'resolved' : (resuelve === false ? 'unresolved' : 'unknown')),
      advertencias
    })
  };
}

async function criterioAgente(nombre, { homeDir, timeoutMs = 8000, ahora = Date.now, consultar = memoriaAgentes.criterioDeAgente } = {}) {
  if (!registro.nombreValido(nombre)) throw new Error('agente invalido');
  const r = await consultar(nombre, { homeDir, timeoutMs });
  return r.ok
    ? { ...r, ...meta('LIVE', 'available', ahora) }
    : { ok: false, motivo: motivoSeguro(r.motivo), ...meta('UNAVAILABLE', 'unavailable', ahora) };
}

async function bootstrapAgente(nombre, { homeDir, budgetTokens = 2048, timeoutMs = 8000, ahora = Date.now, consultar = memoriaAgentes.rehidratar } = {}) {
  if (!registro.nombreValido(nombre)) throw new Error('agente invalido');
  const entrada = registro.leerRegistro(homeDir).agents[nombre];
  if (!entrada) return null;
  const r = await consultar(nombre, {
    homeDir,
    timeoutMs,
    budgetTokens,
    projectId: entrada.project_id || undefined
  });
  return r.ok
    ? { ...r, budgetTokens, ...meta('DERIVED', 'available', ahora, { carga: 'preview' }) }
    : { ok: false, motivo: motivoSeguro(r.motivo), budgetTokens, ...meta('UNAVAILABLE', 'unavailable', ahora) };
}

async function perfilesVoicebox({ repoPath, env = process.env, voiceboxUrl, timeoutMs = 4000, ahora = Date.now,
  listar = voicebox.listarPerfiles, leerCache = omnivoice.estadoCacheVoces } = {}) {
  const sanear = perfiles => perfiles.map(p => ({
    id: p && p.id != null ? p.id : null,
    name: p && p.name != null ? p.name : null,
    language: p && (p.language || p.lang) || null,
    type: p && (p.voice_type || p.type) || null,
    description: p && p.description || null,
    personality: p && p.personality || null,
    defaultEngine: p && p.default_engine || null
  }));
  const config = voicebox.leerConfigVoicebox(repoPath, env);
  const url = voicebox.resolverUrlVoicebox({ voicebox_url: voiceboxUrl }, config, env);
  try {
    const perfiles = await listar(url, { timeout: timeoutMs });
    return { ok: true, perfiles: sanear(perfiles), ...meta('LIVE', 'available', ahora) };
  } catch (err) {
    const cache = leerCache(env);
    if (cache.datos && Array.isArray(cache.datos.perfiles) && cache.datos.perfiles.length) {
      return {
        ok: true,
        perfiles: sanear(cache.datos.perfiles),
        actualizado: cache.datos.actualizado || null,
        ...meta('CACHE', 'available', ahora, { advertencias: [motivoSeguro(err)] })
      };
    }
    return {
      ok: false,
      perfiles: [],
      motivo: cache.ilegible ? 'caché de voces ilegible' : motivoSeguro(err),
      ...meta('UNAVAILABLE', cache.ilegible ? 'corrupt' : 'unavailable', ahora)
    };
  }
}

module.exports = {
  inspeccionarLotes,
  resumenLocal,
  listarAlmas,
  detalleAlma,
  memoriaUsuario,
  detalleAgente,
  criterioAgente,
  bootstrapAgente,
  perfilesVoicebox,
  normalizarEol,
  descripcionActual
};
