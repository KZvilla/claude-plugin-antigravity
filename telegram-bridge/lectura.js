/**
 * Comandos de solo lectura del bot: `/diff` (FEAT-028) y `/logs` (FEAT-029).
 *
 * Vive fuera de `bot.js` para que la parte que toca git y el disco se pueda
 * probar con `execFileSync` y `fs` inyectados, sin levantar el bot.
 *
 * `/diff` es un canal de SALIDA de contenido completo hacia Telegram, así que
 * cada ruta pasa por tres controles antes de que git la vea:
 *   1. forma: relativa, dentro del workspace, sin `:` ni `-` al inicio;
 *   2. tipo: si existe, archivo regular (ni directorio ni symlink) cuyo
 *      realpath siga dentro del workspace; si no existe, un único archivo
 *      versionado;
 *   3. `deny_paths`, sobre la ruta pedida y sobre su realpath.
 * Y toda llamada a git lleva `--literal-pathspecs`: sin eso git interpreta la
 * magia de pathspec (`:(literal).env`, `:(glob)**`) incluso después de `--`, y
 * un nombre que `deny_paths` no reconoce acababa resolviendo el `.env` real.
 * Ver docs/future-implementations/plan-rama-1-comandos-lectura.md §7.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { matchDeniedPath, redactSecrets } from './policy.js';

const OPCIONES_EXEC = {
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 5 * 1024 * 1024,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
};

/** Lo máximo que se lee de un archivo nuevo o del log: nunca el archivo entero. */
export const TOPE_LECTURA_BYTES = 64 * 1024;
export const DIFF_MAX_LINEAS = 150;
export const LOGS_POR_DEFECTO = 30;
export const LOGS_TOPE = 100;
export const UNIDAD_SYSTEMD = 'lagrange-telegram-bridge.service';

/**
 * `-c core.quotePath=false`: sin él, un nombre con acentos sale entre comillas
 * con escapes octales y no se puede comparar con la ruta pedida.
 */
function git(execFileSyncFn, cwd, args) {
  return String(execFileSyncFn(
    'git',
    ['-c', 'core.quotePath=false', '--literal-pathspecs', '-C', cwd, ...args],
    OPCIONES_EXEC
  ));
}

function rechazo(motivo) {
  return { ok: false, motivo };
}

