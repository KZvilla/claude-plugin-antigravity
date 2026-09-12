"""
Piezas compartidas entre text_loop.py (entrada por consola) y voice_loop.py
(entrada por microfono): cliente MCP, cliente HTTP de Voicebox, y el
reproductor local en cola FIFO. Sin dependencias pip - solo stdlib.
"""

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import unicodedata
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MCP_SERVER = os.path.join(REPO_ROOT, "mcp-server", "index.js")
VOICEBOX_URL = os.environ.get("VOICEBOX_URL", "http://127.0.0.1:17493")
GENERATIONS_DIR = os.path.join(
    os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming")),
    "sh.voicebox.app", "generations"
)

# Estado compartido con el MCP (mcp-server/voicebox-server.js, dirEstado): misma
# regla de resolucion. Python solo TOCA archivos de uso (sin contenido) y LEE el
# pin; nunca escribe pin.json -- asi Node y Python no se pisan sin necesitar un
# lock entre lenguajes.
STATE_DIR = (
    os.environ.get("LAGRANGE_VOICEBOX_DIR")
    or os.path.join(os.environ.get("HOME") or os.environ.get("USERPROFILE") or os.path.expanduser("~"),
                    ".claude", "lagrange-voicebox")
)
USO_DIR = os.path.join(STATE_DIR, "uso")
PIN_PATH = os.path.join(STATE_DIR, "pin.json")
INTERVALO_TOQUE_S = 10

# OmniVoice (segundo proveedor, plan de OmniVoice). La config y la cache de
# voces las escribe el MCP; aca solo se leen.
_HOME = os.environ.get("HOME") or os.environ.get("USERPROFILE") or os.path.expanduser("~")
CONFIG_PATH = os.path.join(_HOME, ".claude", "antigravity.json")
CACHE_VOCES = os.path.join(STATE_DIR, "voces-cache.json")
VOICEBOX_DATA_DIR = os.environ.get("VOICEBOX_DIR") or os.path.join(
    os.environ.get("APPDATA", os.path.join(_HOME, "AppData", "Roaming")), "sh.voicebox.app")
# Dos oraciones a la vez se serializan en el lock de la GPU del server de
# OmniVoice: la segunda espera a la primera. 90 s, como el MCP.
TIMEOUT_OMNI_S = 90


def leer_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def omnivoice_url():
    puerto = leer_config().get("omnivoice_port")
    return os.environ.get("OMNIVOICE_URL") or f"http://127.0.0.1:{puerto if isinstance(puerto, int) else 17494}"


