/**
 * Muletillas y medición por turno de voice-chat (plan-charla-latencia, C, D y E).
 *
 * Corre common.py de verdad con Python y una síntesis falsa: no hace falta
 * Voicebox ni OmniVoice. Sin Python en el PATH, se omite y lo dice.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, group, report } = require('./lib/assert');

const REPO_ROOT = path.join(__dirname, '..');

const SCRIPT = `
import sys, json, os, time, tempfile
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'voice-chat'))})
import common
r = {}
dir_gen = tempfile.mkdtemp()
llamadas = []
def sintetizar(frase, *a):
    llamadas.append(frase)
    if "segundo" in frase and os.environ.get("FALLA_UNA"):
        raise RuntimeError("boom")
    p = os.path.join(dir_gen, f"g{len(llamadas)}.wav")
    open(p, "wb").write(b"RIFF" + b"0" * 100)
    return "id", p

cache = os.path.join(os.environ["LAGRANGE_VOICEBOX_DIR"], "muletillas")
muestra_path = os.path.join(dir_gen, "muestra.wav")
open(muestra_path, "wb").write(b"x")
os.utime(muestra_path, (time.time() - 100, time.time() - 100))
perfil = {"id": "p1", "name": "Alya"}
muestra = {"audio_path": muestra_path}

m = common.Muletillas(perfil, "es", "qwen", None, "omnivoice", muestra, sintetizar=sintetizar, directorio=cache)
m.esperar(10)
r["generadas"] = len(os.listdir(cache))
r["originales_borrados"] = not any(f.startswith("g") for f in os.listdir(dir_gen))
r["rotacion"] = [os.path.basename(m.elegir()) for _ in range(4)]

n = len(llamadas)
m2 = common.Muletillas(perfil, "es", "qwen", None, "omnivoice", muestra, sintetizar=sintetizar, directorio=cache)
m2.esperar(10)
r["cache_sin_regenerar"] = len(llamadas) == n and m2.elegir() is not None

os.utime(muestra_path, (time.time() + 100, time.time() + 100))
m3 = common.Muletillas(perfil, "es", "qwen", None, "omnivoice", muestra, sintetizar=sintetizar, directorio=cache)
m3.esperar(10)
r["muestra_nueva_regenera"] = len(llamadas) == n + 3

os.environ["FALLA_UNA"] = "1"
m4 = common.Muletillas({"id": "p2", "name": "Emily"}, "es", "qwen", None, "omnivoice", None, sintetizar=sintetizar, directorio=cache)
m4.esperar(10)
r["falla_una_sigue"] = len([f for f in os.listdir(cache) if f.startswith("Emily")]) == 2

r["vacia_devuelve_none"] = common.Muletillas(perfil, "en", "qwen", None, "omnivoice", None, sintetizar=sintetizar, directorio=cache, arrancar=False).elegir() is None

d = common.decidir_muletilla
r["decision"] = [
    d(False, False, False, True, False, 1600, 1500),
    d(False, False, False, True, False, 900, 1500),
    d(False, False, False, True, True, 200, 1500),
    d(True, False, False, True, True, 9000, 1500),
    d(False, True, False, True, True, 9000, 1500),
    d(False, False, True, True, True, 9000, 1500),
    d(False, False, False, False, True, 9000, 1500),
    d(False, False, False, True, True, 9000, 0),
]

reloj = [10.0]
t = common.TiemposTurno(t0=10.0, reloj=lambda: reloj[0])
reloj[0] = 10.7; t.marcar("transcripcion")
reloj[0] = 15.9; primera = t.marcar("primer_texto")
reloj[0] = 20.0; segunda = t.marcar("primer_texto")
r["marca_una_vez"] = primera and not segunda
r["linea"] = t.linea()

# AudioPlayer: borrar=False no borra el archivo (se usa sin reproducir: barge_in vacia la cola).
p = common.AudioPlayer()
p._run = None
q = common.AudioPlayer.__new__(common.AudioPlayer)
import queue as _q, threading as _t
q._queue = _q.Queue(); q._current_proc = None; q._lock = _t.Lock()
keep = os.path.join(dir_gen, "keep.wav"); open(keep, "wb").write(b"x")
tmp = os.path.join(dir_gen, "tmp.wav"); open(tmp, "wb").write(b"x")
q.enqueue(keep, "muletilla", borrar=False)
q.enqueue(tmp, "oracion")
q.barge_in()
r["barge_in_respeta_borrar"] = os.path.exists(keep) and not os.path.exists(tmp)
print("RESULTADO " + json.dumps(r, ensure_ascii=False))
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-mul-'));
  try {
    const r = spawnSync('python', ['-c', SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, LAGRANGE_VOICEBOX_DIR: dir, PYTHONIOENCODING: 'utf-8' },
      timeout: 60000
    });

    await group('muletillas y medición de voice-chat', () => {
      if (r.error || (r.status !== 0 && /not found|no se encontr|was not found/i.test(r.stderr || ''))) {
        console.log('  (Python no disponible: se omite)');
        check('python no disponible — omitido', true);
        return;
      }
      const linea = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULTADO '));
      check('el script corrió', !!linea, r.stderr);
      if (!linea) return;
      const x = JSON.parse(linea.slice('RESULTADO '.length));
      check('genera las tres muletillas en la caché', x.generadas === 3, String(x.generadas));
      check('borra los originales de generations', x.originales_borrados);
      check('rota sin repetir la anterior', x.rotacion[0] !== x.rotacion[1] && x.rotacion[1] !== x.rotacion[2] && x.rotacion[3] === x.rotacion[0], JSON.stringify(x.rotacion));
      check('segunda sesión usa la caché', x.cache_sin_regenerar);
      check('una muestra más nueva regenera', x.muestra_nueva_regenera);
      check('una frase que falla no rompe las otras', x.falla_una_sigue);
      check('sin muletillas listas devuelve None', x.vacia_devuelve_none);
      check('decisión de la muletilla', JSON.stringify(x.decision) === JSON.stringify([true, false, true, false, false, false, false, false]), JSON.stringify(x.decision));
      check('cada marca se toma una vez', x.marca_una_vez);
      check('línea de tiempos', x.linea === '⏱ transcripción 0.7 s · primer texto 5.9 s', x.linea);
      check('barge_in no borra muletillas', x.barge_in_respeta_borrar);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
