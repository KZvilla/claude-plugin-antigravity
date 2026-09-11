/**
 * voice-chat respeta el modelo fijado (auditoría 1, MINOR 2): antes,
 * `--unload-all-on-exit` y `--unload-on-exit` descargaban también el modelo
 * que el usuario había pedido mantener en VRAM.
 *
 * Corre common.py de verdad con Python, con `voicebox_request` reemplazado:
 * no hace falta Voicebox. Sin Python en el PATH, se omite y lo dice.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');

const SCRIPT = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'voice-chat'))})
import common
llamadas = []
def falso(path, method="GET", payload=None, **kw):
    if path == "/models/status":
        return {"models": [
            {"model_name": "qwen-tts-1.7B", "loaded": True, "size_mb": 4333},
            {"model_name": "kokoro", "loaded": True, "size_mb": 312}]}
    llamadas.append(path)
    return {}
common.voicebox_request = falso
common.unload_all_loaded_models()
common.unload_model("qwen-tts-1.7B")
common.tocar_uso("kokoro")
print("RESULTADO " + json.dumps(llamadas))
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-pin-'));
  try {
    fs.writeFileSync(path.join(dir, 'pin.json'), JSON.stringify({ model: 'qwen-tts-1.7B', voice: 'Alya' }));
    const r = spawnSync('python', ['-c', SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, LAGRANGE_VOICEBOX_DIR: dir, PYTHONIOENCODING: 'utf-8' },
      timeout: 30000
    });

    await group('voice-chat respeta el pin', () => {
      if (r.error || (r.status !== 0 && /not found|no se encontr|was not found/i.test(r.stderr || ''))) {
        console.log('  (Python no disponible: se omite)');
        check('python no disponible — omitido', true);
        return;
      }
      const linea = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULTADO '));
      check('el script corrió', !!linea, r.stderr);
      const llamadas = linea ? JSON.parse(linea.slice('RESULTADO '.length)) : null;
      check('unload_all descarga solo el no fijado', JSON.stringify(llamadas) === '["/models/kokoro/unload"]', JSON.stringify(llamadas));
      check('tocar_uso escribe en el directorio compartido', fs.existsSync(path.join(dir, 'uso', 'kokoro')));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
