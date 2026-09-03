#!/usr/bin/env bash

# Claude Compact Skill — Installer for Linux / macOS
# Copies claude-compact skill to global Antigravity skills directory (~/.gemini/config/skills/claude-compact)

set -e

echo ""
echo "🚀 Installing claude-compact skill for Antigravity..."

# 1. Check Node.js
if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v)
    echo "✔ Node.js detected: $NODE_VER"
else
    echo "⚠ Warning: Node.js was not found in PATH. Please install Node.js (v18+) for the session parser helper."
fi

# 2. Target Directory
TARGET_DIR="$HOME/.gemini/config/skills/claude-compact"
SCRIPTS_DIR="$TARGET_DIR/scripts"

mkdir -p "$SCRIPTS_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 3. Copy files
cp "$SCRIPT_DIR/SKILL.md" "$TARGET_DIR/SKILL.md"
echo "✔ Installed SKILL.md -> $TARGET_DIR/SKILL.md"

cp "$SCRIPT_DIR/scripts/parse_claude_session.js" "$SCRIPTS_DIR/parse_claude_session.js"
chmod +x "$SCRIPTS_DIR/parse_claude_session.js"
echo "✔ Installed helper script -> $SCRIPTS_DIR/parse_claude_session.js"

# 4. Verification
if node "$SCRIPTS_DIR/parse_claude_session.js" --help >/dev/null 2>&1; then
    echo ""
    echo "🎉 Installation successful! claude-compact is now available globally in Antigravity."
    echo "   You can now invoke it in Antigravity by asking:"
    echo "   - 'Resume la sesión de Claude Code para hacer un handoff'"
    echo "   - 'Haz un compact de la sesión actual de Claude'"
    echo "   - 'Lista las sesiones de Claude abiertas'"
else
    echo "✔ Files installed to $TARGET_DIR"
fi
echo ""
