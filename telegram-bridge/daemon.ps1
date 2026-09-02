# ──────────────────────────────────────────────────────────────────────
# Antigravity Telegram Bridge - Daemon para Windows (Task Scheduler)
#
# Registra el bridge como tarea programada que arranca al iniciar sesión y se
# reinicia sola si el proceso muere. Fase 5 del plan de integración.
#
#   .\daemon.ps1 install     Registra la tarea y la arranca
#   .\daemon.ps1 uninstall   Detiene y elimina la tarea
#   .\daemon.ps1 start       Arranca la tarea ya registrada
#   .\daemon.ps1 stop        Detiene la tarea sin eliminarla
#   .\daemon.ps1 status      Estado de la tarea, del proceso y del lockfile
#   .\daemon.ps1 logs        Últimas líneas del log
#
# Se ejecuta con el usuario actual y SOLO con la sesión iniciada: `agy` necesita
# las credenciales del usuario y Voicebox vive en %APPDATA%. Ejecutarlo como
# SYSTEM rompería ambas cosas, así que no se ofrece esa opción.
# ──────────────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'uninstall', 'start', 'stop', 'status', 'logs')]
    [string]$Command = 'status',

    [int]$Lines = 40
)

$ErrorActionPreference = 'Stop'

# Este fichero se guarda en UTF-8 CON BOM y hay que mantenerlo asi: sin el,
# powershell.exe (5.1) lo decodifica como ANSI, y una raya larga se convierte
# en tres caracteres uno de los cuales el parser trata como comilla. El script
# entero deja de parsear con errores que no apuntan a la linea culpable.
# La consola necesita el mismo tratamiento para que los acentos no salgan rotos.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$TaskName   = 'AntigravityTelegramBridge'
$BridgeDir  = $PSScriptRoot
$BotScript  = Join-Path $BridgeDir 'bot.js'
$LockFile   = Join-Path $BridgeDir 'bridge.lock'
$LogFile    = Join-Path $BridgeDir 'daemon.log'
$MaxLogBytes = 5MB

function Info ($msg) { Write-Host "[bridge] $msg" -ForegroundColor Cyan }
function Ok   ($msg) { Write-Host "[OK] $msg"     -ForegroundColor Green }
function Warn ($msg) { Write-Host "[!] $msg"      -ForegroundColor Yellow }
function Fail ($msg) { Write-Host "[X] $msg"      -ForegroundColor Red; exit 1 }

function Get-NodePath {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $node) { Fail 'Node.js no está en el PATH.' }
    return $node.Source
}

function Test-Prerequisites {
    $nodePath = Get-NodePath

    $version = & $nodePath -e "process.stdout.write(process.versions.node)"
    $parts = $version -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    # El bridge carga el .env con process.loadEnvFile, disponible desde 20.12.
    if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 12)) {
        Fail "Node >= 20.12 requerido (encontrado v$version)."
    }
    Ok "Node v$version"

    if (-not (Test-Path $BotScript)) { Fail "No se encuentra $BotScript" }

    $envLocal = Join-Path $BridgeDir '.env'
    $envRoot  = Join-Path (Split-Path $BridgeDir -Parent) '.env'
    $envFile  = if (Test-Path $envLocal) { $envLocal } elseif (Test-Path $envRoot) { $envRoot } else { $null }

    if (-not $envFile) {
        Fail "No hay .env. Copia .env.example a telegram-bridge\.env y configúralo."
    }
    $content = Get-Content $envFile -Raw
    foreach ($key in @('TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS')) {
        if ($content -notmatch "(?m)^\s*$key\s*=\s*\S") {
            Fail "Falta $key en $envFile. El bot no arrancaría."
        }
    }
    Ok "Configuración en $envFile"

    $modules = Join-Path $BridgeDir 'node_modules'
    if (-not (Test-Path $modules)) {
        Warn "Falta node_modules. Ejecutando npm install..."
        Push-Location $BridgeDir
        try { & npm install --omit=dev } finally { Pop-Location }
    }

    return $nodePath
}

