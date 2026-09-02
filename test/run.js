#!/usr/bin/env node
/** Runs every *.test.js in this directory, sequentially. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;

for (const f of files) {
  console.log(`\n${'='.repeat(60)}\n${f}\n${'='.repeat(60)}`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(failed ? `${failed}/${files.length} suites FAILED` : `all ${files.length} suites passed`);
process.exit(failed ? 1 : 0);
