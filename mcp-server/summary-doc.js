/**
 * Produccion y rescate del documento de resumen de sesion.
 *
 * Vive fuera de index.js por la misma razon que session-log.js: el entrypoint
 * MCP no exporta nada, y logica sin test es como se cuela un fallo que solo se
 * ve en el resultado final.
 */
const fs = require('fs');
const path = require('path');

// Reglas comunes a todos los modos.
//
// La primera es la que mas caro salio: agy decide por su cuenta escribir el
// documento en un archivo de su directorio `brain/` y responder con un enlace.
// La herramienta guarda esa respuesta, asi que la ruta canonica termina con un
// puntero de 90 palabras a una ruta efimera en vez del resumen.
//
// La segunda ataca el otro fallo observado: resumenes que cubren el principio de
// la sesion y se comen la ultima hora. El transcript se trunca por el medio y la
// cola es lo mas reciente, asi que hay que decirlo explicitamente.
const SUMMARY_OUTPUT_RULES = `## Output Rules (mandatory):
- Output the ENTIRE document inline as your response text. Do NOT write it to a file, do NOT use any file-writing tool, and do NOT reply with a link, a path, or a note saying where it can be found. A response that points somewhere else instead of containing the document is a failed response.
- Cover the WHOLE session, from the first timestamp to the last. State the real version/state reached at the END of the session, not at the point where you stopped paying attention.
- Before writing anything, read the "Final State" section and the last entry of the "Session timeline". Those two define where the session ended. Write the document backwards from there: the ending is the part a fresh session actually inherits, the beginning is context.
- Reporting an intermediate state as if it were the final one is the single worst failure of this document, worse than being too short. If the timeline's last entry is a tag or a commit, the session ended at that version — not at an earlier one mentioned in the middle of the transcript.
- Use the "Derived Facts" section as the authoritative checklist of files and commands: every file listed there must be accounted for.

## Content Rules:
- DO NOT invent information not present in the transcript. Never invent commit SHAs, version numbers, or test counts.
- Distinguish what was MEASURED from what was ESTIMATED. If a number came from a command's output, say so; if it was an estimate made during the session, mark it as such.
- Preserve the derivation work, not just the conclusions: which approaches were tried and discarded, and why. Reconstructing that costs more than re-reading the code.
- Cite specific files, with line numbers when the transcript has them
- If something is unclear, mark it as "[unclear in transcript]"
- Write in the same language the user used in the session (if the session is in Spanish, write in Spanish)`;

// El modo handoff nacio como skill de Antigravity (bundles/claude-compact) y
// rendia mejor que este prompt con el mismo motor: la diferencia era la
// plantilla, no el modelo. Vive aca como `focus` y no como herramienta aparte
// porque dos tools que dicen "resume una sesion" degradan la seleccion — el
// mismo argumento que abre test/narrate.test.js.
function getHandoffPrompt(conDigest = false) {
  return `You are a Session Handoff Specialist. Analyze the following transcript of a Claude Code development session and produce a handoff document that lets a FRESH session resume the work with no access to this conversation.

Optimize for one reader: an agent starting cold. Anything they can get from \`git log\`, \`git diff\` or by reading the code is cheap — spend the space on what exists only in this conversation.

## Required structure (in this exact order):

# Handoff de Sesion de Claude Code

> **Sesion:** \`<session-id-short>\` | **Proyecto:** \`<cwd>\` | **Branch:** \`<git-branch>\`

### Objetivo y Resumen Ejecutivo
1-2 paragraphs: what was worked on and the state the repository ended in.

### Decisiones Tecnicas y Arquitectura
For each: context -> decision -> justification. Include invariants and rules discovered the hard way (a build flag that must not be quoted, an ordering that must hold), and alternatives that were tried and rejected, with the reason.

### Archivos Modificados / Creados
One line per file: what changed and why.

### Pruebas y Validacion
Commands actually executed and their real verdict. If a gate failed, say so with its output. Never report a test suite as passing unless the transcript shows it passing.

### Hallazgos Pendientes
Findings that exist ONLY in this conversation and are not yet written anywhere in the repository. For each: the finding, the evidence that supports it, and what it cost to derive. This is the most valuable section — if you have to cut something, cut elsewhere.

### Pendientes y Proximos Pasos
Numbered, concrete, in execution order. Mark anything already resolved during the session as done rather than listing it as pending.

### Prompt para Iniciar Nueva Sesion
A copy-paste block the user can hand to a fresh session, containing: a 3-5 line state summary, the key files, and the immediate task.

${SUMMARY_OUTPUT_RULES}${conDigest ? INSTRUCCION_DIGEST : ''}`;
}

function getSummaryPrompt(focus = 'full', conDigest = false) {
  if (focus === 'handoff') return getHandoffPrompt(conDigest);

  const focusInstructions = {
    full: 'Cover all sections thoroughly and equally.',
    decisions: 'Emphasize the "Decisions Made" section. Go deeper on rationale, alternatives considered, and trade-offs.',
    changes: 'Emphasize the "Changes Made" section. List every file with detailed change descriptions.',
    debugging: 'Emphasize the "Problems Found and Resolutions" section. Detail each bug, error, or blocker with root cause analysis.'
  };

  return `You are a Session Documentation Specialist. Analyze the following transcript of a Claude Code development session and generate a structured summary document.

## Required Sections (in this exact order):

### 1. Executive Summary
- One sentence describing the main objective of the session
- Duration and key timestamps

### 2. Decisions Made
- Numbered list of each technical or design decision
- For each: context → decision → justification

### 3. Changes Made
- Files created, modified, or deleted
- For each file: what changed and why
- If tests were run: results

### 4. Problems Found and Resolutions
- Bugs, errors, or blockers encountered during the session
- How they were resolved (or if they remain pending)

### 5. Current State and Next Steps
- What was working at the end of the session
- Explicit pending tasks
- Dependencies or blockers for continuation

### 6. Context for Continuation
- The minimum information an agent or human needs to resume work where it was left off
- Relevant environment variables, branches, or configurations

## Focus: ${focusInstructions[focus] || focusInstructions.full}

${SUMMARY_OUTPUT_RULES}
- Be thorough but bounded: the document should not exceed 500 lines${conDigest ? INSTRUCCION_DIGEST : ''}`;
}

