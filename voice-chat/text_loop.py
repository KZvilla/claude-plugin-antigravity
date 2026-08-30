#!/usr/bin/env python3
"""
Fase 4 (Modo Charla) - loop minimo texto -> voz.

Consola (texto) -> agy_voice_stream (servidor MCP real, hablado por JSON-RPC
sobre stdio, el mismo protocolo que usa Claude Code) -> SentenceChunker
(ya integrado del lado servidor, expuesto via la accion "drain") ->
Voicebox POST /generate -> reproduccion local en cola FIFO con "barge-in"
(tipear mientras habla corta el audio y descarta lo pendiente).

Entrada por consola, sin microfono - ver voice_loop.py para captura de mic
real + Silero VAD. Cero dependencias pip aca: solo stdlib de Python, igual
que el servidor Node (mcp-server/index.js dice "zero external dependencies"
en su propio encabezado).

Uso:
    python3 voice-chat/text_loop.py [--voice "Diego Alvarez"] [--language es] [--effort low]
"""

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from common import (  # noqa: E402
    McpClient, AudioPlayer, SentenceSequencer,
    resolve_voice_profile, synthesize_sentence, voicebox_cancel
)


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
    sequencer = SentenceSequencer(player, last_generation_id)

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
                    sequencer.submit(future, sentence)
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
