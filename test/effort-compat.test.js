/**
 * BE-015 — Compatibilidad de modelos y el flag --effort en el servidor MCP.
 *
 * Verifica que los modelos Claude, GPT-OSS y modelos con sufijo de esfuerzo
 * no reciban el flag `--effort` en los argumentos del CLI de agy, evitando
 * fallos fatales en runtime ("--effort is not supported for model").
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startServer, removeFixture } = require('./lib/mcp-client');
const { check, group, report } = require('./lib/assert');

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-effort-test-'));
  const capture = path.join(fixture, 'capture.jsonl');
  fs.writeFileSync(capture, '');

  const server = startServer({ cwd: fixture, captureFile: capture });
  await server.initialize();

  await group('omisión segura de --effort para modelos incompatibles (BE-015)', async () => {
    // 1. Claude Opus con effort high -> debe omitir --effort
    await server.callTool('agy_run', {
      prompt: 'test opus',
      model: 'claude-opus-4-6-thinking',
      effort: 'high',
      cwd: fixture
    });

    // 2. Claude Sonnet con effort low -> debe omitir --effort
    await server.callTool('agy_run', {
      prompt: 'test sonnet',
      model: 'claude-sonnet-4-6',
      effort: 'low',
      cwd: fixture
    });

    // 3. GPT-OSS con effort high -> debe omitir --effort
    await server.callTool('agy_run', {
      prompt: 'test gpt-oss',
      model: 'gpt-oss-120b-medium',
      effort: 'high',
      cwd: fixture
    });

    // 4. Gemini sufijado con effort low -> debe omitir --effort (evita conflicto)
    await server.callTool('agy_run', {
      prompt: 'test sufijado',
      model: 'gemini-3.8-flash-high',
      effort: 'low',
      cwd: fixture
    });

    // 5. Gemini base con effort high -> sí debe incluir --effort
    await server.callTool('agy_run', {
      prompt: 'test gemini base',
      model: 'gemini-3.8-flash',
      effort: 'high',
      cwd: fixture
    });

    await server.stop();

    const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    check('se ejecutaron las 5 llamadas', calls.length === 5, `esperadas 5, recibidas ${calls.length}`);

    // Call 0: Claude Opus
    check('Claude Opus no lleva --effort', !calls[0].args.includes('--effort'));
    check('Claude Opus sí lleva --model', calls[0].args.includes('--model') && calls[0].args[calls[0].args.indexOf('--model') + 1] === 'claude-opus-4-6-thinking');

    // Call 1: Claude Sonnet
    check('Claude Sonnet no lleva --effort', !calls[1].args.includes('--effort'));
    check('Claude Sonnet sí lleva --model', calls[1].args.includes('--model') && calls[1].args[calls[1].args.indexOf('--model') + 1] === 'claude-sonnet-4-6');

    // Call 2: GPT-OSS
    check('GPT-OSS no lleva --effort', !calls[2].args.includes('--effort'));
    check('GPT-OSS sí lleva --model', calls[2].args.includes('--model') && calls[2].args[calls[2].args.indexOf('--model') + 1] === 'gpt-oss-120b-medium');

    // Call 3: Gemini sufijado
    check('Gemini sufijado (-high) no lleva --effort', !calls[3].args.includes('--effort'));
    check('Gemini sufijado sí lleva --model', calls[3].args.includes('--model') && calls[3].args[calls[3].args.indexOf('--model') + 1] === 'gemini-3.8-flash-high');

    // Call 4: Gemini base
    check('Gemini base sí lleva --effort', calls[4].args.includes('--effort') && calls[4].args[calls[4].args.indexOf('--effort') + 1] === 'high');
    check('Gemini base sí lleva --model', calls[4].args.includes('--model') && calls[4].args[calls[4].args.indexOf('--model') + 1] === 'gemini-3.8-flash');
  });

  removeFixture(fixture);
  return report();
}

main().then(ok => process.exit(ok ? 0 : 1)).catch(err => {
  console.error(err);
  process.exit(1);
});
