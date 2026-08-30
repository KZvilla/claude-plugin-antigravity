#!/usr/bin/env python3
"""
Fase 4 (Modo Charla) - loop minimo texto -> voz.

Consola (texto) -> agy_voice_stream (servidor MCP real, hablado por JSON-RPC
sobre stdio, el mismo protocolo que usa Claude Code) -> SentenceChunker
(ya integrado del lado servidor, expuesto via la accion "drain") ->
Voicebox POST /generate -> reproduccion local en cola FIFO con "barge-in"
(tipear mientras habla corta el audio y descarta lo pendiente).

Sin microfono ni VAD todavia (eso es el siguiente paso, una vez validado
este pipeline de salida). Cero dependencias pip: solo stdlib de Python,
igual que el servidor Node (mcp-server/index.js dice "zero external
dependencies" en su propio encabezado).

Uso:
    python3 voice-chat/text_loop.py [--voice "Diego Alvarez"] [--language es] [--effort low]
"""

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

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


def _voicebox_request(path, method="GET", payload=None, timeout=15):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        VOICEBOX_URL + path,
        data=data,
        headers={"Content-Type": "application/json", "X-Voicebox-Client-Id": "voice-loop-fase4"},
        method=method
    )
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
    profiles = _voicebox_request("/profiles")
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


def wait_for_generation_wav(generation_id, before_files, timeout=90):
    target = os.path.join(GENERATIONS_DIR, f"{generation_id}.wav") if generation_id else None
    deadline = time.time() + timeout
    while time.time() < deadline:
        if target and os.path.exists(target) and os.path.getsize(target) > 2000:
            time.sleep(0.2)
            return target
        if os.path.isdir(GENERATIONS_DIR):
            for f in os.listdir(GENERATIONS_DIR):
                if f not in before_files and f.endswith((".wav", ".ogg", ".mp3")):
                    full = os.path.join(GENERATIONS_DIR, f)
                    if os.path.getsize(full) > 2000:
                        time.sleep(0.2)
                        return full
        time.sleep(0.3)
    return None


def synthesize_sentence(text, profile, language):
    # POST /generate, no /generate/stream: mcp-server/index.js ya documenta que
    # /generate/stream dispara un bug de doble reproduccion en Voicebox y usa
    # /generate a proposito (ver index.js linea ~2810). Seguimos el camino probado.
    before = set(os.listdir(GENERATIONS_DIR)) if os.path.isdir(GENERATIONS_DIR) else set()
    res = _voicebox_request("/generate", method="POST", payload={
        "profile_id": profile["id"],
        "text": text,
        "language": language,
        "model_size": "1.7B",
        "engine": "qwen",
        "personality": False,
        "normalize": True
    })
    gen_id = res.get("id")
    wav_path = wait_for_generation_wav(gen_id, before)
    if not wav_path:
        raise RuntimeError(f"Voicebox nunca escribio el .wav de la generacion {gen_id}")
    return gen_id, wav_path


def voicebox_cancel(generation_id):
    if not generation_id:
        return
    try:
        _voicebox_request(f"/generate/{generation_id}/cancel", method="POST", payload={})
    except Exception:
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

    def enqueue(self, wav_path, label):
        self._queue.put((wav_path, label))

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


def main():
    parser = argparse.ArgumentParser(description="Fase 4 - loop minimo texto->voz (Modo Charla)")
    parser.add_argument("--voice", default=None, help='Perfil de voz (ej. "Diego Alvarez")')
    parser.add_argument("--language", default="es", choices=["es", "en"])
    parser.add_argument("--effort", default="low", choices=["low", "medium", "high"])
    args = parser.parse_args()

    print("[voice-loop] Conectando al servidor MCP real (mcp-server/index.js)...")
    mcp = McpClient()

    print(f"[voice-loop] Resolviendo perfil de voz en Voicebox (preferido: {args.voice or 'default'})...")
    profile = resolve_voice_profile(args.voice, args.language)
    print(f"[voice-loop] Perfil elegido: {profile['name']}")

    print("[voice-loop] Iniciando sesion agy_voice_stream (con pre-warm de Voicebox en paralelo)...")
    start_text = mcp.call_tool("agy_voice_stream", {
        "action": "start", "effort": args.effort, "mode": "plan",
        "prewarm_voicebox": True, "voicebox_model_size": "1.7B"
    })
    stream_id = start_text.split("stream_id: `")[1].split("`")[0]
    print(f"[voice-loop] Sesion lista: {stream_id}\n")

    player = AudioPlayer()
    executor = ThreadPoolExecutor(max_workers=2)
    last_generation_id = {"id": None}

    # La sintesis corre en paralelo (max_workers=2) para superponer TTS con la
    # generacion del siguiente delta, pero eso significa que la oracion N+1 puede
    # terminar de sintetizarse antes que la N. Este hilo "secuenciador" consume los
    # futures en el ORDEN en que se enviaron (no en el orden en que terminan) y
    # recien ahi encola para reproduccion - garantiza orden sin perder el paralelismo.
    synth_queue = queue.Queue()

    def sequencer():
        while True:
            item = synth_queue.get()
            if item is None:
                return
            future, text = item
            try:
                gen_id, wav_path = future.result()
                last_generation_id["id"] = gen_id
                player.enqueue(wav_path, text)
            except Exception as err:
                print(f"  ⚠️ Error sintetizando \"{text}\": {err}")

    threading.Thread(target=sequencer, daemon=True).start()

    print("Modo Charla (texto) listo. Escribi algo y presiona Enter.")
    print("Tipea mientras habla para interrumpir (barge-in simulado). 'salir' para terminar.\n")

    try:
        while True:
            try:
                user_text = input("Vos> ").strip()
            except EOFError:
                break
            if not user_text:
                continue
            if user_text.lower() in ("salir", "exit", "quit"):
                break

            # Barge-in: si todavia hay audio sonando o en cola de un turno anterior, cortarlo.
            player.barge_in()
            voicebox_cancel(last_generation_id["id"])

            mcp.call_tool("agy_voice_stream", {"action": "send", "stream_id": stream_id, "text": user_text})

            turn_complete = False
            while not turn_complete:
                time.sleep(0.15)
                drain = json.loads(mcp.call_tool("agy_voice_stream", {"action": "drain", "stream_id": stream_id}))
                turn_complete = drain["turn_complete"]
                for sentence in drain["sentences"]:
                    print(f"Agy> {sentence}")
                    future = executor.submit(synthesize_sentence, sentence, profile, args.language)
                    synth_queue.put((future, sentence))
    except KeyboardInterrupt:
        print("\n[voice-loop] Interrumpido por teclado.")
    finally:
        # Critico: sin esto, cualquier audio en cola o sonando en este momento queda
        # como un proceso powershell.exe huerfano reproduciendo en segundo plano, y
        # se superpone con el audio de la proxima corrida del script (asi sonaron
        # las "incoherencias" reportadas: dos sesiones de prueba distintas hablando
        # a la vez porque la primera nunca fue cortada al salir).
        player.barge_in()
        voicebox_cancel(last_generation_id["id"])
        print("[voice-loop] Cerrando sesion...")
        try:
            mcp.call_tool("agy_voice_stream", {"action": "stop", "stream_id": stream_id})
        except Exception:
            pass
        mcp.close()
        executor.shutdown(wait=False)


if __name__ == "__main__":
    main()
