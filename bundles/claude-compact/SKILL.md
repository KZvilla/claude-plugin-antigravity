---
name: claude-compact
description: >-
  Intercept and summarize an active or recent Claude Code session (CLI or VS Code extension)
  to generate a lossless Handoff Prompt or structured summary without calling Claude or
  suffering cache misses and token penalties. Use when the user asks to "compact session",
  "summarize claude session", "handoff from claude", "resume from claude", "extract claude context",
  or wants to continue work in a fresh Claude Code session.
metadata:
  version: 1.0.0
---

# Claude Compact (Zero-Cache-Miss Handoff & Session Summarizer)

This skill intercepts Claude Code sessions (CLI or VS Code extension) directly from the local disk (`~/.claude/sessions` and `~/.claude/projects`), parses the full JSONL transcript, and uses Antigravity (Gemini) to generate a **lossless Handoff Prompt** with zero cache misses, zero token waste, and zero cost in Claude.

## 🚀 Why Use This Skill

- **No Cache Misses:** Running `/compact` inside Claude Code blows away prompt caches and incurs expensive token generation. Executing it from Antigravity reads the local logs without touching Claude's active context.
- **Huge Context Capacity:** Gemini handles up to 1M–2M tokens without truncating reasoning, stack traces, or test outputs.
- **Lossless Handoff:** Extracts exact decisions, modified files, test verdicts, and open blockers into a ready-to-paste prompt for starting a fresh Claude session.

---

## 🛠️ Step-by-Step Procedure

### 1. Extract Session Log

Run the helper script using `run_command` in powershell:

```powershell
node "<skill_directory>/scripts/parse_claude_session.js" --cwd "<project_dir>"
```

**Common flags:**
- `--cwd "<path>"`: Target project working directory (defaults to current CWD).
- `--session "<id|pid>"`: Specific session UUID or process PID.
- `--list`: List all active sessions and recent project session logs.
- `--json`: Output structured JSON (useful when programmatically inspecting modified files and errors).

### 2. Analyze the Session Transcript

Read and synthesize the extracted session events, focusing on:
1. **Initial Goal / Objective**: What the user asked to accomplish.
2. **Key Technical & Architectural Decisions**: Architectural choices, rejected alternatives, and why specific approaches were chosen.
3. **Files Touched**: Concrete list of files created, modified, or deleted, and what changed in each.
4. **Validation & Tests**: Test commands executed, pass/fail status, and fixed intermittent bugs.
5. **Pending / Current State**: Unfinished tasks, blockers, or active discussion points.

### 3. Generate Output (Default vs File)

#### **Default Behavior (Print for Copy & Paste):**
By default, format and output the **Claude Code Handoff Prompt** directly in the response inside a copy-ready Markdown block.

The structure must be:

```markdown
# 🔄 Handoff de Sesión de Claude Code (Resumen de Contexto)

> **Sesión Anterior:** `<session-id-short>` | **Proyecto:** `<cwd>` | **Branch:** `<git-branch>`

---

### 📋 Objetivo y Resumen Ejecutivo
<1-2 párrafos claros sobre lo que se trabajó y el estado actual del repositorio>

### 🛠️ Decisiones Técnicas y Arquitectura
- **Decisión 1:** <contexto → decisión → justificación>
- **Decisión 2:** ...

### 📁 Archivos Modificados / Creados
- `ruta/al/archivo.ext`: <qué se modificó y por qué>
- `otra/ruta.ext`: ...

### 🧪 Pruebas y Validación
- <Comandos ejecutados, tests añadidos/arreglados, resultados obtenidos>

### 🚧 Pendientes y Próximos Pasos Inmediatos
1. <Paso 1 pendiente>
2. <Paso 2 pendiente>

---

### 💬 Prompt para Iniciar Nueva Sesión en Claude Code (Copiar y Pegar)
```text
Hola Claude, retomamos el trabajo en este repositorio. Aquí tienes el contexto exacto de la sesión anterior:

[RESUMEN]
<Resumen conciso de 3-5 líneas del estado actual y decisiones clave>

[ARCHIVOS CLAVE]
- <archivos relevantes modificados recientemente>

[TAREA INMEDIATA]
<Instrucción clara y directa para el próximo paso a ejecutar>
```
```

#### **File Output (Only if Explicitly Requested):**
If and only if the user explicitly asks to save it to a file (e.g. *"guárdalo en un archivo md"* or *"salva el resumen en docs/"*), write it to:
- `<project_root>/docs/sessions/YYYY-MM-DD-<session-id-short>.md` (or custom path requested).
- Include YAML frontmatter (`session_id`, `project`, `branch`, `date`, `summarized_by: "claude-compact-skill"`).
