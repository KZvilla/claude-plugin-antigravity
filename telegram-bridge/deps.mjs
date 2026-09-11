#!/usr/bin/env node
/**
 * ¿Están instaladas las dependencias del bridge? Paquete por paquete.
 *
 * daemon.ps1 solo miraba que existiera la carpeta `node_modules`: una
 * incompleta pasaba el chequeo y el bot moría al arrancar con
 * `ERR_MODULE_NOT_FOUND: grammy`, sin que install ni start lo notaran. Así se
 * quedó caído una noche entera mientras `telegram_ask` seguía mandando botones.
 *
 * Sin dependencias propias, para poder correr justamente cuando faltan.
 *
 * Uso: node deps.mjs [dir]   → imprime las faltantes, una por línea.
 *   código 0: completas · 1: falta alguna · 2: no se pudo leer package.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dependencias de `dir/package.json` sin su `node_modules/<nombre>/package.json`.
 * Los paquetes con scope (`@grammyjs/auto-retry`) resuelven igual. Las
 * `optionalDependencies` no se exigen.
 */
export function faltantes(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return Object.keys(pkg.dependencies || {})
    .filter((nombre) => !fs.existsSync(path.join(dir, 'node_modules', ...nombre.split('/'), 'package.json')));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
  let lista;
  try {
    lista = faltantes(dir);
  } catch (err) {
    console.error(`[deps] No se pudo leer ${path.join(dir, 'package.json')}: ${err.message}`);
    process.exit(2);
  }
  for (const nombre of lista) console.log(nombre);
  process.exit(lista.length > 0 ? 1 : 0);
}
