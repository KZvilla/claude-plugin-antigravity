#!/usr/bin/env python3
"""
Fase 4 (Modo Charla) - loop completo con microfono real + Silero VAD.

Microfono -> Silero VAD (deteccion de voz en vivo, ~32ms por frame) ->
Voicebox POST /transcribe (Whisper) -> agy_voice_stream -> SentenceChunker
(via "drain") -> Voicebox POST /generate -> reproduccion local en cola FIFO.

Barge-in REAL (no simulado): en cuanto el VAD detecta que el usuario empieza
a hablar, se corta la reproduccion en curso y se cancela cualquier sintesis
en vuelo en Voicebox, sin importar en que parte del pipeline este el turno
anterior.

A diferencia de text_loop.py, esto SI tiene dependencias pip (ver
voice-chat/requirements.txt): sounddevice para captura de audio, silero-vad
+ torch para deteccion de voz. No hay forma de evitarlas para audio real.

Uso:
    python3 voice-chat/voice_loop.py [--voice "Diego Alvarez"] [--language es]
                                      [--device <indice o nombre>] [--vad-threshold 0.5]
"""

import argparse
import io
import json
import queue
import sys
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    import numpy as np
    import sounddevice as sd
    import torch
    from silero_vad import load_silero_vad
except ImportError as err:
    print(f"[voice-loop] Falta una dependencia: {err}")
    print("Instala con: pip install -r voice-chat/requirements.txt")
    sys.exit(1)

from common import (  # noqa: E402
    McpClient, AudioPlayer, SentenceSequencer,
    resolve_voice_profile, synthesize_sentence, voicebox_cancel, transcribe_wav_bytes
)

SAMPLE_RATE = 16000
BLOCK_SIZE = 512  # ~32ms a 16kHz - tamano de ventana que espera Silero VAD


def float32_to_wav_bytes(samples, sample_rate=SAMPLE_RATE):
    int16 = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(int16.tobytes())
    return buf.getvalue()


class VadListener:
    """Escucha el microfono en vivo y arma "utterances" (turnos de habla) usando
    Silero VAD, frame por frame. Cuando detecta el INICIO de una utterance, llama
    on_speech_start() de inmediato (para barge-in real). Cuando detecta el FIN
    (silencio sostenido), llama on_utterance(audio_float32_samples)."""

    def __init__(self, device, threshold, min_silence_ms, on_speech_start, on_utterance):
        self.device = device
        self.threshold = threshold
        self.min_silence_frames = max(1, round(min_silence_ms / (BLOCK_SIZE / SAMPLE_RATE * 1000)))
        self.on_speech_start = on_speech_start
        self.on_utterance = on_utterance

        self._vad_model = load_silero_vad()
        self._audio_q = queue.Queue()
        self._stop = threading.Event()

    def start(self):
        threading.Thread(target=self._consume_loop, daemon=True).start()
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="float32",
            blocksize=BLOCK_SIZE, device=self.device,
            callback=self._on_audio_block
        )
        self._stream.start()

    def stop(self):
        self._stop.set()
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:
            pass

    def _on_audio_block(self, indata, frames, time_info, status):
        self._audio_q.put(indata[:, 0].copy())

    def _consume_loop(self):
        speaking = False
        silence_run = 0
        utterance_chunks = []
        # ~10 bloques (~320ms) de pre-roll para no perder la primera silaba
        preroll = []
        preroll_max = 10

        while not self._stop.is_set():
            try:
                block = self._audio_q.get(timeout=0.5)
            except queue.Empty:
                continue

            prob = self._vad_model(torch.from_numpy(block), SAMPLE_RATE).item()

            if not speaking:
                preroll.append(block)
                if len(preroll) > preroll_max:
                    preroll.pop(0)

            if prob >= self.threshold:
                if not speaking:
                    speaking = True
                    utterance_chunks = list(preroll)
                    self.on_speech_start()
                utterance_chunks.append(block)
                silence_run = 0
            elif speaking:
                utterance_chunks.append(block)
                silence_run += 1
                if silence_run >= self.min_silence_frames:
                    speaking = False
                    silence_run = 0
                    audio = np.concatenate(utterance_chunks) if utterance_chunks else np.array([], dtype="float32")
                    utterance_chunks = []
                    preroll = []
                    if len(audio) / SAMPLE_RATE >= 0.3:  # descarta ruidos ultra-cortos
                        self.on_utterance(audio)