/** Una ruta dentro de `base`, sin ser `base` misma. */
function quedaDentro(base, destino) {
  const rel = path.relative(base, destino);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Para mostrar una ruta dentro de Markdown sin romperlo. */
function codigo(texto) {
  return '`' + String(texto).replace(/`/g, '') + '`';
}

/**
 * Valida el argumento de `/diff <archivo>` y lo ancla al workspace.
 *
 * @returns {{ ok: true, abs: string, rel: string, real: string|null, existe: boolean } | { ok: false, motivo: string }}
 */
export function resolverRutaEnWorkspace(arg, workspace, { fsImpl = fs, execFileSyncFn = execFileSync } = {}) {
  const crudo = String(arg ?? '').trim();
  if (!crudo) return rechazo('Indicá un archivo, o usá /diff sin argumento para ver el resumen.');
  // En cualquier posición: cubre la magia de pathspec (`:(glob)`, `:/`) y los
  // flujos alternativos de NTFS (`a.txt:stream`). Ningún nombre versionable
  // en Windows lleva `:`.
  if (crudo.includes(':')) return rechazo('La ruta no puede contener «:».');
  if (crudo.startsWith('-')) return rechazo('La ruta no puede empezar con «-».');
  if (path.isAbsolute(crudo) || /^[\\/]/.test(crudo)) return rechazo('Usá una ruta relativa al workspace.');

  const base = path.resolve(workspace);
  const abs = path.resolve(base, crudo);
  const relNativo = path.relative(base, abs);
  if (relNativo === '') return rechazo('Esa ruta es el workspace entero: usá /diff sin argumento.');
  if (!quedaDentro(base, abs)) return rechazo('La ruta se sale del workspace.');
  const rel = relNativo.split(path.sep).join('/');

  let st = null;
  try {
    st = fsImpl.lstatSync(abs);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      return rechazo(`No se pudo inspeccionar ${codigo(rel)} (${err.code || 'error'}).`);
    }
  }

  if (st) {
    // Un symlink se lee siguiendo el enlace: `enlace.txt -> ../.env` pasaría
    // `deny_paths` por su nombre y entregaría el contenido del destino.
    if (st.isSymbolicLink()) return rechazo(`${codigo(rel)} es un enlace simbólico: /diff no los sigue.`);
    // Un directorio haría un diff recursivo de todo lo que tenga adentro,
    // `config/.env` incluido.
    if (!st.isFile()) return rechazo(`${codigo(rel)} no es un archivo: /diff solo acepta archivos.`);

    let real;
    let baseReal;
    try {
      // `.native` expande los nombres cortos 8.3 (`PROGRA~1`) que la versión JS
      // conserva y que `deny_paths` no reconocería.
      real = fsImpl.realpathSync.native(abs);
      baseReal = fsImpl.realpathSync.native(base);
    } catch (err) {
      return rechazo(`No se pudo resolver ${codigo(rel)} (${err.code || 'error'}).`);
    }
    // Atrapa un directorio intermedio que sea symlink o junction hacia afuera.
    if (!quedaDentro(baseReal, real)) return rechazo('La ruta real se sale del workspace.');
    return { ok: true, abs, rel, real, existe: true };
  }

  // No existe en disco: solo vale un archivo versionado que se borró. Un
  // directorio borrado listaría varias entradas y se rechaza.
  let salida;
  try {
    salida = git(execFileSyncFn, base, ['ls-files', '-z', '--', rel]);
  } catch {
    return rechazo('No se pudo consultar git en el workspace.');
  }
  const entradas = salida.split('\0').filter(Boolean);
  if (entradas.length !== 1 || entradas[0] !== rel) {
    return rechazo(`${codigo(rel)} no existe ni es un archivo versionado.`);
  }
  return { ok: true, abs, rel, real: null, existe: false };
}

/**
 * Lee como mucho `tope` bytes desde `inicio` y cierra el descriptor pase lo que
 * pase.
 */
function leerTramo(fsImpl, ruta, { desdeElFinal = false, tope = TOPE_LECTURA_BYTES } = {}) {
  const fd = fsImpl.openSync(ruta, 'r');
  try {
    const tamano = fsImpl.fstatSync(fd).size;
    const inicio = desdeElFinal ? Math.max(0, tamano - tope) : 0;
    const cuantos = Math.min(tope, tamano - inicio);
    const buf = Buffer.alloc(cuantos);
    const leidos = cuantos > 0 ? fsImpl.readSync(fd, buf, 0, cuantos, inicio) : 0;
    return { datos: buf.subarray(0, leidos), tamano, inicio };
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * `/diff` sin argumento: qué cambió en el workspace, untracked incluidos.
 * Sin fallback a `HEAD~1`: con el árbol limpio, mostrar el último commit lo
 * presentaría como obra del agente.
 */
export function resumenDeCambios({ cwd, execFileSyncFn = execFileSync }) {
  const nombre = path.basename(path.resolve(cwd));
  try {
    git(execFileSyncFn, cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { aviso: `⚠️ El workspace ${codigo(cwd)} no es un repositorio git.` };
  }

  const estado = git(execFileSyncFn, cwd, ['status', '--porcelain=v1', '-uall']).replace(/\s+$/, '');
  if (!estado.trim()) return { aviso: `✅ Sin cambios sin commitear en ${codigo(nombre)}.` };

  // Sin commits todavía no hay HEAD: queda solo el estado.
  let stat = '';
  try {
    stat = git(execFileSyncFn, cwd, ['diff', '--stat', 'HEAD']).replace(/\s+$/, '');
  } catch {}

  return {
    encabezado: `📂 Cambios sin commitear en ${codigo(nombre)}`,
    contenido: stat ? `${estado}\n\n${stat}` : estado,
    lenguaje: ''
  };
}

/**
 * `/diff <archivo>` sobre una ruta ya validada por `resolverRutaEnWorkspace`.
 */
export function diffDeArchivo({ cwd, abs, rel, real = null, execFileSyncFn = execFileSync, fsImpl = fs, denyPatterns = null }) {
  // Antes de cualquier llamada a git: la ruta pedida y la real.
  for (const candidata of [abs, real, rel]) {
    if (!candidata) continue;
    const patron = matchDeniedPath(candidata, denyPatterns);
    if (patron) return { aviso: `🔒 ${codigo(rel)} está bloqueado por \`deny_paths\` (${codigo(patron)}).` };
  }

  const estado = git(execFileSyncFn, cwd, ['status', '--porcelain=v1', '-uall', '--', rel])
    .split(/\r?\n/)
    .filter(Boolean);
  if (estado.length === 0) return { aviso: `✅ ${codigo(rel)} no tiene cambios.` };

  if (estado[0].startsWith('??')) {
    const { datos, tamano } = leerTramo(fsImpl, abs);
    if (datos.subarray(0, 8192).includes(0)) {
      return { aviso: `🆕 ${codigo(rel)} es un archivo nuevo binario (${tamano} bytes).` };
    }
    const parcial = tamano > datos.length ? ` — primeros ${datos.length} de ${tamano} bytes` : '';
    return {
      encabezado: `🆕 ${codigo(rel)} — archivo nuevo${parcial}`,
      contenido: datos.toString('utf8'),
      lenguaje: ''
    };
  }

  let diff;
  try {
    diff = git(execFileSyncFn, cwd, ['diff', 'HEAD', '--', rel]);
  } catch {
    // Repo sin commits: lo preparado y lo que no, por separado.
    diff = git(execFileSyncFn, cwd, ['diff', '--cached', '--', rel]) + git(execFileSyncFn, cwd, ['diff', '--', rel]);
  }
  if (!diff.trim()) return { aviso: `✅ ${codigo(rel)} no tiene cambios de contenido.` };
  return { encabezado: `📝 ${codigo(rel)}`, contenido: diff.replace(/\s+$/, ''), lenguaje: 'diff' };
}

/**
 * Últimas `lineas` líneas de un archivo, leyendo solo su cola.
 *
 * @returns {string[]|null} `null` si el archivo no existe
 */
export function leerColaDeArchivo({ file, lineas = LOGS_POR_DEFECTO, maxBytes = TOPE_LECTURA_BYTES, fsImpl = fs }) {
  let tramo;
  try {
    tramo = leerTramo(fsImpl, file, { desdeElFinal: true, tope: maxBytes });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  // `cmd.exe >>` escribe `\r\n`.
  let partes = tramo.datos.toString('utf8').split(/\r?\n/);
  // Si no se leyó desde el principio, la primera línea puede venir partida.
  if (tramo.inicio > 0) partes = partes.slice(1);
  while (partes.length > 0 && partes[partes.length - 1] === '') partes.pop();
  return partes.slice(-lineas);
}

/** `/logs [N]`: N entero entre 1 y el tope; lo inválido cae al valor por defecto. */
export function parsearLineasLogs(arg) {
  const n = parseInt(String(arg ?? '').trim(), 10);
  if (!Number.isInteger(n) || n < 1) return { lineas: LOGS_POR_DEFECTO, aviso: null };
  if (n > LOGS_TOPE) return { lineas: LOGS_TOPE, aviso: `Tope de ${LOGS_TOPE} líneas (pediste ${n}).` };
  return { lineas: n, aviso: null };
}

/**
 * Log del daemon según la plataforma. En Windows es `daemon.log` junto al
 * código; en Linux el daemon escribe al journal y no hay archivo.
 */
export function logsDelDaemon({
  lineas = LOGS_POR_DEFECTO,
  platform = process.platform,
  logFile,
  execFileSyncFn = execFileSync,
  fsImpl = fs
}) {
  if (platform === 'win32') {
    const cola = leerColaDeArchivo({ file: logFile, lineas, fsImpl });
    if (cola === null) {
      return { aviso: 'ℹ️ No hay `daemon.log`: el bot no está corriendo como daemon (¿lo lanzaste con `npm run bridge`?).' };
    }
    if (cola.length === 0) return { aviso: 'ℹ️ `daemon.log` está vacío.' };
    return { encabezado: `📜 Últimas ${cola.length} líneas de \`daemon.log\``, contenido: cola.join('\n'), lenguaje: '' };
  }

  if (platform === 'linux') {
    let salida;
    try {
      salida = String(execFileSyncFn(
        'journalctl',
        ['--user', '-u', UNIDAD_SYSTEMD, '-n', String(lineas), '--no-pager', '-o', 'cat'],
        OPCIONES_EXEC
      ));
    } catch (err) {
      return { aviso: `❌ No se pudo leer el journal: ${redactSecrets(err.message)}` };
    }
    const texto = salida.replace(/\s+$/, '');
    if (!texto) return { aviso: 'ℹ️ El journal de la unidad no tiene líneas.' };
    return { encabezado: `📜 Últimas líneas del journal (${codigo(UNIDAD_SYSTEMD)})`, contenido: texto, lenguaje: '' };
  }

  return { aviso: 'ℹ️ Sin daemon en esta plataforma: no hay log que leer.' };
}

/**
 * Texto en un bloque de código: secretos redactados, fences del contenido
 * neutralizados y recorte con aviso.
 */
export function formatearBloque(texto, { lenguaje = '', maxLineas = null } = {}) {
  // Un ``` dentro del contenido cerraría el bloque: se le intercala un espacio
  // de ancho cero.
  const saneado = redactSecrets(texto).replace(/```/g, "`\u200b``");
  let lineas = saneado.split(/\r?\n/);
  let pie = '';
  if (maxLineas && lineas.length > maxLineas) {
    pie = `\n_… ${lineas.length - maxLineas} líneas más omitidas._`;
    lineas = lineas.slice(0, maxLineas);
  }
  return '```' + lenguaje + '\n' + lineas.join('\n') + '\n```' + pie;
}

/** Arma el mensaje final a partir de lo que devuelven las funciones de arriba. */
export function componerRespuesta(resultado, { maxLineas = DIFF_MAX_LINEAS } = {}) {
  if (resultado.aviso) return resultado.aviso;
  return `${resultado.encabezado}\n\n${formatearBloque(resultado.contenido, { lenguaje: resultado.lenguaje, maxLineas })}`;
}
