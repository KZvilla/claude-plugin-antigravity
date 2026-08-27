#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Antigravity Claude Code Plugin — One-Command Installer (Linux / macOS)
# Usage:  curl -fsSL https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.sh | bash
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="https://github.com/KZvilla/claude-plugin-antigravity.git"
INSTALL_DIR="${HOME}/.claude/skills/antigravity"

# ── Colors ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { printf "${CYAN}[antigravity]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[✔]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
fail()  { printf "${RED}[✘]${NC} %s\n" "$*" >&2; exit 1; }

# ── Prerequisites ────────────────────────────────────────────────────
info "Checking prerequisites…"

command -v git  >/dev/null 2>&1 || fail "git is not installed. Please install git first."
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Please install Node.js >= 18."

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js >= 18 required (found v$(node -v | tr -d 'v')). Please upgrade."
fi
ok "Node.js v$(node -v | tr -d 'v')"

if command -v agy >/dev/null 2>&1; then
  ok "Antigravity CLI found: $(command -v agy)"
elif command -v agy.exe >/dev/null 2>&1; then
  ok "Antigravity CLI found: $(command -v agy.exe)"
else
  warn "Antigravity CLI (agy) not found on PATH."
  warn "The plugin will install, but won't work until agy is available."
  warn "Install guide: https://github.com/google-gemini/antigravity"
fi

# ── Install / Update ────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing git installation detected — updating…"
  git -C "$INSTALL_DIR" fetch --quiet origin main
  git -C "$INSTALL_DIR" reset --hard origin/main --quiet
  ok "Updated to latest version."
elif [ -d "$INSTALL_DIR" ]; then
  warn "Existing non-git installation detected at $INSTALL_DIR"
  info "Removing old installation and re-cloning…"
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 "$REPO" "$INSTALL_DIR"
  ok "Re-installed successfully."
else
  info "Cloning into ${INSTALL_DIR}…"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet --depth 1 "$REPO" "$INSTALL_DIR"
  ok "Cloned successfully."
fi

# ── Verify install ───────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/.claude-plugin/plugin.json" ]; then
  fail "Installation verification failed — plugin.json not found."
fi

if [ ! -f "$INSTALL_DIR/mcp-server/index.js" ]; then
  fail "Installation verification failed — mcp-server/index.js not found."
fi

ok "Plugin files verified."

# ── Done ─────────────────────────────────────────────────────────────
echo ""
printf "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${GREEN}║${NC}  Antigravity plugin installed successfully!                  ${GREEN}║${NC}\n"
printf "${GREEN}║${NC}                                                              ${GREEN}║${NC}\n"
printf "${GREEN}║${NC}  ${CYAN}Next steps:${NC}                                                ${GREEN}║${NC}\n"
printf "${GREEN}║${NC}    1. In Claude Code, run:  ${YELLOW}/reload-plugins${NC}                 ${GREEN}║${NC}\n"
printf "${GREEN}║${NC}    2. Try:  ${YELLOW}/agy Analiza este proyecto${NC}                      ${GREEN}║${NC}\n"
printf "${GREEN}║${NC}    3. Try:  ${YELLOW}/agy-review${NC}                                     ${GREEN}║${NC}\n"
printf "${GREEN}║${NC}                                                              ${GREEN}║${NC}\n"
printf "${GREEN}║${NC}  Installed at: ${CYAN}%-43s${NC} ${GREEN}║${NC}\n" "$INSTALL_DIR"
printf "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
echo ""
