"""
Piezas compartidas entre text_loop.py (entrada por consola) y voice_loop.py
(entrada por microfono): cliente MCP, cliente HTTP de Voicebox, y el
reproductor local en cola FIFO. Sin dependencias pip - solo stdlib.
"""

import json
import os
import queue
import subprocess
import threading
import time
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MCP_SERVER = os.path.join(REPO_ROOT, "mcp-server", "index.js")
VOICEBOX_URL = os.environ.get("VOICEBOX_URL", "http://127.0.0.1:17493")
GENERATIONS_DIR = os.path.join(
    os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming")),
    "sh.voicebox.app", "generations"
)


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
            "¿Esta la app Voicebox corriendo?"
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


def wait_for_generation_wav(generation_id, before_files, timeout=90):
    # Si tenemos un generation_id, NUNCA usar el fallback de "cualquier archivo
    # nuevo": con sintesis en paralelo (varias oraciones a la vez), el fallback
    # puede agarrar el .wav de OTRA generacion concurrente que broto primero,
    # encolando el mismo audio dos veces bajo dos oraciones distintas. El
    # fallback por snapshot solo es seguro cuando no hay id para apuntar.
    if generation_id:
        target = os.path.join(GENERATIONS_DIR, f"{generation_id}.wav")
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(target) and os.path.getsize(target) > 2000:
                time.sleep(0.2)
                return target
            time.sleep(0.3)
        return None

    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.isdir(GENERATIONS_DIR):
            for f in os.listdir(GENERATIONS_DIR):
                if f not in before_files and f.endswith((".wav", ".ogg", ".mp3")):
                    full = os.path.join(GENERATIONS_DIR, f)
                    if os.path.getsize(full) > 2000:
                        time.sleep(0.2)
                        return full
        time.sleep(0.3)
    return None


def synthesize_sentence(text, profile, language, engine, model_size=None):
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
    res = voicebox_request("/generate", method="POST", payload=payload)
    gen_id = res.get("id")
    wav_path = wait_for_generation_wav(gen_id, before)
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


def unload_model(model_name):
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
    no lo que quedo cargado de corridas anteriores (perfiles/motores distintos)."""
    status = get_model_status()
    loaded = [m for m in status.values() if m.get("loaded")]
    freed_mb = 0
    for m in loaded:
        if unload_model(m["model_name"]):
            freed_mb += m.get("size_mb") or 0
            print(f"  🗑️ {m['model_name']} descargado ({(m.get('size_mb') or 0) / 1024:.2f} GB)")
    return freed_mb / 1024


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

    def enqueue(self, wav_path, label):
        self._queue.put((wav_path, label))

    def is_active(self):
        with self._lock:
            playing = self._current_proc is not None and self._current_proc.poll() is None
        return playing or not self._queue.empty()

    def _run(self):
        while True:
            wav_path, label = self._queue.get()
            if wav_path is None:
                return
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

    def barge_in(self):
        dropped = 0
        while True:
            try:
                self._queue.get_nowait()
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

    def submit(self, future, text):
        self._queue.put((future, text))

    def _run(self):
        while True:
            item = self._queue.get()
            if item is None:
                return
            future, text = item
            try:
                gen_id, wav_path = future.result()
                print(f"  [debug] enqueue gen_id={gen_id} wav={os.path.basename(wav_path)} text={text[:40]!r}")
                self._last_generation_id["id"] = gen_id
                self._player.enqueue(wav_path, text)
            except Exception as err:
                print(f"  ⚠️ Error sintetizando \"{text}\": {err}")
