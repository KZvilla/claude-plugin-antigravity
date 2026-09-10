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
const aprendizaje = require('../mcp-server/agents/aprendizaje.js');
const almacen = require('../mcp-server/agents/almacen.js');

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

      // Addendum: acota el SKILL, prevalece sobre él y no se pierde en silencio.
      registro.instalarAgente('esceptico', { skill: 'agency-code-reviewer', addendum: 'No corras comandos.' }, home);
      const rutaEsc = path.join(home, '.gemini', 'config', 'agents', 'esceptico', 'agent.md');
      let mdEsc = fs.readFileSync(rutaEsc, 'utf8');
      check('el addendum llega al agent.md', mdEsc.includes('No corras comandos.'));
      check('el addendum va después del cuerpo del SKILL',
        mdEsc.indexOf('No corras comandos.') > mdEsc.indexOf('Opinás, no editás'));
      check('el addendum se persiste en el registro',
        registro.leerRegistro(home).agents['esceptico'].addendum === 'No corras comandos.');

      registro.instalarAgente('esceptico', { skill: 'agency-code-reviewer' }, home);
      mdEsc = fs.readFileSync(rutaEsc, 'utf8');
      check('re-registrar sin addendum conserva el anterior', mdEsc.includes('No corras comandos.'));

      registro.instalarAgente('esceptico', { skill: 'agency-code-reviewer', addendum: '' }, home);
      mdEsc = fs.readFileSync(rutaEsc, 'utf8');
      check('addendum vacío lo borra a propósito',
        !mdEsc.includes('No corras comandos.') && registro.leerRegistro(home).agents['esceptico'].addendum === null);
      check('sin addendum no queda el encabezado de adaptación', !mdEsc.includes('Adaptacion a este proyecto'));

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

  // ------------------------------------------------------------------
  // El lado de escritura. Lo que se prueba acá es lo que estaba roto:
  // `commit_session_legacy` con arrays vacíos solo escribe una observación
  // `session_legacy`, y `get_bootstrap_profile` no lee ese tipo. Si el cast no
  // llena `decisions`, el agente no acumula nada por más que la rehidratación
  // funcione.
  // ------------------------------------------------------------------
  await group('extracción del bloque de memoria del agente', () => {
    const conBloque = [
      'El módulo de auth mezcla validación con transporte.',
      '',
      '<memoria>',
      'decision: los handlers no validan :: la validación vive en el middleware',
      '- correccion: creía que usaban JWT :: usan sesiones en Redis',
      '</memoria>'
    ].join('\n');

    const r = aprendizaje.extraerAprendizaje(conBloque);
    check('saca el bloque de la respuesta visible', !r.respuesta.includes('<memoria>'));
    check('conserva lo que el agente respondió', r.respuesta.includes('mezcla validación con transporte'));
    check('extrae la decisión', r.decisions.length === 1 && r.decisions[0].what === 'los handlers no validan');
    check('extrae el porqué de la decisión', r.decisions[0].why === 'la validación vive en el middleware');
    check('extrae la corrección aunque venga con viñeta',
      r.userCorrections.length === 1 && r.userCorrections[0].corrected_to === 'usan sesiones en Redis');

    const sinBloque = aprendizaje.extraerAprendizaje('Una respuesta común y silvestre.');
    check('sin bloque no inventa nada',
      sinBloque.decisions.length === 0 && sinBloque.userCorrections.length === 0);
    check('sin bloque la respuesta queda intacta',
      sinBloque.respuesta === 'Una respuesta común y silvestre.');

    // Un bloque abierto y no cerrado no puede costarle al usuario la respuesta.
    const roto = aprendizaje.extraerAprendizaje('Texto previo.\n<memoria>\ndecision: algo :: por algo');
    check('un bloque sin cerrar igual se parsea', roto.decisions.length === 1);
    check('y la respuesta visible sobrevive', roto.respuesta === 'Texto previo.');

    // El ejemplo del prompt rebotando envenenaría el perfil del agente.
    const plantilla = aprendizaje.extraerAprendizaje(
      'x\n<memoria>\ndecision: que concluiste :: por que\n</memoria>');
    check('descarta la plantilla sin completar', plantilla.decisions.length === 0);

    const muchas = aprendizaje.extraerAprendizaje(
      'x\n<memoria>\n' + Array.from({ length: 20 }, (_, i) => `decision: d${i} :: w${i}`).join('\n') + '\n</memoria>');
    check('corta en el máximo de entradas',
      muchas.decisions.length === aprendizaje.MAX_ENTRADAS, String(muchas.decisions.length));

    const larga = aprendizaje.extraerAprendizaje(
      'x\n<memoria>\ndecision: ' + 'a'.repeat(5000) + ' :: b\n</memoria>');
    check('recorta una entrada desmedida',
      larga.decisions[0].what.length === aprendizaje.MAX_CARACTERES);

    const basura = aprendizaje.extraerAprendizaje('x\n<memoria>\nblah blah\n\n</memoria>');
    check('ignora líneas que no son entradas', basura.decisions.length === 0);

    check('la instrucción nombra el bloque que se espera',
      aprendizaje.instruccionDeCierre().includes('<memoria>'));
  });

  await group('el cierre de sesión viaja por el canal que el bootstrap lee', async () => {
    const llamadas = [];
    const servidor = http.createServer((req, res) => {
      let cuerpo = '';
      req.on('data', c => { cuerpo += c; });
      req.on('end', () => {
        const peticion = JSON.parse(cuerpo);
        llamadas.push(peticion);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: peticion.id,
          result: peticion.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: {} }
            : { content: [{ type: 'text', text: '{"status":"recorded"}' }] }
        }));
      });
    });
    await new Promise(r => servidor.listen(0, '127.0.0.1', r));
    const config = { url: `http://127.0.0.1:${servidor.address().port}/mcp`, headers: {} };

    try {
      await memoria.cerrarSesion('reviewer', {
        sessionId: 's1',
        taskSummary: 'revisar auth',
        outcome: 'success',
        decisions: [{ what: 'los handlers no validan', why: 'vive en el middleware' }],
        userCorrections: [{ original: 'creía JWT', corrected_to: 'usan Redis' }]
      }, { config });

      const cierre = llamadas.find(l => l.params && l.params.name === 'commit_session_legacy');
      const a = cierre.params.arguments;

      check('manda las decisiones, que es el canal con agent_id que sí se relee',
        a.decisions.length === 1 && a.decisions[0].what === 'los handlers no validan');
      check('manda las correcciones', a.user_corrections.length === 1);
      // errors -> mistake_note_add, que no recibe agent_id: esas notas quedan
      // sin dueño y el bootstrap se las muestra a todos los agentes.
      check('NO manda errores, que contaminarían a los demás agentes',
        Array.isArray(a.errors) && a.errors.length === 0);
      check('el agent_id viaja, que es lo que permite el filtro estricto',
        a.agent_id === 'reviewer');
    } finally {
      await new Promise(r => servidor.close(r));
    }
  });

  // ------------------------------------------------------------------
  // Regresion de perdida de datos, encontrada por la auditoria adversarial de
  // FEAT-019 sobre codigo ya mergeado. `leerEstado` devolvia `{agents:{}}` ante
  // cualquier fallo de parseo, y como los escritores hacen read-modify-write,
  // UNA sola lectura de un archivo truncado borraba los hilos de todos los
  // demas agentes, sin un solo mensaje.
  // ------------------------------------------------------------------
  await group('un archivo ilegible no se sobrescribe (regresion de pérdida de datos)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentes-corrupto-'));
    try {
      estado.registrarCast('reviewer', { conversationId: 'conv-A' }, home);
      estado.registrarCast('security', { conversationId: 'conv-B' }, home);
      estado.registrarCast('planner', { conversationId: 'conv-C' }, home);
      check('los tres agentes tienen hilo',
        estado.hiloDe('reviewer', home) === 'conv-A' && estado.hiloDe('security', home) === 'conv-B');

      // Exactamente lo que pasa si otro proceso lo tiene a medio escribir.
      fs.writeFileSync(estado.rutaEstado(home), '{"agents": {"reviewer": {"conv', 'utf8');

      check('un estado ilegible se lee como vacío, sin reventar el cast',
        estado.hiloDe('reviewer', home) === null);

      estado.registrarCast('planner', { conversationId: 'conv-D' }, home);

      const respaldos = fs.readdirSync(path.join(home, '.claude')).filter(f => f.includes('.corrupto-'));
      check('el archivo ilegible se aparta en vez de perderse', respaldos.length === 1, JSON.stringify(respaldos));
      check('lo apartado conserva el contenido original',
        fs.readFileSync(path.join(home, '.claude', respaldos[0]), 'utf8').includes('reviewer'));
      check('el estado nuevo queda utilizable', estado.hiloDe('planner', home) === 'conv-D');
    } finally {
      borrar(home);
    }
  });

  await group('almacen: lectura y escritura de los JSON de agentes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almacen-'));
    try {
      const ruta = path.join(dir, 'sub', 'datos.json');

      const ausente = almacen.leerJson(ruta);
      check('un archivo que no existe no es ilegible',
        ausente.datos === null && ausente.ilegible === false);

      almacen.guardarJson(ruta, { agents: { a: 1 } }, {});
      check('crea el directorio que falte', fs.existsSync(ruta));
      check('lo escrito se relee', almacen.leerJson(ruta).datos.agents.a === 1);

      fs.writeFileSync(ruta, '', 'utf8');
      const vacio = almacen.leerJson(ruta);
      check('un archivo vacío tampoco es ilegible (es el caso de primera vez)',
        vacio.datos === null && vacio.ilegible === false);

      fs.writeFileSync(ruta, '{roto', 'utf8');
      check('un archivo que no parsea sí es ilegible', almacen.leerJson(ruta).ilegible === true);

      // Sin la marca, guardar pisa el archivo roto y se pierde lo que hubiera.
      almacen.guardarJson(ruta, { agents: { b: 2 } }, { ilegible: true });
      const apartados = fs.readdirSync(path.dirname(ruta)).filter(f => f.includes('.corrupto-'));
      check('con la marca, el roto se aparta', apartados.length === 1);

      // El temporal no puede ser fijo: dos escrituras concurrentes se pisan.
      const sobrantes = fs.readdirSync(path.dirname(ruta)).filter(f => f.includes('.tmp'));
      check('no deja temporales colgados', sobrantes.length === 0, JSON.stringify(sobrantes));
    } finally {
      borrar(dir);
    }
  });

  // ------------------------------------------------------------------
  await group('cast compartido entre la tool MCP y /cast de Telegram (FEAT-022)', async () => {
    const cast = require('../mcp-server/agents/cast.js');
    const home = crearHome();
    try {
      registro.instalarAgente('lector', { skill: 'agency-code-reviewer' }, home);
      registro.instalarAgente('escritor', { skill: 'agency-code-reviewer', readOnly: false }, home);

      const llamadas = [];
      const ejecutar = async (args, op) => {
        llamadas.push({ args, op });
        return { success: true, data: { response: 'ok del agente', conversation_id: 'hilo-1', duration_seconds: 2 } };
      };
      const base = { cwd: home, agyBin: 'agy', ejecutar, homeDir: home };
      const sinMemoria = { memory: false };

      let tiro = false;
      try { await cast.castear({ ...base, agyBin: undefined, agent: 'lector', prompt: 'x' }); } catch { tiro = true; }
      check('sin agyBin lanza en vez de castear sin verificar', tiro);

      let r = await cast.castear({ ...base, agent: 'fantasma', prompt: 'x', opciones: sinMemoria });
      check('un agente sin registrar no se castea', !r.ok && r.noRegistrado && llamadas.length === 0);

      r = await cast.castear({ ...base, agent: 'escritor', prompt: 'x', opciones: { ...sinMemoria, soloLectura: true } });
      check('soloLectura rechaza un agente read/write sin ejecutar nada', !r.ok && llamadas.length === 0);

      salidaAgy = { err: null, stdout: 'otro\n' };
      r = await cast.castear({ ...base, agent: 'lector', prompt: 'x', opciones: sinMemoria });
      check('si agy no resuelve el agente, no se ejecuta nada', !r.ok && llamadas.length === 0);
      check('y el resultado distingue que no llegó a ejecutarse', !('conversationId' in r));

      salidaAgy = { err: new Error('timeout'), stdout: '' };
      r = await cast.castear({ ...base, agent: 'lector', prompt: 'x', opciones: sinMemoria });
      check('si `agy agents` no responde, falla cerrado', !r.ok && llamadas.length === 0);

      salidaAgy = { err: null, stdout: 'lector\nescritor\n' };
      r = await cast.castear({ ...base, agent: 'lector', prompt: 'revisá', opciones: sinMemoria });
      const args = llamadas[0].args;
      check('pasa --agent con el nombre', args[args.indexOf('--agent') + 1] === 'lector');
      check('un read-only corre con --mode plan', args[args.indexOf('--mode') + 1] === 'plan');
      check('el primer cast no retoma ningún hilo', !args.includes('--conversation'));
      check('devuelve la respuesta del agente', r.ok && r.respuesta === 'ok del agente');
      check('guarda el hilo en el estado del agente', estado.hiloDe('lector', home) === 'hilo-1');

      await cast.castear({ ...base, agent: 'lector', prompt: 'seguí', opciones: sinMemoria });
      const args2 = llamadas[1].args;
      check('el segundo cast retoma el hilo guardado', args2[args2.indexOf('--conversation') + 1] === 'hilo-1');

      check('esHiloDeAgente reconoce el hilo de un agente', cast.esHiloDeAgente('hilo-1', home));
      check('y no uno ajeno ni uno vacío',
        !cast.esHiloDeAgente('otro-hilo', home) && !cast.esHiloDeAgente(null, home));

      await cast.castear({ ...base, agent: 'lector', prompt: 'mirá', opciones: { ...sinMemoria, alcance: 'C:/repo/front' } });
      const promptConAlcance = llamadas.at(-1).args.at(-1);
      check('con alcance, el prompt le pide leer solo la carpeta elegida',
        promptConAlcance.includes('<alcance>') && promptConAlcance.includes('C:/repo/front'));
      check('sin alcance no se agrega nada', !llamadas[0].args.at(-1).includes('<alcance>'));

      r = await cast.castear({
        ...base,
        agent: 'lector',
        prompt: 'x',
        ejecutar: async () => ({ success: false, cancelled: true, data: null, error: 'cancelado' }),
        opciones: sinMemoria
      });
      check('un cast cancelado se informa como cancelado, no como error', !r.ok && r.cancelled === true);
    } finally {
      borrar(home);
    }
  });

  report();
}

main();
