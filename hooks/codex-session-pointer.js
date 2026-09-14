#!/usr/bin/env node
const { recordCodexSession } = require('../mcp-server/session-source.js');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    recordCodexSession(JSON.parse(input || '{}'));
  } catch (error) {
    process.stderr.write(`[lagrange] Could not register Codex session source: ${error.message}\n`);
    process.exitCode = 1;
  }
});
