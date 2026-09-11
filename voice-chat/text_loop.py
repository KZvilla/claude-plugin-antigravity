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

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from common import (  # noqa: E402
    McpClient, AudioPlayer, SentenceSequencer,
    resolve_voice_profile, synthesize_sentence, voicebox_cancel,
    get_model_status, resolve_engine_and_model, unload_all_loaded_models,
    LatidoUso, tts_model_name, activar_motor_chat,
    Muletillas, TiemposTurno, decidir_muletilla
)


def main():
    parser = argparse.ArgumentParser(description="Fase 4 - loop minimo texto->voz (Modo Charla)")
    parser.add_argument("--voice", default=None, help='Perfil de voz (ej. "Diego Alvarez")')
    parser.add_argument("--language", default="es", choices=["es", "en"])
    parser.add_argument("--effort", default="low", choices=["low", "medium", "high"])
    parser.add_argument("--engine", default=None,
                         help="Forzar motor TTS (qwen, qwen_custom_voice, kokoro, luxtts, chatterbox, chatterbox_turbo, tada). "
                              "Por defecto usa el default_engine del perfil elegido.")
    parser.add_argument("--model-size", default=None, help='Forzar tamano de modelo (ej. "1.7B", "0.6B") - solo aplica a motores Qwen.')
    parser.add_argument("--unload-all", action="store_true",
                         help="Descargar TODO lo que Voicebox tenga cargado ahora mismo (de cualquier corrida previa) y salir.")
    parser.add_argument("--soltar-pin", action="store_true",
                         help="Soltar el modelo fijado antes de empezar (si choca con el motor de la voz elegida).")
    parser.add_argument("--motor", default=None, choices=["omnivoice", "voicebox"],
                         help="Proveedor de voz. Por defecto OmniVoice si la voz tiene muestra, salvo voz_por_perfil.")
    # 3000: ver voice_loop.py (Gemini tarda ~2 s incluso sin herramientas).
    parser.add_argument("--muletilla-ms", type=int, default=3000,
                         help="Si agy no emite texto en este tiempo, suena una muletilla pregrabada (solo OmniVoice). 0 las desactiva.")
    args = parser.parse_args()

    if args.unload_all:
        freed_gb = unload_all_loaded_models()
        print(f"\nTotal liberado: {freed_gb:.2f} GB" if freed_gb else "Nada estaba cargado.")
        return

    print("[voice-loop] Conectando al servidor MCP real (mcp-server/index.js)...")
    mcp = McpClient()

    # Voicebox arriba sin depender de la GUI: el MCP lo levanta si hace falta.
    print("[voice-loop] " + mcp.call_tool("agy_voice_model", {"action": "start"}).splitlines()[0])
    if args.soltar_pin:
        print("[voice-loop] " + mcp.call_tool("agy_voice_model", {"action": "release"}))

    print(f"[voice-loop] Resolviendo perfil de voz en Voicebox (preferido: {args.voice or 'default'})...")
    profile = resolve_voice_profile(args.voice, args.language)
    print(f"[voice-loop] Perfil elegido: {profile['name']}")

    # No asumir "qwen"/"1.7B": cada perfil declara su propio default_engine y lo
    # que esta realmente descargado varia por maquina - se consulta en vivo.
    model_status = get_model_status()
    engine, model_size = resolve_engine_and_model(profile, model_status, args.engine, args.model_size)

    # El modelo de esta voz pasa a ser el activo antes de empezar: si hay otro
    # fijado, o no hay VRAM, se dice ahora y no a mitad de la charla.
    # La charla va por OmniVoice si la voz tiene muestra (regla del usuario).
    try:
        proveedor, muestra = activar_motor_chat(mcp, profile, engine, model_size, args.motor)
    except RuntimeError as err:
        print(f"[voice-loop] {err}")
        print("[voice-loop] Si hay un modelo fijado de otra voz, volve a correr con --soltar-pin.")
        mcp.close()
        return
    voz = "OmniVoice" if proveedor == "omnivoice" else f"Voicebox · {engine}" + (f" ({model_size})" if model_size else "")
    print(f"[voice-loop] Voz: {voz}")
    latido = LatidoUso(["omnivoice" if proveedor == "omnivoice" else tts_model_name(engine, model_size)])

    player = AudioPlayer()
    executor = ThreadPoolExecutor(max_workers=2)
    last_generation_id = {"id": None}
    sequencer = SentenceSequencer(player, last_generation_id)

    # Muletillas solo con OmniVoice (ver voice_loop.py). Se generan mientras
    # arranca la sesion de agy.
    turno_en_curso = {"activo": False}
    futuros = []
    muletillas = None
    if proveedor == "omnivoice" and args.muletilla_ms > 0:
        muletillas = Muletillas(profile, args.language, engine, model_size, proveedor, muestra,
                                ocupado=lambda: turno_en_curso["activo"] or player.is_active()
                                or any(not f.done() for f in list(futuros)))

    con_prewarm = proveedor == "voicebox" and engine in ("qwen", "qwen_custom_voice")
    print("[voice-loop] Iniciando sesion agy_voice_stream" +
          (" (con pre-warm de Voicebox en paralelo)" if con_prewarm else "") + "...")
    start_text = mcp.call_tool("agy_voice_stream", {
        "action": "start", "effort": args.effort, "mode": "plan",
        "prewarm_voicebox": con_prewarm, "voicebox_model_size": model_size or "1.7B"
    })
    stream_id = start_text.split("stream_id: `")[1].split("`")[0]
    print(f"[voice-loop] Sesion lista: {stream_id}\n")

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

            # Sin VAD: t0 es el Enter y el turno siempre esta vigente.
            tiempos = TiemposTurno()
            turno_en_curso["activo"] = True
            hubo_oracion = False

            def al_primer_audio(t=tiempos):
                t.marcar("primer_audio")
                t.imprimir_una_vez()

            # Un error de MCP en el turno se informa y la charla sigue.
            try:
                mcp.call_tool("agy_voice_stream", {"action": "send", "stream_id": stream_id, "text": user_text})
                t_envio = time.monotonic()
                tiempos.marcar("envio")
                muletilla_sono = False

                turn_complete = False
                while not turn_complete:
                    time.sleep(0.15)
                    drain = json.loads(mcp.call_tool("agy_voice_stream", {"action": "drain", "stream_id": stream_id}))
                    turn_complete = drain["turn_complete"]
                    if drain.get("deltas"):
                        tiempos.marcar("primer_texto")
                    hubo_herramienta = bool(drain.get("herramientas"))
                    if hubo_herramienta:
                        tiempos.marcar("herramienta")
                    if muletillas and decidir_muletilla(
                            muletilla_sono, tiempos.marca("primer_texto") is not None, player.is_active(),
                            True, hubo_herramienta, (time.monotonic() - t_envio) * 1000, args.muletilla_ms):
                        ruta = muletillas.elegir()
                        if ruta:
                            player.enqueue(ruta, "(muletilla)", borrar=False)
                            tiempos.marcar("muletilla")
                            muletilla_sono = True
                    for sentence in drain["sentences"]:
                        print(f"Agy> {sentence}")
                        tiempos.marcar("primera_oracion")
                        hubo_oracion = True
                        future = executor.submit(synthesize_sentence, sentence, profile, args.language, engine,
                                                 model_size, proveedor, muestra)
                        futuros.append(future)
                        del futuros[:-8]
                        sequencer.submit(future, sentence, al_empezar=al_primer_audio)
            except Exception as err:
                print(f"  ⚠️ Error en el turno: {err}")
            finally:
                turno_en_curso["activo"] = False
            if not hubo_oracion:
                tiempos.imprimir_una_vez()
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
        latido.stop()
        if muletillas:
            muletillas.stop()


if __name__ == "__main__":
    main()