function Get-BridgeTask {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-LockInfo {
    if (-not (Test-Path $LockFile)) { return $null }
    try {
        $raw = (Get-Content $LockFile -Raw).Trim()
        if ($raw.StartsWith('{')) { return $raw | ConvertFrom-Json }
        return [pscustomobject]@{ pid = [int]$raw; startedAt = $null }
    } catch { return $null }
}

function Invoke-Install {
    $nodePath = Test-Prerequisites

    if (Get-BridgeTask) {
        Warn "La tarea '$TaskName' ya existe. Se vuelve a registrar con la configuración actual."
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    # Task Scheduler no redirige la salida, así que se envuelve en cmd.exe para
    # conservar un log: sin él, un daemon que falla no deja rastro alguno.
    $argument = '/c ""{0}" "{1}" >> "{2}" 2>&1"' -f $nodePath, $BotScript, $LogFile

    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $argument -WorkingDirectory $BridgeDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -MultipleInstances IgnoreNew

    # Sin -RunLevel Highest: el bridge no necesita privilegios elevados y
    # dárselos ampliaría el alcance de una cuenta de Telegram comprometida.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

    Register-ScheduledTask -TaskName $TaskName `
        -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description 'Antigravity Telegram Bridge - long polling saliente, compatible con CGNAT.' | Out-Null

    Ok "Tarea '$TaskName' registrada (arranca al iniciar sesión)."
    Info "Log: $LogFile"

    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Invoke-Status
}

function Invoke-Uninstall {
    if (-not (Get-BridgeTask)) { Warn "La tarea '$TaskName' no está registrada."; return }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok "Tarea '$TaskName' eliminada."
    Info "El log y el .env se conservan."
}

function Invoke-Start {
    if (-not (Get-BridgeTask)) { Fail "La tarea no está registrada. Ejecuta: .\daemon.ps1 install" }
    # Rotación simple: el bot escribe cada tarea, y un log sin tope crece sin fin.
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
        Move-Item $LogFile "$LogFile.old" -Force
        Info "Log rotado a $LogFile.old"
    }
    Start-ScheduledTask -TaskName $TaskName
    Ok 'Tarea arrancada.'
}

function Invoke-Stop {
    if (-not (Get-BridgeTask)) { Fail "La tarea no está registrada." }
    Stop-ScheduledTask -TaskName $TaskName
    Ok 'Tarea detenida.'
}

function Invoke-Status {
    $task = Get-BridgeTask
    if (-not $task) {
        Warn "Tarea '$TaskName': no registrada."
    } else {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Info "Tarea '$TaskName': $($task.State)"
        Info "  Última ejecución: $($info.LastRunTime) (resultado: $($info.LastTaskResult))"
        Info "  Próxima:          $($info.NextRunTime)"
    }

    $lock = Get-LockInfo
    if (-not $lock) {
        Warn 'Lockfile: no hay ninguno (el bot no está corriendo).'
    } else {
        $proc = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
        if ($proc) {
            Ok "Bot vivo - PID $($lock.pid), desde $($lock.startedAt)"
        } else {
            Warn "Lockfile huérfano del PID $($lock.pid): el proceso ya no existe."
        }
    }

    if (Test-Path $LogFile) {
        $size = [math]::Round((Get-Item $LogFile).Length / 1KB, 1)
        Info "Log: $LogFile ($size KB)"
    }
}

function Invoke-Logs {
    if (-not (Test-Path $LogFile)) { Warn "Todavía no hay log en $LogFile"; return }
    Get-Content $LogFile -Tail $Lines
}

switch ($Command) {
    'install'   { Invoke-Install }
    'uninstall' { Invoke-Uninstall }
    'start'     { Invoke-Start }
    'stop'      { Invoke-Stop }
    'status'    { Invoke-Status }
    'logs'      { Invoke-Logs }
}
