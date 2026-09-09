#!/usr/bin/env node
/**
 * CLI standalone para pedir la detención temprana de un subagente en vuelo
 * (FEAT-012). No depende del servidor MCP: crea el centinela por tarea que
 * `executeAgy` sondea dentro de `agy_fanout` (ver mcp-server/index.js,
 * `stopCheck`, y mcp-server/fanout-estado.js, `crearLectorDeControl`).
 *
 * Uso:
 *   node fanout-stop.js <repoPath> <slug> <taskId> [motivo...]
 *
 * `repoPath` es la raíz del repositorio (donde vive `.claude/worktrees/`), NO
 * el worktree del propio subagente — son directorios distintos, y un futuro
 * pane de Windows Terminal (FEAT-010) corre con `cwd` en el worktree, así que
 * no alcanza con `process.cwd()`. Pensado para invocarse a mano desde otra
 * terminal, o desde el manejador de tecla de un pane de FEAT-010 — mismo
 * primitivo en los dos casos, sin duplicar la escritura del centinela.
 */
'use strict';
const { marcarDetencion } = require('./fanout-estado.js');

function main() {
  const [repoPath, slug, taskId, ...resto] = process.argv.slice(2);

  if (!repoPath || !slug || !taskId) {
    process.stderr.write('Uso: node fanout-stop.js <repoPath> <slug> <taskId> [motivo...]\n');
    process.exitCode = 1;
    return;
  }

  const motivo = resto.join(' ').trim() || null;
  marcarDetencion(repoPath, slug, taskId, motivo);
  process.stdout.write(`Pedido de detención registrado para \`${taskId}\` (lote \`${slug}\`).\n`);
  process.stdout.write('Se aplica en el próximo sondeo del subagente (hasta unos segundos).\n');
}

main();
