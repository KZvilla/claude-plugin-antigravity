#!/usr/bin/env node
/**
 * Estampa en `.claude-plugin/marketplace.json` el sha del tag de la version
 * declarada en `.claude-plugin/plugin.json`.
 *
 * El pinning por sha es lo que hace el marketplace oficial, y es la parte del
 * procedimiento de release donde un error no da la cara: un sha viejo publica
 * la version anterior sin que nada falle. Por eso se automatiza en lugar de
 * copiarlo a mano.
 *
 *   node scripts/stamp-release.mjs            comprueba y estampa
 *   node scripts/stamp-release.mjs --check    solo comprueba, no escribe
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_JSON = path.join(raiz, '.claude-plugin', 'plugin.json');
const MARKET_JSON = path.join(raiz, '.claude-plugin', 'marketplace.json');
const soloComprobar = process.argv.includes('--check');

function git(...args) {
  return execFileSync('git', args, { cwd: raiz, encoding: 'utf8' }).trim();
}

function fallar(mensaje) {
  console.error(`[stamp-release] ${mensaje}`);
  process.exit(1);
}

const plugin = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8'));
const version = plugin.version;
const tag = `v${version}`;

let sha;
try {
  // `^{commit}` desreferencia un tag anotado: sin eso se obtiene el sha del
  // objeto tag, que no es el del commit y no resuelve como referencia de clone.
  sha = git('rev-parse', `${tag}^{commit}`);
} catch {
  fallar(`El tag ${tag} no existe. Crealo primero: git tag -a ${tag} -m "..."`);
}

if (!/^[0-9a-f]{40}$/.test(sha)) fallar(`Sha inesperado para ${tag}: ${sha}`);

// Un tag que no apunta a un commit alcanzable desde la rama publicada da un
// marketplace que referencia algo que nadie puede clonar.
const contenido = git('branch', '--contains', sha, '--all');
if (!contenido.trim()) fallar(`El commit ${sha} no pertenece a ninguna rama.`);

const market = JSON.parse(fs.readFileSync(MARKET_JSON, 'utf8'));
const entrada = market.plugins.find((p) => p.name === plugin.name);
if (!entrada) fallar(`No hay entrada para "${plugin.name}" en marketplace.json.`);

// La url sale del remoto, no de una constante: si el repositorio se mueve, el
// manifiesto lo sigue en lugar de apuntar en silencio al sitio equivocado.
let url = git('remote', 'get-url', 'origin')
  .replace(/^git@github\.com:/, 'https://github.com/');
if (!url.endsWith('.git')) url += '.git';

// `source: "url"` con solo `sha`, sin `ref` ni `path`: es la forma que usan las
// 153 entradas del marketplace oficial cuyo plugin es la raiz del repositorio.
const deseado = { source: 'url', url, sha };

const yaEstaba = JSON.stringify(entrada.source) === JSON.stringify(deseado)
  && entrada.version === version
  && market.metadata?.version === version;

if (yaEstaba) {
  console.log(`[stamp-release] Ya al dia: ${tag} -> ${sha}`);
  process.exit(0);
}

if (soloComprobar) {
  fallar(`marketplace.json no apunta a ${tag} (${sha}). Ejecuta: npm run release:stamp`);
}

entrada.version = version;
entrada.source = deseado;
if (market.metadata) market.metadata.version = version;

fs.writeFileSync(MARKET_JSON, `${JSON.stringify(market, null, 2)}\n`, 'utf8');
console.log(`[stamp-release] marketplace.json -> ${tag} (${sha})`);
console.log('[stamp-release] Recuerda: el sha solo resuelve para terceros una vez empujado el tag.');
