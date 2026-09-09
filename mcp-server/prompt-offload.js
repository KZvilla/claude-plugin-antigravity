/**
 * Volcado de prompts grandes a fichero (evita `spawn ENAMETOOLONG`/límite de
 * argumento del SO). Extraído de mcp-server/index.js para que
 * executeAgyStreaming (agy-stream.js, FEAT-009) lo use también — encontrado
 * por auditoría adversarial (agy_audit, 2026-09-09): la primera versión de
 * executeAgyStreaming pasaba `args` directo a `spawn`, sin este volcado, así
 * que un prompt de fan-out grande hubiera fallado con `EINVAL`/`E2BIG` en
 * vez de degradar con gracia como ya hacía executeAgy.
 *
 * Módulo hoja a propósito (sin requerir index.js ni agy-stream.js): evita
 * cualquier ciclo de require entre los dos consumidores.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Por encima del límite el prompt se escribe en un fichero temporal y a agy
// se le pasa un puntero. El umbral es conservador: deja sitio para el resto
// de argumentos dentro del techo de Windows, que es el más estrecho.
const PROMPT_ARG_LIMIT = 24000;

function offloadLargePrompt(args) {
  const i = args.indexOf('-p');
  if (i === -1 || i + 1 >= args.length) return { args, cleanup: () => {} };

  const prompt = args[i + 1];
  if (typeof prompt !== 'string' || prompt.length <= PROMPT_ARG_LIMIT) {
    return { args, cleanup: () => {} };
  }

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-prompt-'));
    const file = path.join(dir, 'PROMPT.md');
    fs.writeFileSync(file, prompt, 'utf8');

    const puntero = [
      'Your instructions for this task did not fit in a command-line argument,',
      'so they were written to this file:',
      '',
      file,
      '',
      'Read that file COMPLETELY, from the first line to the last, before doing',
      'anything else. Its contents are your prompt: follow them exactly as if',
      'they had been typed here. Do not ask for confirmation and do not stop at',
      'a partial read - produce the final answer the file asks for.'
    ].join('\n');

    const nuevos = [...args];
    nuevos[i + 1] = puntero;
    nuevos.push('--add-dir', dir);

    process.stderr.write(
      `[antigravity-mcp] Prompt de ${prompt.length} caracteres por encima del limite de argumento; volcado a ${file}\n`
    );

    return {
      args: nuevos,
      cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    };
  } catch (err) {
    // Si el volcado falla, es mejor intentar el spawn y que el sistema
    // operativo de su error que tragarse la tarea en silencio.
    process.stderr.write(`[antigravity-mcp] No se pudo volcar el prompt a fichero: ${err.message}\n`);
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    return { args, cleanup: () => {} };
  }
}

module.exports = { offloadLargePrompt, PROMPT_ARG_LIMIT };
