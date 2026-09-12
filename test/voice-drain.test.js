/**
 * Drain del modo charla (plan-charla-latencia, A y B): el aviso previo sale
 * en cuanto empieza una herramienta, aunque no termine en punto.
 */
const { check, group, report } = require('./lib/assert');
const { SentenceChunker } = require('../mcp-server/lib/sentence-chunker');
const { PRIMING_CHARLA, PRIMING_CONFIRMACION, procesarEventosDrain } = require('../mcp-server/lib/voice-drain');

const texto = (t, i = 1) => ({ event: 'step_update', step_update: { step_index: i, state: 'ACTIVE', step_type: 'agent_response', text_delta: t } });
const tool = (nombre, i, state = 'ACTIVE') => ({ event: 'step_update', step_update: { step_index: i, state, step_type: 'tool', tool_name: nombre } });
const result = { event: 'result', result: { status: 'OK' } };

async function main() {
  await group('turno sin herramientas: igual que antes', () => {
    const r = procesarEventosDrain([texto('Hola, soy Alya y te escucho. Pregunta'), texto(' lo que quieras.'), result], new SentenceChunker());
    check('dos oraciones', JSON.stringify(r.sentences) === JSON.stringify(['Hola, soy Alya y te escucho.', 'Pregunta lo que quieras.']), JSON.stringify(r.sentences));
    check('sin herramientas', r.herramientas.length === 0);
    check('deltas expuestos', r.deltas.length === 2);
    check('resultEvent', r.resultEvent === result);
  });

  await group('aviso sin punto antes de una herramienta', () => {
    const chunker = new SentenceChunker();
    const estado = {};
    const r = procesarEventosDrain([texto('Dale, ya lo busco'), tool('search_web', 2)], chunker, estado);
    check('el aviso sale sin esperar el result', JSON.stringify(r.sentences) === JSON.stringify(['Dale, ya lo busco']), JSON.stringify(r.sentences));
    check('herramienta informada', JSON.stringify(r.herramientas) === '["search_web"]');
    check('turno no completo', r.resultEvent === null);
    const r2 = procesarEventosDrain([tool('search_web', 2, 'DONE'), texto('Encontré tres noticias sobre eso.', 3), result], chunker, estado);
    check('mismo step_index no se repite', r2.herramientas.length === 0, JSON.stringify(r2.herramientas));
    check('la respuesta llega después', JSON.stringify(r2.sentences) === JSON.stringify(['Encontré tres noticias sobre eso.']));
  });

  await group('detalle del paso: servidor MCP (plan-senales-mcp)', () => {
    // Forma real capturada de agy (2026-09-11).
    const mcp = (i, state, extra = {}) => ({ event: 'step_update', step_update: {
      step_index: i, state, step_type: 'tool', tool_name: 'call_mcp_tool',
      tool_info: { name: 'call_mcp_tool', parameters: { Arguments: { url: 'https://example.com' }, ServerName: 'playwright', ToolName: 'browser_navigate' }, ...extra }
    } });
    const estado = {};
    const r = procesarEventosDrain([mcp(13, 'ACTIVE')], new SentenceChunker(), estado);
    check('detalle con servidor y acción', JSON.stringify(r.detalles) === JSON.stringify([{ nombre: 'call_mcp_tool', servidor: 'playwright', accion: 'browser_navigate', destino: null }]), JSON.stringify(r.detalles));
    check('herramientas no cambia', JSON.stringify(r.herramientas) === '["call_mcp_tool"]');
    const r2 = procesarEventosDrain([mcp(13, 'DONE'), mcp(13, 'ERROR', { error: { type: 'TOOL_ERROR' } })], new SentenceChunker(), estado);
    check('DONE y ERROR del mismo paso no se repiten', r2.detalles.length === 0, JSON.stringify(r2.detalles));
    const r3 = procesarEventosDrain([tool('search_web', 1)], new SentenceChunker());
    check('sin tool_info: servidor, acción y destino en null', JSON.stringify(r3.detalles) === JSON.stringify([{ nombre: 'search_web', servidor: null, accion: null, destino: null }]), JSON.stringify(r3.detalles));
    const r4 = procesarEventosDrain([{ event: 'step_update', step_update: { step_index: 4, step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { error: { type: 'TOOL_ERROR' } } } }], new SentenceChunker());
    check('tool_info sin parameters no rompe', r4.detalles.length === 1 && r4.detalles[0].servidor === null);
  });

  // Formas reales de las sondas del plan-charla-modo-agente (2026-09-11).
  const paso = (i, state, nombre, parameters, error) => ({ event: 'step_update', step_update: {
    step_index: i, state, step_type: 'tool', tool_name: nombre,
    tool_info: { name: nombre, parameters, ...(error ? { error: { type: 'TOOL_ERROR', message: error } } : {}) }
  } });

  await group('negaciones de permiso (plan-charla-modo-agente)', () => {
    const cmd = { CommandLine: 'git commit -m "hola"' };
    const errCmd = 'permission check failed for command "git commit -m "hola"": user denied permission to run command:\ngit commit -m "hola"';
    const r = procesarEventosDrain([paso(2, 'ACTIVE', 'run_command', cmd), paso(2, 'ERROR', 'run_command', cmd, errCmd)], new SentenceChunker(), {});
    check('comando negado con el CommandLine entero', JSON.stringify(r.negadas) === JSON.stringify([{ tipo: 'command', objetivo: 'git commit -m "hola"' }]), JSON.stringify(r.negadas));
    check('negado en el mismo lote: no se anuncia', r.detalles.length === 0 && r.herramientas.length === 0, JSON.stringify(r.detalles));

    const mcpP = { ServerName: 'playwright', ToolName: 'browser_navigate', Arguments: { url: 'https://example.com' } };
    const errMcp = 'permission check failed for mcp "playwright/browser_navigate": user denied permission for mcp(playwright/browser_navigate)';
    const estado = {};
    const a = procesarEventosDrain([paso(11, 'ACTIVE', 'call_mcp_tool', mcpP)], new SentenceChunker(), estado);
    check('el ACTIVE solo se anuncia', a.detalles.length === 1 && a.negadas.length === 0);
    const b = procesarEventosDrain([paso(11, 'ERROR', 'call_mcp_tool', mcpP, errMcp)], new SentenceChunker(), estado);
    check('ERROR en otro drain: la negada igual se registra', JSON.stringify(b.negadas) === JSON.stringify([{ tipo: 'mcp', objetivo: 'playwright/browser_navigate' }]), JSON.stringify(b.negadas));
    const c = procesarEventosDrain([paso(11, 'ERROR', 'call_mcp_tool', mcpP, errMcp)], new SentenceChunker(), estado);
    check('la misma negada no se repite', c.negadas.length === 0);

    const u = procesarEventosDrain([paso(6, 'ERROR', 'read_url_content', { Url: 'https://nodejs.org/en' }, 'permission check failed for read_url "nodejs.org": user denied permission')], new SentenceChunker());
    check('read_url con el host', JSON.stringify(u.negadas) === JSON.stringify([{ tipo: 'read_url', objetivo: 'nodejs.org' }]), JSON.stringify(u.negadas));

    const x = procesarEventosDrain([
      paso(2, 'ERROR', 'search_web', { query: 'node' }, 'no summary returned from GenerateContent'),
      paso(4, 'ERROR', 'write_to_file', { TargetFile: 'C:\\x\\notas.txt' }, 'declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args)')
    ], new SentenceChunker());
    check('un ERROR que no es de permiso no es negada', x.negadas.length === 0 && x.detalles.length === 2, JSON.stringify(x.negadas));

    const s = {};
    procesarEventosDrain([paso(3, 'ERROR', 'run_command', cmd, errCmd)], new SentenceChunker(), s);
    procesarEventosDrain([result], new SentenceChunker(), s);
    const s2 = procesarEventosDrain([paso(3, 'ERROR', 'run_command', cmd, errCmd)], new SentenceChunker(), s);
    check('el result limpia: el turno siguiente vuelve a registrar', s2.negadas.length === 1);
  });

  await group('escrituras que agy no frena', () => {
    const w = (i, destino, state = 'DONE', nombre = 'write_to_file') => paso(i, state, nombre, { TargetFile: destino });
    const estado = {};
    const r = procesarEventosDrain([
      w(1, 'C:\\vs work\\repo\\notas.txt', 'ACTIVE'), w(1, 'C:\\vs work\\repo\\notas.txt'),
      w(2, 'C:\\Users\\u\\.gemini\\antigravity-cli\\brain\\abc\\plan.md'),
      w(3, 'C:\\Users\\u\\.gemini\\antigravity-cli\\scratch\\x.txt'),
      w(4, '/home/u/repo/a.js', 'DONE', 'replace_file_content')
    ], new SentenceChunker(), estado);
    check('solo las del usuario, una vez', JSON.stringify(r.escrituras) === JSON.stringify(['C:\\vs work\\repo\\notas.txt', '/home/u/repo/a.js']), JSON.stringify(r.escrituras));
    check('el detalle trae el destino', r.detalles[0].destino === 'C:\\vs work\\repo\\notas.txt', JSON.stringify(r.detalles));
    const r2 = procesarEventosDrain([w(1, 'C:\\vs work\\repo\\notas.txt')], new SentenceChunker(), estado);
    check('el DONE repetido no se vuelve a contar', r2.escrituras.length === 0);
  });

  await group('priming con freno', () => {
    check('pide intentar y no pedir permiso', /intentalo directamente/.test(PRIMING_CONFIRMACION) && /no expliques ni pidas permiso/.test(PRIMING_CONFIRMACION));
    check('escrituras por terminal', /con comandos de terminal/.test(PRIMING_CONFIRMACION));
    check('no prohíbe planificar ni actuar', !/ni planifiques/.test(PRIMING_CONFIRMACION));
    check('mantiene la confirmación OK', /OK\.$/.test(PRIMING_CONFIRMACION));
    check('el priming sin freno no cambia', /No escribas, edites ni planifiques archivos/.test(PRIMING_CHARLA));
  });

  await group('ignora el eco y lo que no es texto del agente', () => {
    const r = procesarEventosDrain([{ event: 'step_update', step_update: { step_type: 'user_input', text_delta: 'ECO' } }, result], new SentenceChunker());
    check('sin oraciones', r.sentences.length === 0, JSON.stringify(r.sentences));
  });

  await group('priming sin narración (v2)', () => {
    check('pide no anunciar ni narrar los pasos', /no anuncies lo que vas a hacer/.test(PRIMING_CHARLA) && /ni narres tus pasos/.test(PRIMING_CHARLA));
    check('ya no pide avisar antes de la herramienta', !/antes decí/.test(PRIMING_CHARLA));
    check('mantiene la confirmación OK', /OK\.$/.test(PRIMING_CHARLA));
  });

  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
