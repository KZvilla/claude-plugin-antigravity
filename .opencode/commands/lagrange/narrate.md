---
description: Speak a summary using the configured voice setup or an explicit profile
---

Narrate a voice update of the latest task/checkpoint using Voicebox TTS.

Requested voice / options (may be empty - if so, use `voice_setup`):
$ARGUMENTS

Instructions:
1. Parse the user's argument:
   - If a profile is named, pass that exact name as `voice`; this is one-shot consent.
   - If only a language is named, pass `language` and let `voice_setup` choose its declared default.
   - If omitted, do not invent a profile: omit `voice`/`language` and use `voice_setup.default_language`.
   - A `soul:<key>` request maps to `soul`; never derive Soul identity from the acoustic profile.
   - Persona / Personality mode:
     * If user explicitly asks for personality (mentions "personality", "personaje", "con estilo", "humor") -> pass `personality: true`
     * Otherwise -> default to `personality: false` (clean professional tone).
2. Call the `lagrange_agy_narrate` tool with `local_playback: true`.
   The tool's own default is `false` (silent generation for background/agentic use), but someone
   typing `/lagrange/narrate` is asking to *hear* it, so this command always plays it aloud.
   Pass `local_playback: false` only if the user explicitly asks to keep the PC silent
   (e.g. "mandamelo solo al telefono", "sin sonido aca").
3. The plugin will automatically:
   - Resolve identity and acoustic delivery independently
   - Extract the latest checkpoint from the session log (without consuming your context tokens)
   - Preserve the narration as text when no declared audio route is usable
   - Generate a concise spoken narration script using Gemini (`agy`)
   - Synthesize the audio via Voicebox `POST /generate` and play the resulting `.wav` with the
     native OS player. It does not use `POST /speak`, which double-plays.
   - Also deliver it as a Telegram voice note when the bridge is configured (`send_telegram`
     defaults to true; pass `false` to suppress).
4. Present the tool's confirmation message to the user, highlighting the spoken text and voice profile used.
