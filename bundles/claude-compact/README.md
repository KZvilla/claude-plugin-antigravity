# 📦 Claude Compact — Antigravity Skill Bundle

> **Skill para Google Antigravity:** Intercepta sesiones activas o recientes de **Claude Code** (CLI o extensión de VS Code) y genera un **Handoff Prompt** lossless con cero cache misses y cero gasto de tokens en Claude.

---

## ⚡ Instalación en otra PC (1 Paso)

### 🪟 Windows (PowerShell):
Abre una terminal PowerShell en esta carpeta y ejecuta:
```powershell
.\install.ps1
```

### 🍎 macOS / 🐧 Linux (Bash):
Abre una terminal en esta carpeta y ejecuta:
```bash
chmod +x install.sh && ./install.sh
```

---

## 📂 Instalación Manual (Sin Script)

Si prefieres copiarlo a mano, simplemente copia la carpeta a la ruta global de skills de Antigravity:

* **Windows:**  
  `C:\Users\<TuUsuario>\.gemini\config\skills\claude-compact\`
* **macOS / Linux:**  
  `~/.gemini/config/skills/claude-compact/`

Estructura esperada:
```text
~/.gemini/config/skills/claude-compact/
├── SKILL.md
└── scripts/
    └── parse_claude_session.js
```

---

## 🚀 Requisitos

- **Node.js** (v18 o superior) instalado en el sistema.
- **Antigravity** (CLI o IDE).

---

## 💡 Cómo Usarla en Antigravity

Una vez instalada, solo háblale normalmente a Antigravity en cualquier proyecto:

* *"Resume la sesión de Claude Code para hacer un handoff"*
* *"Haz un compact de la sesión actual de Claude"*
* *"Lista las sesiones de Claude abiertas"*
* *(Opcional)* *"Genera el handoff de Claude y guárdalo en docs/session.md"*
