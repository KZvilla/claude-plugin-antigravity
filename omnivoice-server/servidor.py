"""
Servidor OmniVoice para lagrange (plan docs/future-implementations/plan-omnivoice.md).

Segundo proveedor de voz, al lado de Voicebox: sintetiza clonando la muestra
de un perfil de Voicebox (Voicebox sigue siendo la fuente de verdad de las
voces). Corre con el Python del venv de OmniVoice
(%LOCALAPPDATA%\\lagrange-omnivoice\\venv), que instala `npm run omnivoice:install`.

Solo biblioteca estandar para el HTTP: el modo OMNIVOICE_FAKE=1 (sin torch ni
modelo, genera silencio) corre con cualquier Python, asi los tests no dependen
de que OmniVoice este instalado.

Ciclo de vida propio, sin --parent-pid: lo lanza el MCP desacoplado y vive
hasta que se apaga solo. Descarga el modelo tras `voicebox_idle_unload_minutes`
sin uso y se apaga tras `voicebox_idle_shutdown_minutes` sin modelo ni uso,
salvo que pin.json fije `omnivoice`.

Endpoints: GET /health, GET /models/status, POST /generate (sincrono),
POST /models/omnivoice/unload, POST /shutdown.
"""
import argparse
import json
import os
import threading
import time
import uuid
import wave
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HOME") or os.environ.get("USERPROFILE") or os.path.expanduser("~")
LOCAL = os.environ.get("LOCALAPPDATA") or os.path.join(HOME, "AppData", "Local")
BASE = os.environ.get("OMNIVOICE_DIR") or os.path.join(LOCAL, "lagrange-omnivoice")
ESTADO_DIR = os.environ.get("LAGRANGE_VOICEBOX_DIR") or os.path.join(HOME, ".claude", "lagrange-voicebox")
CONFIG = os.path.join(HOME, ".claude", "antigravity.json")
FAKE = os.environ.get("OMNIVOICE_FAKE") == "1"
CICLO_S = float(os.environ.get("OMNIVOICE_CICLO_S") or 10)
SIZE_MB = 2400
SR = 24000


def log(msg):
    print(f"[{datetime.now(timezone.utc).isoformat()}] [omnivoice {os.getpid()}] {msg}", flush=True)


def ahora_utc_sin_zona():
    # Mismo formato que Voicebox (ISO UTC sin zona): el MCP ya lo interpreta.
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def leer_json(ruta, defecto):
    try:
        with open(ruta, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return defecto


def escribir_atomico(ruta, datos):
    tmp = f"{ruta}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(datos, f)
    os.replace(tmp, ruta)


def config_inactividad():
    cfg = leer_json(CONFIG, {})

    def minutos(clave, defecto):
        v = cfg.get(clave, defecto)
        return float(v) if isinstance(v, (int, float)) else float(defecto)

    temp = cfg.get("omnivoice_class_temperature", 0.7)
    return {
        "unload_s": minutos("voicebox_idle_unload_minutes", 10) * 60,
        "shutdown_s": minutos("voicebox_idle_shutdown_minutes", 30) * 60,
        "class_temperature": float(temp) if isinstance(temp, (int, float)) else 0.7,
    }


def pin_es_omnivoice():
    pin = leer_json(os.path.join(ESTADO_DIR, "pin.json"), None)
    return bool(pin and pin.get("model") == "omnivoice")


class Motor:
    def __init__(self, models_dir):
        self.models_dir = models_dir
        self.lock = threading.Lock()          # una GPU, un modelo: se serializa
        self.modelo = None
        self.variante = None
        self.prompts = OrderedDict()          # LRU de VoiceClonePrompt por voz
        self.generando = False
        self.generando_desde = None
        self.ultimo_uso = time.time()

    def _cargar(self):
        if FAKE:
            self.modelo, self.variante = "fake", "fake"
            return
        import torch
        from omnivoice import OmniVoice
        cuda = torch.cuda.is_available()
        self.modelo = OmniVoice.from_pretrained(
            self.models_dir, device_map="cuda:0" if cuda else "cpu",
            dtype=torch.float16 if cuda else torch.float32)
        self.variante = "cuda" if cuda else "cpu"
        log(f"Modelo cargado ({self.variante}).")

    def descargar(self, motivo):
        with self.lock:
            if self.modelo is None:
                return False
            self.modelo = None
            self.prompts.clear()
            if not FAKE:
                import gc
                import torch
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            log(f"Modelo descargado ({motivo}).")
            return True

    def _prompt(self, ref_audio, ref_text):
        clave = (ref_audio, os.path.getmtime(ref_audio), ref_text or "")
        if clave in self.prompts:
            self.prompts.move_to_end(clave)
            return self.prompts[clave]
        p = clave if FAKE else self.modelo.create_voice_clone_prompt(ref_audio=ref_audio, ref_text=ref_text or None)
        self.prompts[clave] = p
        while len(self.prompts) > 8:
            self.prompts.popitem(last=False)
        return p

    def generar(self, texto, ref_audio, ref_text, class_temperature):
        os.makedirs(os.path.join(BASE, "generations"), exist_ok=True)
        with self.lock:
            self.generando = True
            self.generando_desde = ahora_utc_sin_zona()
            t0 = time.time()
            try:
                if self.modelo is None:
                    self._cargar()
                gen_id = str(uuid.uuid4())
                destino = os.path.join(BASE, "generations", f"{gen_id}.wav")
                if FAKE:
                    muestras = int(SR * 0.5)
                    with wave.open(destino, "wb") as w:
                        w.setnchannels(1)
                        w.setsampwidth(2)
                        w.setframerate(SR)
                        w.writeframes(b"\x00\x00" * muestras)
                    duracion = muestras / SR
                else:
                    import soundfile as sf
                    prompt = self._prompt(ref_audio, ref_text)
                    audio = self.modelo.generate(text=texto, voice_clone_prompt=prompt,
                                                 class_temperature=class_temperature)[0]
                    sf.write(destino, audio, SR)
                    duracion = len(audio) / SR
                return {"id": gen_id, "audio_path": destino, "duration": round(duracion, 2),
                        "seconds": round(time.time() - t0, 2)}
            finally:
                # En un finally: un hilo que falla nunca deja `generando` colgado.
                self.generando = False
                self.generando_desde = None
                self.ultimo_uso = time.time()

    def estado_modelos(self):
        return {
            "models": [{"model_name": "omnivoice", "loaded": self.modelo is not None,
                        "downloaded": True, "size_mb": SIZE_MB}],
            "generando": self.generando,
            "generando_desde": self.generando_desde,
        }


class Handler(BaseHTTPRequestHandler):
    motor = None
    servidor = None
    puerto = None

    def log_message(self, *_):
        pass

    def _json(self, codigo, datos):
        cuerpo = json.dumps(datos).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def _cuerpo(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except ValueError:
            return None

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"status": "healthy", "backend": "omnivoice",
                                    "variant": self.motor.variante or ("fake" if FAKE else None),
                                    "model_loaded": self.motor.modelo is not None})
        if self.path == "/models/status":
            return self._json(200, self.motor.estado_modelos())
        return self._json(404, {"detail": "no existe"})

    def do_POST(self):
        if self.path == "/generate":
            datos = self._cuerpo()
            if not datos or not str(datos.get("text") or "").strip():
                return self._json(400, {"detail": "falta text"})
            ref = datos.get("ref_audio")
            if not ref or not os.path.isfile(ref):
                return self._json(400, {"detail": f"la muestra no existe: {ref}"})
            temp = datos.get("class_temperature")
            if not isinstance(temp, (int, float)):
                temp = config_inactividad()["class_temperature"]
            try:
                return self._json(200, self.motor.generar(str(datos["text"]), ref, datos.get("ref_text"), float(temp)))
            except Exception as err:  # noqa: BLE001 — se informa al cliente, no se cae el server
                log(f"/generate falló: {err}")
                return self._json(500, {"detail": str(err)})
        if self.path == "/models/omnivoice/unload":
            return self._json(200, {"unloaded": self.motor.descargar("pedido")})
        if self.path == "/shutdown":
            self._json(200, {"message": "Shutting down..."})
            threading.Thread(target=apagar, args=("pedido",), daemon=True).start()
            return None
        return self._json(404, {"detail": "no existe"})


