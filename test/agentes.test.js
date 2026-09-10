/**
 * Agentes persistidos: registro (FEAT-018), estado y cliente de memoria (FEAT-024).
 *
 * Lo que más importa acá no es el camino feliz sino dos propiedades que el
 * review adversarial del RFC dejó como no negociables:
 *
 *   1. `agy --agent <nombre-inexistente>` NO falla: corre con el agente por
 *      defecto y escritura completa. Por eso `verificarResuelve` tiene que
 *      decir que no tanto cuando el agente no está en la lista como cuando no
 *      se pudo consultar la lista. Fallar cerrado es el requisito.
 *   2. Un servicio de memoria caído no puede voltear un cast. Todas las
 *      funciones de memoria devuelven `{ ok: false, motivo }` y ninguna lanza.
 *
 * El binario de agy nunca se ejecuta: se parchea `execFile` antes de requerir
 * el registro, que lo captura al cargarse.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { check, group, report } = require('./lib/assert');

// --- stub de `agy agents`, instalado antes de requerir registry.js ---
let salidaAgy = { err: null, stdout: '' };
cp.execFile = function (_bin, _args, _opts, cb) {
  setImmediate(() => cb(salidaAgy.err, salidaAgy.stdout, ''));
};

const registro = require('../mcp-server/agents/registry.js');
const estado = require('../mcp-server/agents/estado.js');
const memoria = require('../mcp-server/agents/memoria.js');

const borrar = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {} };

/** Un home falso con un SKILL instalado, para no tocar el del usuario. */
function crearHome(skills = { 'agency-code-reviewer': 'Sos un revisor. Opinás, no editás.' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentes-home-'));
  for (const [nombre, cuerpo] of Object.entries(skills)) {
    const dir = path.join(home, '.gemini', 'config', 'skills', nombre);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${nombre}\ndescription: skill de prueba\nrisk: low\n---\n\n${cuerpo}\n`,
      'utf8'
    );
  }
  return home;
}

async function main() {
  // ------------------------------------------------------------------
  await group('registro de agentes', () => {
    const home = crearHome();
    try {
      check('rechaza un nombre con separador de path', !registro.nombreValido('../evil'));
      check('rechaza un nombre vacío', !registro.nombreValido(''));
      check('rechaza un nombre con barra', !registro.nombreValido('a/b'));
      check('acepta un nombre normal', registro.nombreValido('code-reviewer'));

      check('lista el SKILL instalado',
        registro.listarSkills(home).includes('agency-code-reviewer'));

      const cuerpo = registro.leerCuerpoSkill('agency-code-reviewer', home);
      check('descarta el frontmatter del SKILL', !cuerpo.includes('risk: low'));
      check('conserva el cuerpo del SKILL', cuerpo.includes('Opinás, no editás'));

      const entrada = registro.instalarAgente('reviewer', { skill: 'agency-code-reviewer' }, home);
      const md = fs.readFileSync(entrada.agent_md, 'utf8');

      check('escribe el agent.md donde agy lo busca',
        entrada.agent_md === path.join(home, '.gemini', 'config', 'agents', 'reviewer', 'agent.md'));
      check('el frontmatter declara el nombre', /^---[\s\S]*?\nname: reviewer\n/.test(md));
      check('el cuerpo del SKILL llega al system prompt', md.includes('Opinás, no editás'));

      // Lo central del enforcement duro: las tools de escritura no están
      // declaradas, así que no existen en el contexto del agente.
      for (const prohibida of registro.TOOLS_ESCRITURA) {
        check(`read-only no declara \`${prohibida}\``, !md.includes(`- ${prohibida}`));
      }
      check('read-only sí declara view_file', md.includes('- view_file'));
      check('el agent.md avisa del límite del rol', md.includes('No editas archivos'));

      const guardado = registro.leerRegistro(home).agents.reviewer;
      check('persiste el SKILL de origen', guardado.skill === 'agency-code-reviewer');
      check('persiste que es read-only', guardado.read_only === true);

      registro.instalarAgente('escritor', { skill: 'agency-code-reviewer', readOnly: false }, home);
      const mdEscritor = fs.readFileSync(
        path.join(home, '.gemini', 'config', 'agents', 'escritor', 'agent.md'), 'utf8');
      check('un agente read/write sí declara write_to_file', mdEscritor.includes('- write_to_file'));
      check('un agente read/write no lleva el aviso de solo lectura',
        !mdEscritor.includes('No editas archivos'));

      check('desinstalar borra la definición',
        registro.desinstalarAgente('escritor', home) === true
        && !fs.existsSync(path.join(home, '.gemini', 'config', 'agents', 'escritor')));
      check('desinstalar lo saca del registro',
        registro.leerRegistro(home).agents.escritor === undefined);
      check('desinstalar algo inexistente no revienta',
        registro.desinstalarAgente('fantasma', home) === false);

      let tiro = false;
      try { registro.instalarAgente('reviewer', { skill: 'no-existe' }, home); } catch { tiro = true; }
      check('registrar con un SKILL inexistente falla', tiro);

      let tiroNombre = false;
      try { registro.instalarAgente('../fuga', { skill: 'agency-code-reviewer' }, home); } catch { tiroNombre = true; }
      check('registrar con un nombre que se escapa falla', tiroNombre);
    } finally {
      borrar(home);
    }
  });

  // ------------------------------------------------------------------
  await group('verificación contra `agy agents` (guardarrail del fail-open)', async () => {
    salidaAgy = { err: null, stdout: 'reviewer\nsecurity\n\n' };
    let res = await registro.agentesResueltos('agy');
    check('parsea la lista de nombres',
      res.ok && res.agentes.length === 2 && res.agentes[0] === 'reviewer');

    salidaAgy = { err: null, stdout: 'reviewer\n  * decorativo raro\nsecurity\n' };
    res = await registro.agentesResueltos('agy');
    check('descarta líneas que no son nombres de agente',
      res.agentes.length === 2 && !res.agentes.includes('* decorativo raro'));

    salidaAgy = { err: null, stdout: 'reviewer\n' };
    check('acepta un agente que resuelve',
      (await registro.verificarResuelve('reviewer', 'agy')).ok === true);

    const ausente = await registro.verificarResuelve('no-registrado', 'agy');
    check('rechaza un agente que agy no resuelve', ausente.ok === false);
    check('el motivo nombra los disponibles', ausente.motivo.includes('reviewer'));

    // Si no se puede consultar la lista, la única respuesta segura es que no:
    // castear igual entregaría el agente por defecto, con escritura completa.
    salidaAgy = { err: new Error('agy no está en el PATH'), stdout: '' };
    const sinAgy = await registro.verificarResuelve('reviewer', 'agy');
    check('falla cerrado cuando no se puede consultar agy', sinAgy.ok === false);
    check('el motivo explica por qué se aborta', /falla abierto/.test(sinAgy.motivo));

    salidaAgy = { err: null, stdout: '' };
  });

  // ------------------------------------------------------------------
  await group('estado del hilo entre casts', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentes-estado-'));
    try {
      check('un agente sin castear no tiene hilo', estado.hiloDe('reviewer', home) === null);

      estado.registrarCast('reviewer', { conversationId: 'conv-1', cwd: '/repo' }, home);
      check('guarda el hilo del primer cast', estado.hiloDe('reviewer', home) === 'conv-1');
      check('cuenta el cast', estado.estadoDe('reviewer', home).casts === 1);

      estado.registrarCast('reviewer', { conversationId: 'conv-1' }, home);
      check('acumula la cuenta', estado.estadoDe('reviewer', home).casts === 2);

      // Un turno que no devolvió conversation_id no puede borrar el hilo: eso
      // obligaría a re-explicarle todo al agente en el siguiente cast.
      estado.registrarCast('reviewer', {}, home);
      check('un cast sin conversation_id no pisa el hilo previo',
        estado.hiloDe('reviewer', home) === 'conv-1');

      check('olvidar el hilo devuelve true', estado.olvidarHilo('reviewer', home) === true);
      check('tras olvidar no hay hilo', estado.hiloDe('reviewer', home) === null);
      check('olvidar conserva la cuenta de casts',
        estado.estadoDe('reviewer', home).casts === 3);
      check('olvidar un agente inexistente devuelve false',
        estado.olvidarHilo('fantasma', home) === false);

      fs.writeFileSync(estado.rutaEstado(home), '{ esto no es json', 'utf8');
      check('un estado corrupto se lee como vacío en vez de reventar',
        estado.hiloDe('reviewer', home) === null);
    } finally {
      borrar(home);
    }
  });

  // ------------------------------------------------------------------
  await group('descubrimiento del servicio de memoria', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentes-mem-'));
    try {
      check('sin config no hay servicio', memoria.descubrirConfig(home) === null);

      const dir = path.join(home, '.gemini', 'config');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mcp_config.json'), JSON.stringify({
        mcpServers: {
          'mcp-memory': { url: 'http://127.0.0.1:8080/mcp', headers: { Authorization: 'Bearer x' } },
          playwright: { command: 'npx' },
          apagado: { url: 'http://127.0.0.1:1/mcp', disabled: true }
        }
      }), 'utf8');

      const config = memoria.descubrirConfig(home);
      check('encuentra la URL del servicio', config.url === 'http://127.0.0.1:8080/mcp');
      check('arrastra la cabecera de autorización', config.headers.Authorization === 'Bearer x');

      const servers = memoria.serversMcpDelUsuario(home);
      check('lista los servidores MCP alcanzables', servers.includes('playwright'));
      check('omite los deshabilitados', !servers.includes('apagado'));

      fs.writeFileSync(path.join(dir, 'mcp_config.json'), 'no json', 'utf8');
      check('un mcp_config corrupto no revienta', memoria.descubrirConfig(home) === null);
      check('y la lista de servidores queda vacía', memoria.serversMcpDelUsuario(home).length === 0);
    } finally {
      borrar(home);
    }
  });

  // ------------------------------------------------------------------
  await group('parseo del transporte MCP', () => {
    check('parsea JSON plano',
      memoria.parsearCuerpo('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}').result.ok === true);
    check('parsea SSE',
      memoria.parsearCuerpo('event: message\ndata: {"result":{"ok":true}}\n\n').result.ok === true);
    check('un cuerpo vacío da null', memoria.parsearCuerpo('') === null);
    check('un cuerpo ilegible da null', memoria.parsearCuerpo('<html>502</html>') === null);
    check('aplana el content textual',
      memoria.textoDeResultado({ content: [{ type: 'text', text: 'hola' }] }) === 'hola');
    check('ignora content no textual',
      memoria.textoDeResultado({ content: [{ type: 'image' }] }) === '');
  });

  // ------------------------------------------------------------------
  await group('memoria contra un servicio real (y contra uno caído)', async () => {
    const llamadas = [];
    let perfilDevuelto = 'Ya revisaste este repo antes, y anotaste que el modulo de auth es el mas fragil.';
    const servidor = http.createServer((req, res) => {
      let cuerpo = '';
      req.on('data', c => { cuerpo += c; });
      req.on('end', () => {
        const peticion = JSON.parse(cuerpo);
        llamadas.push(peticion);
        const responder = obj => {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: peticion.id, ...obj }));
        };
        if (peticion.method === 'initialize') {
          return responder({ result: { protocolVersion: '2024-11-05', capabilities: {} } });
        }
        if (peticion.params.name === 'get_bootstrap_profile') {
          return responder({ result: { content: [{ type: 'text', text: perfilDevuelto }] } });
        }
        return responder({ result: { content: [{ type: 'text', text: 'ok' }] } });
      });
    });

    await new Promise(r => servidor.listen(0, '127.0.0.1', r));
    const config = { url: `http://127.0.0.1:${servidor.address().port}/mcp`, headers: {} };

    try {
      const rehid = await memoria.rehidratar('reviewer', {
        config, taskSummary: 'revisá el PR', projectId: 'demo', budgetTokens: 512
      });
      check('rehidrata desde get_bootstrap_profile',
        rehid.ok && rehid.texto.includes('el modulo de auth es el mas fragil'));

      const llamadaBootstrap = llamadas.find(l => l.params && l.params.name === 'get_bootstrap_profile');
      check('usa el eje agent_id, no store',
        Array.isArray(llamadaBootstrap.params.arguments.agent_ids)
        && llamadaBootstrap.params.arguments.agent_ids[0] === 'reviewer'
        && llamadaBootstrap.params.arguments.store === undefined);
      check('respeta el budget de tokens pedido',
        llamadaBootstrap.params.arguments.budget_tokens === 512);
      check('pasa el prompt como task_summary',
        llamadaBootstrap.params.arguments.task_summary === 'revisá el PR');

      const cierre = await memoria.cerrarSesion('reviewer', { taskSummary: 'revisá el PR' }, { config });
      check('cierra la sesión del agente', cierre.ok === true);
      const llamadaCierre = llamadas.find(l => l.params && l.params.name === 'commit_session_legacy');
      check('el cierre viaja con el agent_id',
        llamadaCierre.params.arguments.agent_id === 'reviewer');

      const obs = await memoria.guardarObservacion('reviewer', 'nota', { config, projectId: 'demo' });
      check('guarda una observación', obs.ok === true);
      const llamadaObs = llamadas.find(l => l.params && l.params.name === 'memory_store');
      check('la observación lleva el tag del agente',
        llamadaObs.params.arguments.metadata.tags.includes('agent:reviewer'));

      // Descubierto en la prueba en vivo: el servicio devuelve el perfil
      // envuelto en marcadores incluso cuando no tiene nada que decir. Ese
      // cascaron no puede llegar al prompt del agente.
      perfilDevuelto = '=== BEHAVIORAL PROFILE (v1) ===\n\nBootstrap disabled. '
        + 'Set MCP_BOOTSTRAP_ENABLED=true to enable.\n=== END PROFILE ===';
      const deshabilitado = await memoria.rehidratar('reviewer', { config });
      check('un perfil con el bootstrap deshabilitado no cuenta como contexto',
        deshabilitado.ok === false);
      check('y el motivo nombra la variable del servicio',
        /MCP_BOOTSTRAP_ENABLED/.test(deshabilitado.motivo));

      perfilDevuelto = '=== BEHAVIORAL PROFILE (v1) ===\n\n=== END PROFILE ===';
      const vacio = await memoria.rehidratar('reviewer', { config });
      check('un perfil sin contenido tampoco cuenta', vacio.ok === false);

      perfilDevuelto = '=== BEHAVIORAL PROFILE (v1) ===\n\nEste reviewer ya '
        + 'aprendio que el proyecto usa commits convencionales y que las migraciones '
        + 'van siempre en su propio PR.\n=== END PROFILE ===';
      const conSustancia = await memoria.rehidratar('reviewer', { config });
      check('un perfil con contenido real si se inyecta',
        conSustancia.ok === true && conSustancia.texto.includes('commits convencionales'));
    } finally {
      await new Promise(r => servidor.close(r));
    }

    // Servicio caído: el cast tiene que poder seguir sin él.
    const muerto = { url: 'http://127.0.0.1:9/mcp', headers: {} };
    const sinServicio = await memoria.rehidratar('reviewer', { config: muerto, timeoutMs: 400 });
    check('un servicio caído no lanza, devuelve ok:false', sinServicio.ok === false);
    check('y explica el motivo', typeof sinServicio.motivo === 'string' && sinServicio.motivo.length > 0);

    const cierreMuerto = await memoria.cerrarSesion('reviewer', {}, { config: muerto, timeoutMs: 400 });
    check('el cierre también degrada en silencio', cierreMuerto.ok === false);
  });

  report();
}

main();
