/**
 * Drain del modo charla (plan-charla-latencia, A y B): el aviso previo sale
 * en cuanto empieza una herramienta, aunque no termine en punto.
 */
const { check, group, report } = require('./lib/assert');
const { SentenceChunker } = require('../mcp-server/lib/sentence-chunker');
const { PRIMING_CHARLA, procesarEventosDrain } = require('../mcp-server/lib/voice-drain');

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
    check('detalle con servidor y acción', JSON.stringify(r.detalles) === JSON.stringify([{ nombre: 'call_mcp_tool', servidor: 'playwright', accion: 'browser_navigate' }]), JSON.stringify(r.detalles));
    check('herramientas no cambia', JSON.stringify(r.herramientas) === '["call_mcp_tool"]');
    const r2 = procesarEventosDrain([mcp(13, 'DONE'), mcp(13, 'ERROR', { error: { type: 'TOOL_ERROR' } })], new SentenceChunker(), estado);
    check('DONE y ERROR del mismo paso no se repiten', r2.detalles.length === 0, JSON.stringify(r2.detalles));
    const r3 = procesarEventosDrain([tool('search_web', 1)], new SentenceChunker());
    check('sin tool_info: servidor y acción en null', JSON.stringify(r3.detalles) === JSON.stringify([{ nombre: 'search_web', servidor: null, accion: null }]), JSON.stringify(r3.detalles));
    const r4 = procesarEventosDrain([{ event: 'step_update', step_update: { step_index: 4, step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { error: { type: 'TOOL_ERROR' } } } }], new SentenceChunker());
    check('tool_info sin parameters no rompe', r4.detalles.length === 1 && r4.detalles[0].servidor === null);
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