def omnivoice_request(path, payload, timeout=TIMEOUT_OMNI_S):
    req = urllib.request.Request(omnivoice_url() + path, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as err:
        try:
            detalle = json.loads(err.read().decode("utf-8")).get("detail")
        except ValueError:
            detalle = None
        raise RuntimeError(f"OmniVoice respondio HTTP {err.code}: {detalle or err.reason}")
    except urllib.error.URLError as err:
        raise RuntimeError(f"No se pudo contactar OmniVoice en {omnivoice_url()}{path} ({err}).")


def muestra_de_perfil(profile):
    """Muestra de voz del perfil: de Voicebox (fuente de verdad) o, si no
    responde, de la cache que escribe el MCP. None si el perfil no tiene
    muestra (preset): OmniVoice necesita una para clonar."""
    try:
        lista = voicebox_request(f"/profiles/{profile['id']}/samples", timeout=5)
        lista = lista if isinstance(lista, list) else []
        s = next((x for x in lista if x.get("reference_text")), lista[0] if lista else None)
        if not s or not s.get("audio_path"):
            return None
        ruta = s["audio_path"] if os.path.isabs(s["audio_path"]) else os.path.join(VOICEBOX_DATA_DIR, s["audio_path"])
        return {"audio_path": ruta, "ref_text": s.get("reference_text")}
    except Exception:
        pass
    try:
        with open(CACHE_VOCES, encoding="utf-8") as f:
            m = (json.load(f).get("muestras") or {}).get(profile["id"])
        return {"audio_path": m["audioPath"], "ref_text": m.get("refText")} if m else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def tocar_uso(model_name):
    """Marca el modelo como en uso para el keeper y para la regla de swap."""
    if not model_name:
        return
    try:
        os.makedirs(USO_DIR, exist_ok=True)
        ruta = os.path.join(USO_DIR, "".join(c if (c.isalnum() or c in "_.-") else "_" for c in model_name))
        with open(ruta, "a"):
            pass
        os.utime(ruta, None)
    except OSError:
        pass


def leer_pin():
    try:
        with open(PIN_PATH, encoding="utf-8") as f:
            pin = json.load(f)
        return pin if pin and pin.get("model") else None
    except (OSError, ValueError):
        return None


class LatidoUso:
    """Toca los modelos de la sesion cada 60 s mientras la charla sigue abierta:
    una pausa larga no debe dejar que el keeper los descargue a mitad."""

    def __init__(self, modelos, intervalo=60):
        self._modelos = [m for m in modelos if m]
        self._intervalo = intervalo
        self._parar = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while not self._parar.is_set():
            for m in self._modelos:
                tocar_uso(m)
            self._parar.wait(self._intervalo)

    def stop(self):
        self._parar.set()


class McpClient:
    """Habla JSON-RPC 2.0 con un mcp-server/index.js recien spawneado, sobre stdio -
    el mismo protocolo y el mismo binario que usa Claude Code."""

    def __init__(self):
        self.proc = subprocess.Popen(
            ["node", MCP_SERVER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=REPO_ROOT, text=True, encoding="utf-8", bufsize=1
        )
        self._next_id = 1
        self._lock = threading.Lock()
        self._pending = {}
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._request("initialize", {})

    def _read_loop(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg:
                with self._lock:
                    ev = self._pending.get(msg["id"])
                if ev:
                    ev["response"] = msg
                    ev["event"].set()

    def _request(self, method, params):
        with self._lock:
            req_id = self._next_id
            self._next_id += 1
            ev = {"event": threading.Event(), "response": None}
            self._pending[req_id] = ev
        payload = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        self.proc.stdin.write(payload + "\n")
        self.proc.stdin.flush()
        if not ev["event"].wait(timeout=30):
            raise TimeoutError(f"El servidor MCP no respondio a '{method}' a tiempo.")
        with self._lock:
            del self._pending[req_id]
        return ev["response"]

    def call_tool(self, name, arguments):
        resp = self._request("tools/call", {"name": name, "arguments": arguments})
        result = resp.get("result", {})
        if result.get("isError"):
            text = result["content"][0]["text"] if result.get("content") else "Error MCP desconocido"
            raise RuntimeError(f"{name} fallo: {text}")
        return result["content"][0]["text"]

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass


def voicebox_request(path, method="GET", payload=None, timeout=15, raw_body=None, headers=None):
    data = raw_body if raw_body is not None else (json.dumps(payload).encode("utf-8") if payload is not None else None)
    req_headers = {"X-Voicebox-Client-Id": "voice-loop-fase4"}
    if raw_body is None:
        req_headers["Content-Type"] = "application/json"
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(VOICEBOX_URL + path, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.URLError as err:
        raise RuntimeError(
            f"No se pudo contactar Voicebox en {VOICEBOX_URL}{path} ({err}). "
            "El MCP lo levanta sin GUI con agy_voice_model action 'start'; si no, abri la app."
        )


def resolve_voice_profile(preferred_name, language):
    profiles = voicebox_request("/profiles")
    if not profiles:
        raise RuntimeError("Voicebox no devolvio ningun perfil de voz.")

    if preferred_name:
        for p in profiles:
            if p["name"].lower() == preferred_name.lower():
                return p
        for p in profiles:
            if preferred_name.lower() in p["name"].lower():
                return p

    default_name = "diego alvarez" if language == "es" else "emily"
    for p in profiles:
        if default_name in p["name"].lower():
            return p
    for p in profiles:
        if (p.get("language") or "").lower().startswith(language):
            return p
    return profiles[0]


def get_model_status():
    """GET /models/status, indexado por model_name para lookup facil. Refleja lo
    que el usuario tiene REALMENTE descargado/cargado en su Voicebox - no asumas
    que un motor esta disponible sin chequear esto primero."""
    res = voicebox_request("/models/status")
    return {m["model_name"]: m for m in res.get("models", [])}


_QWEN_SIZE_PRIORITY = ["1.7B", "0.6B"]


def resolve_engine_and_model(profile, model_status, engine_override=None, model_size_override=None):
    """No hardcodear "qwen"/"1.7B": cada perfil de Voicebox declara su propio
    default_engine (verificado en vivo: Bananero -> qwen, Dora -> kokoro), y lo
    que el usuario tiene descargado varia por maquina. Prioridad: override de CLI
    > default_engine del perfil > "qwen" como ultimo recurso (funciona para
    cualquier voz clonada)."""
    engine = engine_override or profile.get("default_engine") or "qwen"

    if engine not in ("qwen", "qwen_custom_voice"):
        # Kokoro, luxtts, chatterbox, tada, etc. no versionan por model_size de
        # la misma forma que Qwen - dejamos que Voicebox use su default (None es
        # valido en el schema de GenerationRequest) salvo que el usuario lo pida.
        return engine, model_size_override

    if model_size_override:
        return engine, model_size_override

    prefix = "qwen-tts-" if engine == "qwen" else "qwen-custom-voice-"
    for size in _QWEN_SIZE_PRIORITY:
        entry = model_status.get(f"{prefix}{size}")
        if entry and entry.get("downloaded"):
            return engine, size

    return engine, "1.7B"  # default del schema si no encontramos nada ya descargado


def wait_for_generation_wav(generation_id, before_files, timeout=90, on_tick=None):
    # Si tenemos un generation_id, NUNCA usar el fallback de "cualquier archivo
    # nuevo": con sintesis en paralelo (varias oraciones a la vez), el fallback
    # puede agarrar el .wav de OTRA generacion concurrente que broto primero,
    # encolando el mismo audio dos veces bajo dos oraciones distintas. El
    # fallback por snapshot solo es seguro cuando no hay id para apuntar.
    #
    # on_tick se llama cada INTERVALO_TOQUE_S mientras se espera: una sintesis
    # larga (CPU, texto extenso) no debe parecer inactiva a la regla de swap.
    ultimo_tick = [time.time()]

    def tick():
        if on_tick and time.time() - ultimo_tick[0] >= INTERVALO_TOQUE_S:
            ultimo_tick[0] = time.time()
            on_tick()

    if generation_id:
        target = os.path.join(GENERATIONS_DIR, f"{generation_id}.wav")
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(target) and os.path.getsize(target) > 2000:
                time.sleep(0.2)
                return target
            tick()
            time.sleep(0.3)
        return None

    deadline = time.time() + timeout
    while time.time() < deadline:
        tick()
        if os.path.isdir(GENERATIONS_DIR):
            for f in os.listdir(GENERATIONS_DIR):
                if f not in before_files and f.endswith((".wav", ".ogg", ".mp3")):
                    full = os.path.join(GENERATIONS_DIR, f)
                    if os.path.getsize(full) > 2000:
                        time.sleep(0.2)
                        return full
        time.sleep(0.3)
    return None


def activar_motor_chat(mcp, profile, engine, model_size, pedido=None):
    """Elige el proveedor de la charla y deja la VRAM lista via el MCP (que
    levanta el server y coordina los dos proveedores). Regla del usuario: la
    charla en vivo va por OmniVoice si la voz tiene muestra, salvo que
    voz_por_perfil la fije a Voicebox o se pida --motor. Devuelve
    (proveedor, muestra); lanza RuntimeError si no se puede empezar."""
    if pedido is None and (leer_config().get("voz_por_perfil") or {}).get(profile["name"]) == "voicebox":
        pedido = "voicebox"
    if pedido != "voicebox":
        muestra = muestra_de_perfil(profile)
        if muestra and os.path.isfile(muestra["audio_path"]):
            try:
                mcp.call_tool("agy_voice_model", {"action": "activate", "engine": "omnivoice", "voice": profile["name"]})
                return "omnivoice", muestra
            except RuntimeError as err:
                if pedido == "omnivoice":
                    raise
                print(f"[voice-loop] OmniVoice no disponible ({err}); sigo con Voicebox.")
        elif pedido == "omnivoice":
            raise RuntimeError(f"{profile['name']} no tiene muestra en disco: OmniVoice necesita una para clonar.")
    activate_args = {"action": "activate", "engine": engine}
    if model_size:
        activate_args["model_size"] = model_size
    mcp.call_tool("agy_voice_model", activate_args)
    return "voicebox", None


def synthesize_sentence(text, profile, language, engine, model_size=None, proveedor="voicebox", muestra=None):
    # Parametros nuevos con default: los dos loops y el ThreadPoolExecutor
    # siguen llamando igual cuando la charla va por Voicebox.
    if proveedor == "omnivoice":
        tocar_uso("omnivoice")
        res = omnivoice_request("/generate", {"text": text, "ref_audio": muestra["audio_path"],
                                              "ref_text": muestra.get("ref_text")})
        tocar_uso("omnivoice")
        return res.get("id"), res.get("audio_path")
    # POST /generate, no /generate/stream: mcp-server/index.js ya documenta que
    # /generate/stream dispara un bug de doble reproduccion en Voicebox y usa
    # /generate a proposito (ver index.js linea ~2810). Seguimos el camino probado.
    before = set(os.listdir(GENERATIONS_DIR)) if os.path.isdir(GENERATIONS_DIR) else set()
    payload = {
        "profile_id": profile["id"],
        "text": text,
        "language": language,
        "engine": engine,
        "personality": False,
        "normalize": True
    }
    if model_size:
        payload["model_size"] = model_size
    modelo = tts_model_name(engine, model_size)
    tocar_uso(modelo)
    res = voicebox_request("/generate", method="POST", payload=payload)
    gen_id = res.get("id")
    wav_path = wait_for_generation_wav(gen_id, before, on_tick=lambda: tocar_uso(modelo))
    tocar_uso(modelo)
    if not wav_path:
        raise RuntimeError(f"Voicebox nunca escribio el .wav de la generacion {gen_id}")
    return gen_id, wav_path


def voicebox_cancel(generation_id):
    if not generation_id:
        return
    try:
        voicebox_request(f"/generate/{generation_id}/cancel", method="POST", payload={})
    except Exception:
        pass


def transcribe_wav_bytes(wav_bytes, language=None, model=None):
    boundary = "----voiceloopboundary"
    parts = [(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="clip.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8") + wav_bytes]
    # language/model existian como parametros pero nunca se mandaban en el
    # multipart -- Voicebox siempre caia a su propio default silencioso
    # (whisper-base, el mas debil de los que hay descargados).
    for field_name, value in (("language", language), ("model", model)):
        if value:
            parts.append((
                f"\r\n--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{field_name}"\r\n\r\n{value}'
            ).encode("utf-8"))
    body = b"".join(parts) + f"\r\n--{boundary}--\r\n".encode("utf-8")
    res = voicebox_request(
        "/transcribe", method="POST", raw_body=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=60
    )
    return res.get("text", "").strip()


def tts_model_name(engine, model_size):
    """Traduce (engine, model_size) al model_name que usa /models/status y
    /models/{model_name}/unload. Best-effort para los motores que no versionan
    por tamano (no hay forma generica de derivarlo del schema de Voicebox)."""
    if engine == "qwen":
        return f"qwen-tts-{model_size or '1.7B'}"
    if engine == "qwen_custom_voice":
        return f"qwen-custom-voice-{model_size or '1.7B'}"
    if engine == "chatterbox":
        return "chatterbox-tts"
    if engine == "chatterbox_turbo":
        return "chatterbox-turbo"
    return engine  # kokoro, luxtts: el nombre del engine coincide con model_name


def stt_full_model_name(short_name):
    """/transcribe usa nombres cortos ("turbo", "base"...) pero /models/status y
    /models/{model_name}/unload usan el nombre completo ("whisper-turbo",
    "whisper-base"...) - dos convenciones distintas para el mismo modelo,
    confirmado en vivo contra ambos endpoints."""
    return f"whisper-{short_name}"


def unload_model(model_name, respetar_pin=True):
    # El usuario fijo ese modelo para que quede en VRAM: salir de la charla no
    # es "indicar lo contrario".
    pin = leer_pin() if respetar_pin else None
    if pin and pin.get("model") == model_name:
        print(f"  📌 {model_name} esta fijado: no se descarga (agy_voice_model action 'release' para soltarlo).")
        return False
    try:
        voicebox_request(f"/models/{model_name}/unload", method="POST", payload={})
        return True
    except Exception as err:
        print(f"  ⚠️ No se pudo descargar el modelo {model_name}: {err}")
        return False


def unload_all_loaded_models():
    """A diferencia de unload_model() (que descarga UN modelo puntual), esto
    descarga TODO lo que Voicebox tenga marcado como loaded en este momento -
    util porque --unload-on-exit solo limpia lo que ESA corrida del script uso,
    no lo que quedo cargado de corridas anteriores (perfiles/motores distintos).
    El modelo fijado se respeta."""
    status = get_model_status()
    pin = leer_pin()
    loaded = [m for m in status.values() if m.get("loaded")]
    if pin:
        if any(m["model_name"] == pin["model"] for m in loaded):
            print(f"  📌 {pin['model']} esta fijado: se deja cargado.")
        loaded = [m for m in loaded if m["model_name"] != pin["model"]]
    freed_mb = 0
    for m in loaded:
        if unload_model(m["model_name"], respetar_pin=False):
            freed_mb += m.get("size_mb") or 0
            print(f"  🗑️ {m['model_name']} descargado ({(m.get('size_mb') or 0) / 1024:.2f} GB)")
    return freed_mb / 1024


def _delete_generation(wav_path):
    """Borra un .wav de generations/ una vez consumido (reproducido o descartado por
    barge-in) - sin esto la carpeta crece sin limite, un .wav por cada oracion de
    cada turno de la charla."""
    try:
        os.remove(wav_path)
    except OSError:
        pass


class AudioPlayer:
    """Cola FIFO de reproduccion via el reproductor nativo de Windows (mismo mecanismo
    que playLocalAudio() en mcp-server/index.js: System.Media.SoundPlayer, cero eco,
    cero dependencias extra). barge_in() corta lo que suena y descarta lo pendiente."""

    def __init__(self):
        self._queue = queue.Queue()
        self._current_proc = None
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def enqueue(self, wav_path, label, borrar=True, al_empezar=None):
        # borrar=False para las senales: viven en una cache entre sesiones.
        # al_empezar se llama justo antes de reproducir (medicion por turno).
        self._queue.put((wav_path, label, borrar, al_empezar))

    def is_active(self):
        with self._lock:
            playing = self._current_proc is not None and self._current_proc.poll() is None
        return playing or not self._queue.empty()

    def _run(self):
        while True:
            wav_path, label, borrar, al_empezar = self._queue.get()
            if wav_path is None:
                return
            if al_empezar:
                try:
                    al_empezar()
                except Exception:
                    pass
            escaped = wav_path.replace("'", "''")
            ps_cmd = f"& {{ $p = '{escaped}'; (New-Object System.Media.SoundPlayer $p).PlaySync() }}"
            with self._lock:
                self._current_proc = subprocess.Popen(
                    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
            print(f"  \U0001F50A {label}")
            self._current_proc.wait()
            with self._lock:
                self._current_proc = None
            if borrar:
                _delete_generation(wav_path)

    def barge_in(self):
        dropped = 0
        while True:
            try:
                wav_path, _, borrar, _ = self._queue.get_nowait()
                if borrar:
                    _delete_generation(wav_path)
                dropped += 1
            except queue.Empty:
                break
        with self._lock:
            if self._current_proc and self._current_proc.poll() is None:
                self._current_proc.terminate()
                print("  ✋ Barge-in: reproduccion actual cortada.")
        if dropped:
            print(f"  ✋ Barge-in: {dropped} frase(s) pendiente(s) descartada(s).")


class SentenceSequencer:
    """Sintetizar en paralelo (ThreadPoolExecutor) puede terminar oraciones fuera de
    orden. Este hilo consume los Future en el orden en que se ENVIARON, no en el que
    terminan, y recien ahi encola para reproduccion - preserva orden sin serializar
    la sintesis."""

    def __init__(self, player, last_generation_id):
        self._queue = queue.Queue()
        self._player = player
        self._last_generation_id = last_generation_id
        threading.Thread(target=self._run, daemon=True).start()

    def submit(self, future, text, al_empezar=None, vigente=None):
        # vigente(): False si el turno de esta oracion ya fue cortado. La
        # sintesis no se puede cancelar, pero su audio no debe sonar despues
        # del corte (visto en vivo: una oracion vieja tras el barge-in).
        self._queue.put((future, text, al_empezar, vigente))

    def _run(self):
        while True:
            item = self._queue.get()
            if item is None:
                return
            future, text, al_empezar, vigente = item
            if vigente is not None and not vigente():
                # No esperar una sintesis de un turno cortado: trabaria al turno
                # nuevo detras (auditoria del plan v2). Si todavia no empezo se
                # cancela; si ya corre, su .wav se borra cuando termine.
                if not future.cancel():
                    future.add_done_callback(_borrar_resultado)
                print(f"  ✋ Descartada (turno cortado): {text[:40]!r}")
                continue
            try:
                gen_id, wav_path = future.result()
                if vigente is not None and not vigente():
                    _delete_generation(wav_path)
                    print(f"  ✋ Descartada (turno cortado): {text[:40]!r}")
                    continue
                print(f"  [debug] enqueue gen_id={gen_id} wav={os.path.basename(wav_path)} text={text[:40]!r}")
                self._last_generation_id["id"] = gen_id
                self._player.enqueue(wav_path, text, al_empezar=al_empezar)
            except Exception as err:
                print(f"  ⚠️ Error sintetizando \"{text}\": {err}")


# Senales (plan-charla-latencia, v2 H): frases cortas pregrabadas con la voz
# de la charla, que dicen que agy sigue trabajando y, si la hay, que
# herramienta usa. Una clave por categoria; el orden es la prioridad de
# generacion. Sin puntos suspensivos ni exclamaciones: con Qwen, la
# puntuacion forzada hizo alucinar la voz (evaluacion del 2026-09-11).
# Pocas claves y no una por herramienta (auditoria del plan v2): en la charla
# no se editan archivos, y cada clave extra es GPU al arrancar con la cache
# fria. "archivos" se sumo a pedido del usuario: aparece en busquedas reales,
# cuando agy lee lo que descargo.
# navegador/memoria/agenda: por el servidor MCP que informa drain
# (plan-senales-mcp). "navegador" va alto: es el caso agentico del usuario.
# comando/escribiendo al final (plan-charla-modo-agente): solo suenan en una
# ejecucion que el usuario autorizo, asi que no le quitan GPU al arranque de
# las que usa toda charla.
ORDEN_SENALES = ["pensando", "web", "navegador", "pagina", "archivos", "memoria", "agenda", "herramienta",
                 "comando", "escribiendo"]
FRASES_SENAL = {
    "es": {"pensando": "Pensando.", "web": "Buscando en la web.", "navegador": "Usando el navegador.",
           "pagina": "Leyendo la página.", "archivos": "Revisando archivos.",
           "memoria": "Consultando la memoria.", "agenda": "Revisando la agenda.",
           "herramienta": "Usando una herramienta.",
           "comando": "Ejecutando un comando.", "escribiendo": "Escribiendo el archivo."},
    "en": {"pensando": "Thinking.", "web": "Searching the web.", "navegador": "Using the browser.",
           "pagina": "Reading the page.", "archivos": "Looking through files.",
           "memoria": "Checking memory.", "agenda": "Checking the calendar.",
           "herramienta": "Using a tool.",
           "comando": "Running a command.", "escribiendo": "Writing the file."},
}
# Inventario de agy observado (mcp-server/agents/registry.js); el resto cae en "herramienta".
CATEGORIA_HERRAMIENTA = {
    "search_web": "web",
    "read_url_content": "pagina",
    "view_file": "archivos", "list_dir": "archivos", "grep_search": "archivos", "find_by_name": "archivos",
    "run_command": "comando",
    "write_to_file": "escribiendo", "replace_file_content": "escribiendo", "multi_replace_file_content": "escribiendo",
}
HERRAMIENTAS_ESCRITURA = {"write_to_file", "replace_file_content", "multi_replace_file_content"}
# brain/ (planes) y scratch/ (el cwd de su shell) son de agy, no del usuario.
RUTA_PROPIA_DE_AGY = re.compile(r"[\\/]antigravity-cli[\\/](brain|scratch)([\\/]|$)", re.IGNORECASE)
SENALES_DIR = os.path.join(STATE_DIR, "senales")
SEPARACION_SENALES_MS = 8000
# Tras "Pensando", nombrar la herramienta no espera los 8 s: es informacion nueva.
SEPARACION_TRAS_PENSANDO_MS = 3000
MAX_SENALES_TURNO = 3


def _borrar_resultado(future):
    """Callback para una sintesis descartada que ya estaba en curso."""
    try:
        _, wav_path = future.result()
        _delete_generation(wav_path)
    except Exception:
        pass


def clave_de_herramienta(nombre):
    return CATEGORIA_HERRAMIENTA.get(nombre or "", "herramienta")


# Tokens exactos del nombre del servidor, no substrings (auditoria del plan):
# "file-browser" no es un navegador y "task-scheduler" no es una agenda.
# Sin "schedule": schedule-x es un MCP de documentacion de esa libreria, no
# una agenda (observacion del usuario tras probarlo con el microfono).
TOKENS_SERVIDOR = {
    "navegador": {"playwright", "puppeteer", "chrome", "chromium"},
    "memoria": {"memory", "memoria", "mem0"},
    "agenda": {"calendar", "agenda"},
}


def clave_de_servidor(servidor):
    if not isinstance(servidor, str) or not servidor.strip():
        return None
    tokens = set(re.split(r"[^a-z0-9]+", servidor.lower()))
    for clave, nombres in TOKENS_SERVIDOR.items():
        if tokens & nombres:
            return clave
    return None


def clave_de_paso(paso, ejecutando=True):
    """Clave de senal de un paso de drain: un detalle {nombre, servidor,
    accion, destino} o, de un MCP viejo, solo el nombre de la herramienta.
    None si el paso no merece senal: agy escribiendo en su brain/ o scratch/,
    o un comando fuera de una ejecucion autorizada (agy lo niega: anunciarlo
    diria algo que no paso)."""
    if isinstance(paso, dict):
        nombre = paso.get("nombre")
        if nombre == "call_mcp_tool":
            return clave_de_servidor(paso.get("servidor")) or "herramienta"
        destino = paso.get("destino")
        if nombre in HERRAMIENTAS_ESCRITURA and isinstance(destino, str) and RUTA_PROPIA_DE_AGY.search(destino):
            return None
        clave = clave_de_herramienta(nombre)
    else:
        clave = clave_de_herramienta(paso)
    if clave == "comando" and not ejecutando:
        return None
    return clave


# Charla con freno (plan-charla-modo-agente). Solo frases cortas: una frase de
# fondo mal transcripta no alcanza para autorizar. Sin tildes ni puntuacion:
# para Whisper, "Sí." y "si" son lo mismo.
MAX_PALABRAS_CONFIRMACION = 4
VIGENCIA_PENDIENTE_S = 90
CONFIRMACIONES = {
    "es": {
        "si": {"si", "dale", "hacelo", "hazlo", "confirmo", "adelante", "de una", "si dale", "dale si", "si hacelo",
               "si por favor", "si adelante", "si confirmo"},
        "no": {"no", "cancela", "cancelar", "mejor no", "espera", "no gracias", "no no", "no lo hagas"},
    },
    "en": {
        "si": {"yes", "go ahead", "do it", "yes please", "yes go ahead", "yes do it", "confirm"},
        "no": {"no", "cancel", "don t", "don t do it", "no thanks", "wait"},
    },
}
PARADAS = {
    "es": {"para", "para para", "para ya", "stop", "frena", "basta", "detente", "cancela"},
    "en": {"stop", "cancel", "halt"},
}
TURNO_CANCELADO = {
    "es": "No autorizo eso. No lo reintentes; respondé en una oración.",
    "en": "I don't authorize that. Don't retry it; answer in one sentence.",
}
AVISO_CONFIRMACION = {
    "es": "Charla con freno: agy no ejecuta comandos, usa MCP ni lee páginas sin tu sí. "
          "Con tu sí, ese turno corre con permisos plenos. "
          "Las escrituras de archivos no las frena agy: la charla te avisa cuando pasan.",
    "en": "Chat with a brake: agy won't run commands, use MCP or read pages without your yes. "
          "With your yes, that turn runs with full permissions. "
          "agy doesn't gate file writes: the chat tells you when they happen.",
}


def _normalizar(texto):
    sin_tildes = "".join(c for c in unicodedata.normalize("NFD", texto or "") if unicodedata.category(c) != "Mn")
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", sin_tildes.lower()).split())


def _frase_corta(texto):
    n = _normalizar(texto)
    return n if n and len(n.split()) <= MAX_PALABRAS_CONFIRMACION else None


def interpretar_confirmacion(texto, idioma):
    """"si", "no" o None (no es una respuesta corta reconocible)."""
    n = _frase_corta(texto)
    if not n:
        return None
    tabla = CONFIRMACIONES.get(idioma) or CONFIRMACIONES["en"]
    if n in tabla["si"]:
        return "si"
    if n in tabla["no"]:
        return "no"
    return None


def es_parada(texto, idioma):
    n = _frase_corta(texto)
    return bool(n) and n in (PARADAS.get(idioma) or PARADAS["en"])


def accion_para_turno(texto, idioma, pendiente_t, ahora, ejecutando=False):
    """Que accion de agy_voice_stream corresponde a lo que dijo el usuario:
    ("confirm" | "send" | "stop_exec", texto a mandar o None). La pendiente
    vale solo para la frase inmediata siguiente: el llamador la descarta
    siempre despues de llamar a esto."""
    if ejecutando:
        return ("stop_exec", None) if es_parada(texto, idioma) else ("send", texto)
    if pendiente_t is not None and ahora - pendiente_t <= VIGENCIA_PENDIENTE_S:
        respuesta = interpretar_confirmacion(texto, idioma)
        if respuesta == "si":
            return ("confirm", None)
        if respuesta == "no":
            return ("send", TURNO_CANCELADO.get(idioma) or TURNO_CANCELADO["en"])
    return ("send", texto)


def _limpiar_para_voz(texto, maximo=60):
    """Primera linea, sin simbolos que el TTS lee mal, recortada en palabra."""
    lineas = (texto or "").strip().splitlines()
    t = " ".join(re.sub(r"[\"'`*$<>|&;{}\[\]\\]+", " ", lineas[0] if lineas else "").split())
    if len(t) > maximo:
        t = t[:maximo].rsplit(" ", 1)[0] or t[:maximo]
    return t


def _describir_negada(negada, idioma):
    tipo = negada.get("tipo")
    objetivo = negada.get("objetivo") or ""
    es = idioma == "es"
    if tipo == "command":
        cmd = _limpiar_para_voz(objetivo)
        if not cmd:
            return "ejecutar un comando" if es else "run a command"
        return f"ejecutar el comando {cmd}" if es else f"run the command {cmd}"
    if tipo == "mcp":
        servidor = objetivo.split("/")[0]
        clave = clave_de_servidor(servidor)
        if es:
            return ({"navegador": "usar el navegador", "memoria": "usar la memoria", "agenda": "usar la agenda"}.get(clave)
                    or f"usar {_limpiar_para_voz(servidor)}")
        return ({"navegador": "use the browser", "memoria": "use memory", "agenda": "use the calendar"}.get(clave)
                or f"use {_limpiar_para_voz(servidor)}")
    if tipo == "read_url":
        return f"leer {_limpiar_para_voz(objetivo)}" if es else f"read {_limpiar_para_voz(objetivo)}"
    return "hacer algo que necesita permiso" if es else "do something that needs permission"


def pregunta_de_negaciones(negadas, idioma):
    """La pregunta que dice la charla al cerrar un turno con negaciones. La
    arma la charla y no agy: tras una negacion su respuesta suele venir vacia
    (sondas A, C, E). None si no hay nada que preguntar."""
    descripciones = []
    for n in negadas or []:
        d = _describir_negada(n, idioma)
        if d not in descripciones:
            descripciones.append(d)
    if not descripciones:
        return None
    resto = len(descripciones) - 1
    if idioma == "es":
        extra = "" if not resto else (" y una cosa más" if resto == 1 else f" y {resto} cosas más")
        return f"Agy quiere {descripciones[0]}{extra}. ¿Lo hago?"
    extra = "" if not resto else (" and one more thing" if resto == 1 else f" and {resto} more things")
    return f"Agy wants to {descripciones[0]}{extra}. Should I?"


def aviso_escrituras(rutas, idioma):
    """Aviso de archivos que agy escribio sin pedir permiso (write_to_file no
    pasa por el freno). None si no hubo."""
    nombres = []
    for r in rutas or []:
        nombre = re.split(r"[\\/]", r)[-1] if isinstance(r, str) else ""
        if nombre and nombre not in nombres:
            nombres.append(nombre)
    if not nombres:
        return None
    if len(nombres) == 1:
        return f"Agy modificó {nombres[0]} sin preguntar." if idioma == "es" else f"Agy changed {nombres[0]} without asking."
    if idioma == "es":
        return f"Agy modificó {len(nombres)} archivos sin preguntar."
    return f"Agy changed {len(nombres)} files without asking."


def _slug(texto):
    return "".join(c if (c.isalnum() or c in "_.-") else "_" for c in (texto or ""))


class Senales:
    """Genera en segundo plano las senales de una voz, en orden de prioridad,
    y las guarda en una cache entre sesiones (SENALES_DIR). Una muestra de voz
    mas nueva que el .wav invalida la cache. Si algo falla, la charla sigue
    sin esa senal."""

    def __init__(self, profile, language, engine, model_size, proveedor, muestra,
                 sintetizar=None, ocupado=None, directorio=None, arrancar=True):
        self._sintetizar = sintetizar or synthesize_sentence
        self._ocupado = ocupado or (lambda: False)
        self._args = (profile, language, engine, model_size, proveedor, muestra)
        frases = FRASES_SENAL.get(language) or FRASES_SENAL["en"]
        base = f"{_slug(profile['name'])}-{language}-{proveedor}"
        if proveedor != "omnivoice":
            base += f"-{_slug(tts_model_name(engine, model_size))}"
        carpeta = directorio or SENALES_DIR
        self._items = [(clave, frases[clave], os.path.join(carpeta, f"{base}-{clave}.wav"))
                       for clave in ORDEN_SENALES]
        try:
            self._mtime_muestra = os.path.getmtime(muestra["audio_path"]) if muestra else None
        except OSError:
            self._mtime_muestra = None
        self._listas = {}
        self._lock = threading.Lock()
        self._parar = threading.Event()
        self._hilo = threading.Thread(target=self._generar, daemon=True)
        if arrancar:
            self._hilo.start()

    def _vigente(self, ruta):
        try:
            return os.path.getsize(ruta) > 0 and (
                self._mtime_muestra is None or os.path.getmtime(ruta) >= self._mtime_muestra)
        except OSError:
            return False

    def _generar(self):
        try:
            os.makedirs(os.path.dirname(self._items[0][2]), exist_ok=True)
        except OSError:
            return
        for clave, frase, ruta in self._items:
            if self._parar.is_set():
                return
            if not self._vigente(ruta):
                # Prioridad baja: no competir por la GPU con la respuesta en curso.
                while self._ocupado() and not self._parar.is_set():
                    self._parar.wait(0.2)
                if self._parar.is_set():
                    return
                try:
                    _, wav = self._sintetizar(frase, *self._args)
                    shutil.copyfile(wav, ruta)
                    _delete_generation(wav)
                except Exception as err:
                    print(f"  ⚠️ Señal \"{frase}\" no se pudo generar: {err}")
                    continue
            with self._lock:
                self._listas[clave] = ruta

    def esperar(self, timeout=None):
        self._hilo.join(timeout)

    def elegir(self, clave):
        """Ruta de la senal pedida; None si todavia no esta lista."""
        with self._lock:
            return self._listas.get(clave)

    def stop(self):
        self._parar.set()


def decidir_senal(hubo_texto, reproduciendo, vigente, clave_pendiente, ultima_clave, desde_ultima_ms,
                  transcurrido_ms, umbral_ms, sonaron=0,
                  separacion_ms=SEPARACION_SENALES_MS, maximo=MAX_SENALES_TURNO,
                  separacion_tras_pensando_ms=SEPARACION_TRAS_PENSANDO_MS):
    """Que senal suena ahora, o None. Nunca con texto de la respuesta, audio
    sonando, turno cortado o umbral <= 0. La primera herramienta del turno
    suena ya; otra categoria, solo con separacion_ms desde la anterior; la
    misma categoria no se repite. "pensando" una sola vez, si no hubo
    herramienta ni texto en umbral_ms. Tope de `maximo` por turno: al usuario
    la quinta ya le sonaba a disco rayado."""
    if umbral_ms <= 0 or hubo_texto or reproduciendo or not vigente or sonaron >= maximo:
        return None
    # clave_pendiente ya es una clave de senal (clave_de_paso en el loop): no
    # se vuelve a mapear, o "navegador" caeria en "herramienta" (auditoria).
    if clave_pendiente:
        clave = clave_pendiente
        if clave == ultima_clave:
            return None
        separacion = separacion_tras_pensando_ms if ultima_clave == "pensando" else separacion_ms
        if ultima_clave is None or desde_ultima_ms >= separacion:
            return clave
        return None
    if ultima_clave is None and transcurrido_ms >= umbral_ms:
        return "pensando"
    return None


class TiemposTurno:
    """Medicion por turno (plan-charla-latencia, E). Cada marca se toma una sola
    vez; t0 es el fin de lo que dijo el usuario (VAD) o el Enter."""

    ETIQUETAS = [("transcripcion", "transcripción"), ("envio", "envío"), ("herramienta", "herramienta"),
                 ("senal", "señal"), ("primer_texto", "primer texto"),
                 ("primera_oracion", "primera oración"), ("primer_audio", "primer audio")]

    def __init__(self, t0=None, reloj=time.monotonic):
        self._reloj = reloj
        self.t0 = t0 if t0 is not None else reloj()
        self._marcas = {}
        self._impresa = False
        self._lock = threading.Lock()

    def marcar(self, nombre):
        with self._lock:
            if nombre in self._marcas:
                return False
            self._marcas[nombre] = self._reloj() - self.t0
            return True

    def marca(self, nombre):
        with self._lock:
            return self._marcas.get(nombre)

    def linea(self):
        with self._lock:
            partes = [f"{etq} {self._marcas[k]:.1f} s" for k, etq in self.ETIQUETAS if k in self._marcas]
        return "⏱ " + " · ".join(partes) if partes else "⏱ sin marcas"

    def imprimir_una_vez(self):
        with self._lock:
            if self._impresa:
                return
            self._impresa = True
        print(f"  {self.linea()}")
