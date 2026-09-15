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
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

from common import (  # noqa: E402
    McpClient, AudioPlayer, SentenceSequencer,
    resolve_voice_request, resolve_and_activate_voice, synthesize_sentence, voicebox_cancel,
    unload_all_loaded_models, LatidoUso, tts_model_name,
    Senales, TiemposTurno, decidir_senal, clave_de_paso,
    accion_para_turno, pregunta_de_negaciones, aviso_escrituras, AVISO_CONFIRMACION
)


def main():
    parser = argparse.ArgumentParser(description="Fase 4 - loop minimo texto->voz (Modo Charla)")
    parser.add_argument("--voice", default=None, help='Perfil de voz (ej. "Diego Alvarez")')
    parser.add_argument("--language", default=None, choices=["es", "en"])
    parser.add_argument("--soul", default=None, help="Clave Soul para la identidad; es independiente del perfil acústico.")
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
    # 2500: ver voice_loop.py ("Pensando" no debe sonar en un turno trivial).
    parser.add_argument("--senal-ms", type=int, default=2500,
                         help='Si agy no emite texto ni usa una herramienta en este tiempo, suena "Pensando" '
                              "(senales pregrabadas, solo OmniVoice). 0 desactiva todas las senales.")
    args = parser.parse_args()

    if args.unload_all:
        freed_gb = unload_all_loaded_models()
        print(f"\nTotal liberado: {freed_gb:.2f} GB" if freed_gb else "Nada estaba cargado.")
        return

    try:
        selected = resolve_voice_request(args.voice, args.language, os.getcwd(), args.motor,
                                         args.engine, args.model_size, args.soul)
    except RuntimeError as err:
        print(f"[voice-loop] {err}")
        return
    print("[voice-loop] Conectando al servidor MCP real (mcp-server/index.js)...")
    mcp = McpClient()

    if args.soltar_pin:
        print("[voice-loop] " + mcp.call_tool("agy_voice_model", {"action": "release"}))

    try:
        profile, args.language, engine, model_size, proveedor, muestra, rechazados = resolve_and_activate_voice(mcp, selected)
    except RuntimeError as err:
        print(f"[voice-loop] {err}")
        print("[voice-loop] Si hay un modelo fijado de otra voz, volve a correr con --soltar-pin.")
        mcp.close()
        return
    print(f"[voice-loop] Perfil elegido: {profile['name']}")
    voz = "OmniVoice" if proveedor == "omnivoice" else f"Voicebox · {engine}" + (f" ({model_size})" if model_size else "")
    print(f"[voice-loop] Voz: {voz}")
    latido = LatidoUso(["omnivoice" if proveedor == "omnivoice" else tts_model_name(engine, model_size)])

    player = AudioPlayer()
    executor = ThreadPoolExecutor(max_workers=2)
    last_generation_id = {"id": None}
    sequencer = SentenceSequencer(player, last_generation_id)

    # Senales solo con OmniVoice (ver voice_loop.py). Se generan mientras
    # arranca la sesion de agy.
    turno_en_curso = {"activo": False}
    futuros = []
    senales = None
    if proveedor == "omnivoice" and args.senal_ms > 0:
        senales = Senales(profile, args.language, engine, model_size, proveedor, muestra,
                          ocupado=lambda: turno_en_curso["activo"] or player.is_active()
                          or any(not f.done() for f in list(futuros)))
    # Sin VAD no hay token de barge-in: cada Enter abre un turno nuevo y las
    # oraciones de los anteriores se descartan al terminar de sintetizarse.
    turno = {"n": 0}
    # Charla con freno (plan-charla-modo-agente): cuando se pregunto por algo
    # que agy tuvo negado. Vale solo para la frase siguiente.
    por_confirmar = {"t": None}

    con_prewarm = proveedor == "voicebox" and engine in ("qwen", "qwen_custom_voice")
    print("[voice-loop] Iniciando sesion agy_voice_stream" +
          (" (con pre-warm de Voicebox en paralelo)" if con_prewarm else "") + "...")
    start_args = {
        # cwd: sin el, agy corre los comandos en su scratch/ y no en el proyecto.
        "action": "start", "effort": args.effort, "confirmacion": True, "cwd": os.getcwd(),
        # alma: identidad y memoria de esta voz en el priming, y consolidacion
        # al cerrar (FEAT-044).
        "alma": selected["identity"].get("soul") if selected["identity"].get("mode") == "soul" else None,
        "prewarm_voicebox": con_prewarm,
        "voice": profile["name"]
    }
    if model_size:
        start_args["voicebox_model_size"] = model_size
    start_text = mcp.call_tool("agy_voice_stream", start_args)
    stream_id = start_text.split("stream_id: `")[1].split("`")[0]
    print(f"[voice-loop] Sesion lista: {stream_id}")
    print(f"[voice-loop] ⚠️ {AVISO_CONFIRMACION.get(args.language) or AVISO_CONFIRMACION['en']}\n")

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
            # El turno sube antes, para que una sintesis vieja que termine justo
            # ahora ya se descarte.
            turno["n"] += 1
            mi_turno = turno["n"]
            player.barge_in()
            voicebox_cancel(last_generation_id["id"])

            # Sin VAD: t0 es el Enter y el turno siempre esta vigente.
            tiempos = TiemposTurno()
            turno_en_curso["activo"] = True
            hubo_oracion = False

            def al_primer_audio(t=tiempos):
                t.marcar("primer_audio")
                t.imprimir_una_vez()

            # Un "sí" corto a la pregunta anterior autoriza; cualquier otra
            # frase descarta la pregunta y va como turno normal.
            accion, texto_envio = accion_para_turno(user_text, args.language, por_confirmar["t"], time.monotonic())
            por_confirmar["t"] = None
            es_ejecucion = accion == "confirm"
            escrituras = []
            negadas = []
            corrio = []

            # Un error de MCP en el turno se informa y la charla sigue.
            try:
                if es_ejecucion:
                    print("  ✅ " + mcp.call_tool("agy_voice_stream", {"action": "confirm", "stream_id": stream_id}))
                else:
                    mcp.call_tool("agy_voice_stream", {"action": "send", "stream_id": stream_id, "text": texto_envio})
                t_envio = time.monotonic()
                tiempos.marcar("envio")
                pendiente = None  # ver voice_loop.py
                ultima_clave = None
                t_ultima = None
                sonaron = 0

                turn_complete = False
                while not turn_complete:
                    time.sleep(0.15)
                    drain = json.loads(mcp.call_tool("agy_voice_stream", {"action": "drain", "stream_id": stream_id}))
                    turn_complete = drain["turn_complete"]
                    if drain.get("deltas"):
                        tiempos.marcar("primer_texto")
                    escrituras += drain.get("escrituras") or []
                    if turn_complete:
                        negadas = drain.get("negadas") or []
                    for paso in drain.get("detalles") or drain.get("herramientas") or []:
                        tiempos.marcar("herramienta")
                        if es_ejecucion:
                            corrio.append(paso if isinstance(paso, str) else
                                          "/".join(x for x in (paso.get("servidor"), paso.get("accion")) if x)
                                          or paso.get("nombre") or "?")
                        clave_paso = clave_de_paso(paso, es_ejecucion)
                        if clave_paso and clave_paso != ultima_clave:
                            pendiente = clave_paso
                    if senales:
                        ahora = time.monotonic()
                        clave = decidir_senal(
                            tiempos.marca("primer_texto") is not None, player.is_active(),
                            turno["n"] == mi_turno, pendiente, ultima_clave,
                            (ahora - t_ultima) * 1000 if t_ultima else 0,
                            (ahora - t_envio) * 1000, args.senal_ms, sonaron)
                        ruta = senales.elegir(clave) if clave else None
                        if ruta:
                            player.enqueue(ruta, f"(señal: {clave})", borrar=False)
                            tiempos.marcar("senal")
                            ultima_clave, t_ultima = clave, ahora
                            sonaron += 1
                            if clave != "pensando":
                                pendiente = None
                    for sentence in drain["sentences"]:
                        print(f"Agy> {sentence}")
                        tiempos.marcar("primera_oracion")
                        hubo_oracion = True
                        future = executor.submit(synthesize_sentence, sentence, profile, args.language, engine,
                                                 model_size, proveedor, muestra)
                        futuros.append(future)
                        del futuros[:-8]
                        sequencer.submit(future, sentence, al_empezar=al_primer_audio,
                                         vigente=lambda n=mi_turno: turno["n"] == n)

                # Cierre del turno: lo que corrio con permisos plenos, lo que
                # agy escribio sin preguntar y la pregunta por lo negado.
                if corrio:
                    print("  🔧 Corrió con permisos plenos: " + ", ".join(corrio))
                for frase in (aviso_escrituras(escrituras, args.language), pregunta_de_negaciones(negadas, args.language)):
                    if not frase:
                        continue
                    print(f"Charla> {frase}")
                    hubo_oracion = True
                    future = executor.submit(synthesize_sentence, frase, profile, args.language, engine,
                                             model_size, proveedor, muestra)
                    futuros.append(future)
                    del futuros[:-8]
                    sequencer.submit(future, frase, al_empezar=al_primer_audio,
                                     vigente=lambda n=mi_turno: turno["n"] == n)
                if negadas:
                    por_confirmar["t"] = time.monotonic()
                    print('  (respondé "sí" para autorizarlo, o cualquier otra cosa para seguir)')
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
        if senales:
            senales.stop()


if __name__ == "__main__":
    main()
