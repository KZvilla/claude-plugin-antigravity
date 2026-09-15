/** FEAT-050: read model local-first de Lagrange Watch. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, group, report } = require('./lib/assert');

const inventario = require('../mcp-server/watch-inventory.js');
const registro = require('../mcp-server/agents/registry.js');
const rutas = require('../mcp-server/almas/rutas.js');
const recuerdos = require('../mcp-server/almas/recuerdos.js');

const borrar = ruta => { try { fs.rmSync(ruta, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); } catch {} };

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-inventory-'));
  const homeDir = path.join(base, 'home');
  const repoPath = path.join(base, 'repo');
  const almasDir = path.join(base, 'almas');
  fs.mkdirSync(path.join(homeDir, '.gemini', 'config', 'skills', 'reviewer-skill'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, '.claude', 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.gemini', 'config', 'skills', 'reviewer-skill', 'SKILL.md'), '---\nname: reviewer-skill\n---\n\nRevisá con evidencia.\n');
  return { base, homeDir, repoPath, env: { HOME: homeDir, USERPROFILE: homeDir, LAGRANGE_ALMAS_DIR: almasDir, LAGRANGE_VOICEBOX_DIR: path.join(base, 'voice-state') } };
}

async function main() {
  let f = fixture();
  try {
    await group('resumen local no consulta fronteras remotas', () => {
      const r = inventario.resumenLocal({ ...f, ahora: () => 0 });
      check('responde con timestamp determinista', r.consultado === '1970-01-01T00:00:00.000Z');
      check('sin estado arranca vacío', r.agentes.registrados === 0 && r.almas.cantidad === 0 && r.lotes.lotes.length === 0);
      check('Voicebox queda not_loaded', r.perfiles.remoto === 'not_loaded');
    });

    await group('lotes saneados y corrupción visible', () => {
      const dir = path.join(f.repoPath, '.claude', 'worktrees');
      fs.writeFileSync(path.join(dir, '.fanout-status-bueno.json'), JSON.stringify({ slug: 'bueno', iniciado: 'i', actualizado: 'a', tareas: { t1: { estado: 'corriendo', prompt: 'secreto' } } }));
      fs.writeFileSync(path.join(dir, '.fanout-status-roto.json'), '{');
      const r = inventario.inspeccionarLotes(f.repoPath);
      check('solo expone resumen del lote', r.lotes.length === 1 && r.lotes[0].estado === 'activo' && !('prompt' in r.lotes[0]));
      check('cuenta ilegibles sin exponer contenido', r.ilegibles === 1);
    });

    await group('agente derivado, EOL y ruta persistida no confiable', async () => {
      registro.instalarAgente('reviewer', { skill: 'reviewer-skill', projectId: 'p1' }, f.homeDir);
      const rutaReg = registro.rutaRegistro(f.homeDir);
      const datos = JSON.parse(fs.readFileSync(rutaReg, 'utf8'));
      const trampa = path.join(f.base, 'trampa.md');
      fs.writeFileSync(trampa, 'NO LEER');
      datos.agents.reviewer.agent_md = trampa;
      fs.writeFileSync(rutaReg, JSON.stringify(datos));
      const rutaMd = path.join(registro.dirAgentesAgy(f.homeDir), 'reviewer', 'agent.md');
      fs.writeFileSync(rutaMd, fs.readFileSync(rutaMd, 'utf8').replace(/\n/g, '\r\n'));
      let r = await inventario.detalleAgente('reviewer', {
        homeDir: f.homeDir,
        agyBin: 'agy',
        agentesResueltos: async () => ({ ok: true, agentes: ['reviewer'] })
      });
      check('CRLF no diverge y agy resuelve', !r.divergente && r.resuelve === true);
      check('lee ruta derivada, no agent_md persistido', r.agentMd.includes('Revisá con evidencia') && !r.agentMd.includes('NO LEER'));
      fs.writeFileSync(path.join(f.homeDir, '.gemini', 'config', 'skills', 'reviewer-skill', 'SKILL.md'), '---\nname: reviewer-skill\n---\n\nCriterio cambiado.\n');
      r = await inventario.detalleAgente('reviewer', { homeDir: f.homeDir, agyBin: 'agy', agentesResueltos: async () => ({ ok: true, agentes: ['reviewer'] }) });
      check('cambiar el SKILL marca divergencia', r.divergente && r.resolucion === 'divergent');
    });

    await group('almas y memoria compartida quedan separadas', () => {
      const clave = 'usuario';
      const r = rutas.rutasDe(clave, f.env);
      fs.mkdirSync(r.dir, { recursive: true });
      fs.writeFileSync(r.alma, '# Usuario alma\n');
      recuerdos.aplicar(r.memoria, 'm', [{ tipo: 'agregar', texto: 'recuerdo del alma' }], recuerdos.TOPE_MEMORIA);
      recuerdos.aplicar(rutas.rutaUsuario(f.env), 'u', [{ tipo: 'agregar', texto: 'recuerdo compartido' }], recuerdos.TOPE_USUARIO);
      const lista = inventario.listarAlmas({ env: f.env });
      const compartida = inventario.memoriaUsuario({ env: f.env });
      check('usuario puede ser clave de alma', lista.almas.some(a => a.clave === 'usuario'));
      check('usuario.md usa prefijo u separado', compartida.memoria.entradas[0].id === 'u1');
    });

    await group('Voicebox live/cache sin filtrar rutas', async () => {
      const live = await inventario.perfilesVoicebox({
        ...f,
        listar: async () => [{ id: 'p1', name: 'Alya', language: 'es', sample_path: 'C:\\secreto.wav' }],
        leerCache: () => ({ datos: null, ilegible: false, existe: false })
      });
      check('live y whitelist de campos', live.origen === 'LIVE' && live.perfiles[0].name === 'Alya' && !('sample_path' in live.perfiles[0]));
      const cache = await inventario.perfilesVoicebox({
        ...f,
        listar: async () => { throw new Error('timeout'); },
        leerCache: () => ({ datos: { perfiles: [{ id: 'p2', name: 'Dora' }], actualizado: 'ayer' }, ilegible: false, existe: true })
      });
      check('fallback rotulado CACHE', cache.origen === 'CACHE' && cache.actualizado === 'ayer' && cache.advertencias[0] === 'timeout');
    });

    await group('bootstrap basal propaga home, project y budget', async () => {
      let opciones;
      const r = await inventario.bootstrapAgente('reviewer', {
        homeDir: f.homeDir,
        budgetTokens: 512,
        consultar: async (_nombre, o) => { opciones = o; return { ok: true, texto: 'perfil derivado' }; }
      });
      check('preview DERIVED', r.origen === 'DERIVED' && r.carga === 'preview');
      check('propaga contrato hermético', opciones.homeDir === f.homeDir && opciones.projectId === 'p1' && opciones.budgetTokens === 512);
    });

    await group('criterio remoto conserva degradación y truncado', async () => {
      let opciones;
      const sinConfig = await inventario.criterioAgente('reviewer', {
        homeDir: f.homeDir,
        timeoutMs: 321,
        ahora: () => 0,
        consultar: async (_nombre, o) => { opciones = o; return { ok: false, motivo: 'no hay servicio de memoria configurado' }; }
      });
      check('sin config queda UNAVAILABLE', !sinConfig.ok && sinConfig.origen === 'UNAVAILABLE' && sinConfig.disponibilidad === 'unavailable');
      check('propaga home y timeout', opciones.homeDir === f.homeDir && opciones.timeoutMs === 321);

      const timeout = await inventario.criterioAgente('reviewer', {
        consultar: async () => ({ ok: false, motivo: 'timeout al consultar memoria' })
      });
      check('timeout remoto no parece una lista vacía', !timeout.ok && timeout.motivo.includes('timeout'));

      const vacio = await inventario.criterioAgente('reviewer', {
        consultar: async () => ({ ok: true, entradas: [], truncado: false })
      });
      check('perfil vacío válido queda LIVE', vacio.ok && vacio.origen === 'LIVE' && vacio.entradas.length === 0 && !vacio.truncado);

      const valido = await inventario.criterioAgente('reviewer', {
        consultar: async () => ({ ok: true, entradas: [{ contenido: 'decisión' }], truncado: true })
      });
      check('criterio válido conserva truncado', valido.ok && valido.origen === 'LIVE' && valido.entradas.length === 1 && valido.truncado);
    });
  } finally {
    borrar(f.base);
  }

  f = fixture();
  try {
    await group('registro corrupto no se presenta como sano', () => {
      fs.mkdirSync(path.dirname(registro.rutaRegistro(f.homeDir)), { recursive: true });
      fs.writeFileSync(registro.rutaRegistro(f.homeDir), '{');
      const r = inventario.resumenLocal(f);
      check('marca corrupt', r.agentes.registro === 'corrupt');
    });
  } finally { borrar(f.base); }

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