def main():
    parser = argparse.ArgumentParser(description="Fase 4 - loop completo con mic + VAD (Modo Charla)")
    parser.add_argument("--voice", default=None, help='Perfil de voz (ej. "Diego Alvarez")')
    parser.add_argument("--language", default="es", choices=["es", "en"])
    parser.add_argument("--effort", default="low", choices=["low", "medium", "high"])
    parser.add_argument("--device", default=None, help="Indice o nombre (parcial) del dispositivo de entrada")
    parser.add_argument("--vad-threshold", type=float, default=0.5)
    parser.add_argument("--min-silence-ms", type=int, default=600, help="Silencio para cerrar una utterance")
    parser.add_argument("--list-devices", action="store_true", help="Lista dispositivos de audio y sale")
    args = parser.parse_args()

    if args.list_devices:
        print(sd.query_devices())
        return

    device = args.device
    if device is not None:
        try:
            device = int(device)
        except ValueError:
            pass  # se deja como substring de nombre; sounddevice lo resuelve

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
    sequencer = SentenceSequencer(player, last_generation_id)

    # Token de generacion: cada barge-in real (detectado por VAD) lo incrementa.
    # El turn worker descarta oraciones de un turno cuyo token quedo viejo, para
    # que un turno interrumpido no "reviva" hablando despues del corte.
    generation_token = {"value": 0}
    turn_queue = queue.Queue()

    def on_speech_start():
        generation_token["value"] += 1
        if player.is_active():
            player.barge_in()
            voicebox_cancel(last_generation_id["id"])
        print("\U0001F3A4 Te escucho...")

    def on_utterance(audio_samples):
        turn_queue.put(audio_samples)

    def turn_worker():
        while True:
            audio_samples = turn_queue.get()
            my_token = generation_token["value"]
            try:
                wav_bytes = float32_to_wav_bytes(audio_samples)
                text = transcribe_wav_bytes(wav_bytes, language=args.language)
            except Exception as err:
                print(f"  ⚠️ Error transcribiendo: {err}")
                continue

            if not text or len(text.strip()) < 2:
                continue
            if generation_token["value"] != my_token:
                continue  # te interrumpiste a vos mismo antes de terminar de transcribir

            print(f"Vos> {text}")
            mcp.call_tool("agy_voice_stream", {"action": "send", "stream_id": stream_id, "text": text})

            turn_complete = False
            while not turn_complete:
                time.sleep(0.15)
                drain = json.loads(mcp.call_tool("agy_voice_stream", {"action": "drain", "stream_id": stream_id}))
                turn_complete = drain["turn_complete"]
                for sentence in drain["sentences"]:
                    if generation_token["value"] != my_token:
                        continue  # barge-in ocurrio mientras agy seguia respondiendo
                    print(f"Agy> {sentence}")
                    future = executor.submit(synthesize_sentence, sentence, profile, args.language)
                    sequencer.submit(future, sentence)

    threading.Thread(target=turn_worker, daemon=True).start()

    listener = VadListener(
        device=device, threshold=args.vad_threshold, min_silence_ms=args.min_silence_ms,
        on_speech_start=on_speech_start, on_utterance=on_utterance
    )
    listener.start()

    print("Modo Charla (mic) listo. Hablá cuando quieras.")
    print("Interrumpí hablando encima mientras responde (barge-in real). Ctrl+C para terminar.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[voice-loop] Interrumpido por teclado.")
    finally:
        listener.stop()
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