def escribir_estado(motor, puerto, cfg):
    liberan = None
    if motor.modelo is not None and not pin_es_omnivoice():
        restante = cfg["unload_s"] - (time.time() - motor.ultimo_uso)
        liberan = max(0, int((restante + 59) // 60))
    try:
        os.makedirs(ESTADO_DIR, exist_ok=True)
        escribir_atomico(os.path.join(ESTADO_DIR, "omnivoice-estado.json"), {
            "actualizado": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "pid": os.getpid(), "puerto": puerto, "cargado": motor.modelo is not None,
            "variante": motor.variante, "pin": pin_es_omnivoice(), "liberaEnMin": liberan,
        })
    except OSError as err:
        log(f"No se pudo escribir el estado: {err}")


def apagar(motivo):
    log(f"Termino: {motivo}.")
    try:
        os.remove(os.path.join(ESTADO_DIR, "omnivoice-estado.json"))
    except OSError:
        pass
    Handler.servidor.shutdown()


def vigilar(motor, puerto):
    while True:
        time.sleep(CICLO_S)
        cfg = config_inactividad()
        inactivo = time.time() - motor.ultimo_uso
        fijado = pin_es_omnivoice()
        if motor.modelo is not None and not motor.generando and not fijado and inactivo > cfg["unload_s"]:
            motor.descargar(f"sin uso hace {int(inactivo)} s")
        if (motor.modelo is None and not motor.generando and not fijado
                and cfg["shutdown_s"] > 0 and inactivo > cfg["shutdown_s"]):
            apagar(f"sin uso hace {int(inactivo)} s")
            return
        escribir_estado(motor, puerto, cfg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=17494)
    ap.add_argument("--models-dir", default=os.path.join(BASE, "models", "OmniVoice"))
    args = ap.parse_args()

    motor = Motor(args.models_dir)
    Handler.motor = motor
    Handler.puerto = args.port
    servidor = ThreadingHTTPServer((args.host, args.port), Handler)
    Handler.servidor = servidor
    threading.Thread(target=vigilar, args=(motor, args.port), daemon=True).start()
    escribir_estado(motor, args.port, config_inactividad())
    log(f"Escuchando en {args.host}:{args.port}{' (FAKE)' if FAKE else ''}.")
    servidor.serve_forever()


if __name__ == "__main__":
    main()
