---
description: Narrate a spoken voice summary of the latest completed checkpoint or task via Voicebox Text-To-Speech (zero Claude tokens)
argument-hint: ["emily" | "diego" | "<voice-name>" | "personality"]
---

Narrate a voice update of the latest task/checkpoint using Voicebox TTS:

${ARGUMENTS:-default voice}

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
2. Call the `mcp__antigravity__agy_narrate` tool.
3. The plugin will automatically:
   - Check Voicebox connection on `http://127.0.0.1:17493` (or configured port)
   - Extract the latest checkpoint from the session log (without consuming your context tokens)
   - Read the voice profile metadata (name, description, personality) dynamically from Voicebox
   - Generate a concise spoken narration script using Gemini (`agy`)
   - Send the text to Voicebox `/speak` to play aloud through the user's speakers.
4. Present the tool's confirmation message to the user, highlighting the spoken text and voice profile used.
