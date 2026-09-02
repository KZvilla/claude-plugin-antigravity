---
description: Speak a summary of the latest checkpoint out loud via Voicebox TTS
argument-hint: ["emily" | "diego" | "<voice-name>" | "personality"]
---

Narrate a voice update of the latest task/checkpoint using Voicebox TTS.

Requested voice / options (may be empty — if so, use the defaults below):
$ARGUMENTS

Instructions:
1. Parse the user's argument:
   - Voice selection:
     * If argument mentions "emily", "aria", "aiden", or "en" / "english" -> pass `voice: "Emily"`, `language: "en"`
     * If argument mentions "diego", "alvarez", "isabel", "anna", or "es" / "spanish" -> pass `voice: "Diego Alvarez"`, `language: "es"`
     * If a specific profile name is provided (e.g. "bananero", "aria", "mi voz") -> pass it as `voice`
     * If omitted -> default to "Diego Alvarez" for Spanish or "Emily" for English.
   - Persona / Personality mode:
     * If user explicitly asks for personality (mentions "personality", "personaje", "con estilo", "humor") -> pass `personality: true`
     * Otherwise -> default to `personality: false` (clean professional tone).
2. Call the `mcp__antigravity__agy_narrate` tool with `local_playback: true`.
   The tool's own default is `false` (silent generation for background/agentic use), but someone
   typing `/antigravity:narrate` is asking to *hear* it, so this command always plays it aloud.
   Pass `local_playback: false` only if the user explicitly asks to keep the PC silent
   (e.g. "mandámelo solo al teléfono", "sin sonido acá").
3. The plugin will automatically:
   - Check Voicebox connection on `http://127.0.0.1:17493` (or configured port)
   - Extract the latest checkpoint from the session log (without consuming your context tokens)
   - Read the voice profile metadata (name, description, personality) dynamically from Voicebox
   - Generate a concise spoken narration script using Gemini (`agy`)
   - Synthesize the audio via Voicebox `POST /generate` and play the resulting `.wav` with the
     native OS player. It does not use `POST /speak`, which double-plays.
   - Also deliver it as a Telegram voice note when the bridge is configured (`send_telegram`
     defaults to true; pass `false` to suppress).
4. Present the tool's confirmation message to the user, highlighting the spoken text and voice profile used.
