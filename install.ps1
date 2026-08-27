# ──────────────────────────────────────────────────────────────────────
# Antigravity Claude Code Plugin — One-Command Installer (Windows)
# Usage:  irm https://raw.githubusercontent.com/KZvilla/claude-plugin-antigravity/main/install.ps1 | iex
# ──────────────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"

$Repo       = "https://github.com/KZvilla/claude-plugin-antigravity.git"
$InstallDir = Join-Path $env:USERPROFILE ".claude\skills\antigravity"

function Info  ($msg) { Write-Host "[antigravity] $msg" -ForegroundColor Cyan }
function Ok    ($msg) { Write-Host "[OK] $msg" -ForegroundColor Green }
function Warn  ($msg) { Write-Host "[!] $msg"  -ForegroundColor Yellow }
function Fail  ($msg) { Write-Host "[X] $msg"  -ForegroundColor Red; exit 1 }

# ── Prerequisites ────────────────────────────────────────────────────
Info "Checking prerequisites..."

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git is not installed. Please install git first."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js is not installed. Please install Node.js >= 18."
}

$NodeVersion = (node -e "process.stdout.write(process.versions.node)") 2>$null
$NodeMajor   = [int]($NodeVersion -split '\.')[0]
if ($NodeMajor -lt 18) {
    Fail "Node.js >= 18 required (found v$NodeVersion). Please upgrade."
}
Ok "Node.js v$NodeVersion"

$AgyPath = Get-Command agy -ErrorAction SilentlyContinue
if (-not $AgyPath) { $AgyPath = Get-Command agy.exe -ErrorAction SilentlyContinue }
if ($AgyPath) {
    Ok "Antigravity CLI found: $($AgyPath.Source)"
} else {
    Warn "Antigravity CLI (agy) not found on PATH."
    Warn "The plugin will install, but won't work until agy is available."
    Warn "Install guide: https://github.com/google-gemini/antigravity"
}

# ── Install / Update ────────────────────────────────────────────────
if (Test-Path (Join-Path $InstallDir ".git")) {
    Info "Existing git installation detected - updating..."
    git -C $InstallDir fetch --quiet origin main
    if ($LASTEXITCODE -ne 0) { Fail "git fetch failed." }
    git -C $InstallDir reset --hard origin/main --quiet
    if ($LASTEXITCODE -ne 0) { Fail "git reset failed." }
    Ok "Updated to latest version."
} elseif (Test-Path $InstallDir) {
    Warn "Existing non-git installation detected at $InstallDir"
    Info "Removing old installation and re-cloning..."
    Remove-Item -Recurse -Force $InstallDir
    git clone --quiet --depth 1 $Repo $InstallDir
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed." }
    Ok "Re-installed successfully."
} else {
    Info "Cloning into $InstallDir..."
    $ParentDir = Split-Path $InstallDir -Parent
    if (-not (Test-Path $ParentDir)) { New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null }
    git clone --quiet --depth 1 $Repo $InstallDir
    if ($LASTEXITCODE -ne 0) { Fail "git clone failed." }
    Ok "Cloned successfully."
}

# ── Verify install ───────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $InstallDir ".claude-plugin\plugin.json"))) {
    Fail "Installation verification failed - plugin.json not found."
}

if (-not (Test-Path (Join-Path $InstallDir "mcp-server\index.js"))) {
    Fail "Installation verification failed - mcp-server/index.js not found."
}

Ok "Plugin files verified."

# ── Done ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==============================================================" -ForegroundColor Green
Write-Host "  Antigravity plugin installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    1. In Claude Code, run:  " -NoNewline; Write-Host "/reload-plugins" -ForegroundColor Yellow
Write-Host "    2. Try:  " -NoNewline; Write-Host "/agy Analiza este proyecto" -ForegroundColor Yellow
Write-Host "    3. Try:  " -NoNewline; Write-Host "/agy-review" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Installed at: $InstallDir" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Green
Write-Host ""
