/**
 * Señales y medición por turno de voice-chat (plan-charla-latencia, v2 H, I
 * y J): frases pregrabadas que dicen que agy sigue trabajando y qué
 * herramienta usa, sin volverse un disco rayado, y descarte del audio de un
 * turno cortado.
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
from concurrent.futures import Future
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'voice-chat'))})
import common
r = {}
dir_gen = tempfile.mkdtemp()
llamadas = []
def sintetizar(frase, *a):
    llamadas.append(frase)
    if frase == "Pensando." and os.environ.get("FALLA_UNA"):
        raise RuntimeError("boom")
    p = os.path.join(dir_gen, f"g{len(llamadas)}.wav")
    open(p, "wb").write(b"RIFF" + b"0" * 100)
    return "id", p

cache = os.path.join(os.environ["LAGRANGE_VOICEBOX_DIR"], "senales")
muestra_path = os.path.join(dir_gen, "muestra.wav")
open(muestra_path, "wb").write(b"x")
os.utime(muestra_path, (time.time() - 100, time.time() - 100))
perfil = {"id": "p1", "name": "Alya"}
muestra = {"audio_path": muestra_path}
N = len(common.ORDEN_SENALES)

s = common.Senales(perfil, "es", "qwen", None, "omnivoice", muestra, sintetizar=sintetizar, directorio=cache)
s.esperar(10)
r["generadas"] = len(os.listdir(cache)) == N
r["prioridad"] = llamadas[:2] == ["Pensando.", "Buscando en la web."]
r["originales_borrados"] = not any(f.startswith("g") for f in os.listdir(dir_gen))
r["elegir_web"] = (s.elegir("web") or "").endswith("-web.wav")
r["elegir_desconocida"] = s.elegir("xyz") is None

n = len(llamadas)
s2 = common.Senales(perfil, "es", "qwen", None, "omnivoice", muestra, sintetizar=sintetizar, directorio=cache)
s2.esperar(10)
r["cache_sin_regenerar"] = len(llamadas) == n and s2.elegir("pensando") is not None

os.utime(muestra_path, (time.time() + 100, time.time() + 100))
s3 = common.Senales(perfil, "es", "qwen", None, "omnivoice", muestra, sintetizar=sintetizar, directorio=cache)
s3.esperar(10)
r["muestra_nueva_regenera"] = len(llamadas) == n + N

os.environ["FALLA_UNA"] = "1"
s4 = common.Senales({"id": "p2", "name": "Emily"}, "es", "qwen", None, "omnivoice", None, sintetizar=sintetizar, directorio=cache)
s4.esperar(10)
r["falla_una_sigue"] = s4.elegir("pensando") is None and s4.elegir("web") is not None

r["vacia_devuelve_none"] = common.Senales(perfil, "en", "qwen", None, "omnivoice", None, sintetizar=sintetizar, directorio=cache, arrancar=False).elegir("pensando") is None

r["mapeo"] = [common.clave_de_herramienta(x) for x in
              ["search_web", "read_url_content", "view_file", "list_dir", "grep_search", "find_by_name",
               "call_mcp_tool", None]]

def d(**kw):
    base = dict(hubo_texto=False, reproduciendo=False, vigente=True, herramienta=None, ultima_clave=None,
                desde_ultima_ms=0, transcurrido_ms=0, umbral_ms=2500, sonaron=0)
    base.update(kw)
    return common.decidir_senal(**base)

r["decision"] = [
    d(herramienta="search_web"),
    d(herramienta="search_web", ultima_clave="web", desde_ultima_ms=20000, sonaron=1),
    d(herramienta="read_url_content", ultima_clave="web", desde_ultima_ms=3000, sonaron=1),
    d(herramienta="read_url_content", ultima_clave="web", desde_ultima_ms=9000, sonaron=1),
    d(transcurrido_ms=2000),
    d(transcurrido_ms=2600),
    d(ultima_clave="pensando", transcurrido_ms=9000, sonaron=1),
    d(herramienta="search_web", ultima_clave="pensando", desde_ultima_ms=8000, sonaron=1),
    d(herramienta="search_web", hubo_texto=True),
    d(herramienta="search_web", reproduciendo=True),
    d(herramienta="search_web", vigente=False),
    d(herramienta="search_web", umbral_ms=0),
    d(herramienta="grep_search", ultima_clave="pagina", desde_ultima_ms=9000, sonaron=3),
    d(herramienta="search_web", ultima_clave="pensando", desde_ultima_ms=3500, sonaron=1),
    d(herramienta="search_web", ultima_clave="pensando", desde_ultima_ms=1000, sonaron=1),
    d(herramienta="view_file", ultima_clave="pagina", desde_ultima_ms=9000, sonaron=2),
]

reloj = [10.0]
t = common.TiemposTurno(t0=10.0, reloj=lambda: reloj[0])
reloj[0] = 10.7; t.marcar("transcripcion")
reloj[0] = 15.9; primera = t.marcar("primer_texto")
reloj[0] = 20.0; segunda = t.marcar("primer_texto")
r["marca_una_vez"] = primera and not segunda
r["linea"] = t.linea()

# AudioPlayer sin hilo: barge_in vacia la cola y respeta borrar=False.
import queue as _q, threading as _t
q = common.AudioPlayer.__new__(common.AudioPlayer)
q._queue = _q.Queue(); q._current_proc = None; q._lock = _t.Lock()
keep = os.path.join(dir_gen, "keep.wav"); open(keep, "wb").write(b"x")
tmp = os.path.join(dir_gen, "tmp.wav"); open(tmp, "wb").write(b"x")
q.enqueue(keep, "senal", borrar=False)
q.enqueue(tmp, "oracion")
q.barge_in()
r["barge_in_respeta_borrar"] = os.path.exists(keep) and not os.path.exists(tmp)

# SentenceSequencer: una sintesis de un turno cortado se borra y no se encola.
class Reproductor:
    def __init__(self): self.encolados = []
    def enqueue(self, ruta, texto, **kw): self.encolados.append(ruta)
rep = Reproductor()
seq = common.SentenceSequencer(rep, {"id": None})
vieja = os.path.join(dir_gen, "vieja.wav"); open(vieja, "wb").write(b"x")
nueva = os.path.join(dir_gen, "nueva.wav"); open(nueva, "wb").write(b"x")
f1 = Future(); f1.set_result(("g1", vieja)); seq.submit(f1, "vieja", vigente=lambda: False)
f2 = Future(); f2.set_result(("g2", nueva)); seq.submit(f2, "nueva", vigente=lambda: True)
f3 = Future(); f3.set_result(("g3", nueva)); seq.submit(f3, "sin vigente")
time.sleep(0.5)
r["descarta_turno_cortado"] = rep.encolados == [nueva, nueva] and not os.path.exists(vieja)

# Una sintesis de un turno cortado que todavia no termino no traba al turno nuevo.
rep2 = Reproductor()
seq2 = common.SentenceSequencer(rep2, {"id": None})
colgada = Future(); colgada.set_running_or_notify_cancel()
tardia = os.path.join(dir_gen, "tardia.wav"); open(tardia, "wb").write(b"x")
otra = os.path.join(dir_gen, "otra.wav"); open(otra, "wb").write(b"x")
seq2.submit(colgada, "vieja en curso", vigente=lambda: False)
f4 = Future(); f4.set_result(("g4", otra)); seq2.submit(f4, "turno nuevo", vigente=lambda: True)
time.sleep(0.5)
r["no_traba_turno_nuevo"] = rep2.encolados == [otra]
colgada.set_result(("g5", tardia))
time.sleep(0.2)
r["borra_la_tardia"] = not os.path.exists(tardia)
print("RESULTADO " + json.dumps(r, ensure_ascii=False))
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sen-'));
  try {
    const r = spawnSync('python', ['-c', SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, LAGRANGE_VOICEBOX_DIR: dir, PYTHONIOENCODING: 'utf-8' },
      timeout: 60000
    });

    await group('señales y medición de voice-chat', () => {
      if (r.error || (r.status !== 0 && /not found|no se encontr|was not found/i.test(r.stderr || ''))) {
        console.log('  (Python no disponible: se omite)');
        check('python no disponible — omitido', true);
        return;
      }
      const linea = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULTADO '));
      check('el script corrió', !!linea, r.stderr);
      if (!linea) return;
      const x = JSON.parse(linea.slice('RESULTADO '.length));
      check('genera una señal por clave en la caché', x.generadas);
      check('"pensando" y "web" se generan primero', x.prioridad);
      check('borra los originales de generations', x.originales_borrados);
      check('elige por clave', x.elegir_web);
      check('una clave desconocida devuelve None', x.elegir_desconocida);
      check('segunda sesión usa la caché', x.cache_sin_regenerar);
      check('una muestra más nueva regenera', x.muestra_nueva_regenera);
      check('una señal que falla no rompe las otras', x.falla_una_sigue);
      check('sin señales listas devuelve None', x.vacia_devuelve_none);
      check('mapeo de herramientas a claves', JSON.stringify(x.mapeo) === JSON.stringify(['web', 'pagina', 'archivos', 'archivos', 'archivos', 'archivos', 'herramienta', 'herramienta']), JSON.stringify(x.mapeo));
      check('tabla de decidir_senal', JSON.stringify(x.decision) === JSON.stringify(['web', null, null, 'pagina', null, 'pensando', null, 'web', null, null, null, null, null, 'web', null, 'archivos']), JSON.stringify(x.decision));
      check('cada marca se toma una vez', x.marca_una_vez);
      check('línea de tiempos', x.linea === '⏱ transcripción 0.7 s · primer texto 5.9 s', x.linea);
      check('barge_in no borra señales', x.barge_in_respeta_borrar);
      check('descarta y borra el audio de un turno cortado', x.descarta_turno_cortado);
      check('una síntesis vieja en curso no traba al turno nuevo', x.no_traba_turno_nuevo);
      check('y su audio se borra al terminar', x.borra_la_tardia);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  process.exit(report() ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
