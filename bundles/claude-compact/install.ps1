# Claude Compact Skill — Installer for Windows
# Copies claude-compact skill to global Antigravity skills directory (~/.gemini/config/skills/claude-compact)

$ErrorActionPreference = "Stop"

Write-Host "`n🚀 Installing claude-compact skill for Antigravity..." -ForegroundColor Cyan

# 1. Verify Node.js is installed
try {
    $nodeVer = & node -v 2>$null
    Write-Host "✔ Node.js detected: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "⚠ Warning: Node.js was not found in PATH. Please install Node.js (v18+) for the session parser helper." -ForegroundColor Yellow
}

# 2. Target Directory
$TargetDir = Join-Path $env:USERPROFILE ".gemini\config\skills\claude-compact"
$ScriptsDir = Join-Path $TargetDir "scripts"

if (-not (Test-Path $ScriptsDir)) {
    New-Item -ItemType Directory -Path $ScriptsDir -Force | Out-Null
}

$CurrentDir = $PSScriptRoot

# 3. Copy SKILL.md
Copy-Item -Path (Join-Path $CurrentDir "SKILL.md") -Destination (Join-Path $TargetDir "SKILL.md") -Force
Write-Host "✔ Installed SKILL.md -> $TargetDir\SKILL.md" -ForegroundColor Green

# 4. Copy scripts/parse_claude_session.js
Copy-Item -Path (Join-Path $CurrentDir "scripts\parse_claude_session.js") -Destination (Join-Path $ScriptsDir "parse_claude_session.js") -Force
Write-Host "✔ Installed helper script -> $ScriptsDir\parse_claude_session.js" -ForegroundColor Green

# 5. Verify installation
$testCmd = & node "$ScriptsDir\parse_claude_session.js" --help 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "`n🎉 Installation successful! claude-compact is now available globally in Antigravity." -ForegroundColor Cyan
    Write-Host "   You can now invoke it in Antigravity by asking:" -ForegroundColor Gray
    Write-Host "   - `"Resume la sesión de Claude Code para hacer un handoff`"" -ForegroundColor White
    Write-Host "   - `"Haz un compact de la sesión actual de Claude`"" -ForegroundColor White
    Write-Host "   - `"Lista las sesiones de Claude abiertas`"" -ForegroundColor White
} else {
    Write-Host "`n✔ Files copied to $TargetDir." -ForegroundColor Green
}
Write-Host ""
