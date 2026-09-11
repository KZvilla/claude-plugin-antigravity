#!/usr/bin/env node
/**
 * Instalador opcional de OmniVoice (`npm run omnivoice:install`).
 *
 * Deja en %LOCALAPPDATA%\lagrange-omnivoice (o OMNIVOICE_DIR):
 *   venv\     Python 3.12 gestionado por uv, torch CUDA 12.8 y omnivoice
 *   models\OmniVoice\  pesos de k2-fsa/OmniVoice (~3 GB, licencia CC-BY-NC)
 *
 * Idempotente: si el venv ya importa torch y omnivoice con CUDA y los pesos
 * están, no hace nada. Nunca usa el Python del sistema para el venv: con 3.14
 * no hay ruedas de torch; uv baja su propio CPython 3.12.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') {
  console.error('El instalador de OmniVoice solo está preparado para Windows.');
  process.exit(1);
}

const base = process.env.OMNIVOICE_DIR
  ? path.resolve(process.env.OMNIVOICE_DIR)
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'lagrange-omnivoice');
const venv = path.join(base, 'venv');
const venvPy = path.join(venv, 'Scripts', 'python.exe');
const modelos = path.join(base, 'models', 'OmniVoice');

function correr(cmd, args, opciones = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opciones });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} terminó con código ${r.status}`);
}

function funciona(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function yaInstalado() {
  if (!fs.existsSync(venvPy) || !fs.existsSync(path.join(modelos, 'config.json'))) return false;
  return funciona(venvPy, ['-W', 'ignore', '-c', 'import sys, torch, omnivoice; sys.exit(0 if torch.cuda.is_available() else 3)']);
}

function uv() {
  if (funciona('uv', ['--version'])) return ['uv'];
  if (funciona('python', ['-m', 'uv', '--version'])) return ['python', '-m', 'uv'];
  correr('python', ['-m', 'pip', 'install', '--user', '--quiet', 'uv']);
  return ['python', '-m', 'uv'];
}

try {
  if (yaInstalado()) {
    console.log(`OmniVoice ya está instalado y funciona con CUDA en ${base}. Nada que hacer.`);
    process.exit(0);
  }
  fs.mkdirSync(base, { recursive: true });
  const [uvCmd, ...uvPre] = uv();
  const u = (...args) => correr(uvCmd, [...uvPre, ...args]);

  u('python', 'install', '3.12');
  if (!fs.existsSync(venvPy)) u('venv', '--python', '3.12', venv);
  // torch CUDA ANTES que omnivoice: si no, pip resuelve torch>=2.4 con la rueda de CPU.
  u('pip', 'install', '--python', venvPy, 'torch', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu128');
  u('pip', 'install', '--python', venvPy, 'omnivoice', 'soundfile');
  correr(venvPy, ['-c', `from huggingface_hub import snapshot_download; snapshot_download("k2-fsa/OmniVoice", local_dir=r"${modelos}")`]);

  if (!yaInstalado()) {
    console.error('\nLa instalación terminó pero el venv no importa torch con CUDA. Revisá los drivers de NVIDIA.');
    process.exit(2);
  }
  console.log(`\n✅ OmniVoice instalado en ${base}.`);
  console.log('Los pesos de k2-fsa/OmniVoice tienen licencia CC-BY-NC: uso no comercial.');
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
}