// Red de seguridad para el modo de fallo observado: pese a la regla del prompt,
// agy puede escribir el documento en su directorio `brain/` y responder con un
// enlace. Guardar esa respuesta deja la ruta canonica con un puntero a una ruta
// efimera, y cuando ese directorio se limpia el resumen desaparece.
//
// Solo actua cuando la respuesta es corta -- un documento real nunca lo es -- y
// apunta a un .md existente. Devuelve null si no hay nada que recuperar, asi que
// el camino normal no cambia.
function recuperarDocumentoEnlazado(responseText) {
  const texto = String(responseText || '');
  if (texto.length > 2000) return null;

  const candidatos = [];
  for (const m of texto.matchAll(/file:\/\/\/?([^\s)>\]"']+\.md)/gi)) {
    candidatos.push(decodeURIComponent(m[1]));
  }
  for (const m of texto.matchAll(/(?:^|[\s(`"'])((?:[A-Za-z]:[\\/]|\/)[^\s)`"'<>]+\.md)/g)) {
    candidatos.push(m[1]);
  }

  for (const bruto of candidatos) {
    const ruta = path.normalize(bruto.replace(/^\/([A-Za-z]:)/, '$1'));
    try {
      if (!fs.statSync(ruta).isFile()) continue;
      const contenido = fs.readFileSync(ruta, 'utf8').trim();
      // Solo vale la pena si trae mas sustancia que el puntero.
      if (contenido.length > texto.length) {
        return { contenido, ruta };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// El resumen se guarda SIEMPRE en la misma ruta por sesion, asi que una
// generacion fallida pisa una buena. Paso de verdad: un handoff de 6,9 KB
// quedo reemplazado por 341 bytes con "I'm ready for your next request" --
// agy ignoro el prompt y devolvio un saludo, y la herramienta lo archivo como
// si fuera el documento.
//
// Un resumen valido es largo y tiene estructura. Si no cumple, es mejor fallar
// ruidosamente y dejar intacto lo que ya habia.
// Marcador del digest hablado. Se pide en la MISMA llamada que el documento
// porque ahi el modelo ya leyo la sesion entera.
//
// La alternativa era narrar el documento ya escrito, y esta medida: un handoff
// de 36 KB pasado a agy_say sin pulir da 1029 caracteres hablados, el 2,8% y
// cortado a media frase; con `polish`, getPolishPrompt hace slice(0, 12000), o
// sea que solo ve el primer tercio y condensa desde ahi. En los dos casos los
// pendientes y los hallazgos -- que viven al final -- nunca llegan al oido.
const MARCA_DIGEST = '## DIGEST HABLADO';

const INSTRUCCION_DIGEST = `

---

## Spoken digest (required, last section)

After the document, add one final section headed exactly \`${MARCA_DIGEST}\` containing 3 to 5 sentences meant to be HEARD, not read.

- Say where the session ended and what state it is in, then the single most important thing waiting for the next session.
- Plain spoken prose: no markdown, no bullets, no file paths, no code, no version strings read out character by character (say "cero doce uno" style only if it reads naturally, otherwise omit it).
- It must not contradict the document, and it must not add anything that is not in it.
- This section is extracted and spoken aloud; everything above it is what gets saved.`;

const MIN_LONGITUD_DOCUMENTO = 400;

/**
 * Separa el digest hablado del documento. Si el modelo no lo emitio, el
 * documento vuelve intacto y el digest es null: narrar es opcional y no debe
 * poder romper el resultado principal.
 */
function separarDigest(texto) {
  const t = String(texto || '');
  const i = t.lastIndexOf(MARCA_DIGEST);
  if (i === -1) return { documento: t.trim(), digest: null };
  const digest = t.slice(i + MARCA_DIGEST.length).trim();
  return {
    documento: t.slice(0, i).trim(),
    digest: digest || null
  };
}

function validarDocumento(texto) {
  const t = String(texto || '').trim();
  if (!t) return { ok: false, motivo: 'la respuesta vino vacia' };
  if (t.length < MIN_LONGITUD_DOCUMENTO) {
    return { ok: false, motivo: `la respuesta tiene ${t.length} caracteres, por debajo del minimo de ${MIN_LONGITUD_DOCUMENTO} para un documento` };
  }
  const encabezados = (t.match(/^#{1,4}\s+\S/gm) || []).length;
  if (encabezados < 2) {
    return { ok: false, motivo: `la respuesta trae ${encabezados} encabezado(s) markdown; un resumen estructurado tiene varios` };
  }
  return { ok: true, encabezados, longitud: t.length };
}

module.exports = {
  separarDigest,
  MARCA_DIGEST,
  getSummaryPrompt,
  getHandoffPrompt,
  recuperarDocumentoEnlazado,
  validarDocumento,
  SUMMARY_OUTPUT_RULES,
  MIN_LONGITUD_DOCUMENTO
};
