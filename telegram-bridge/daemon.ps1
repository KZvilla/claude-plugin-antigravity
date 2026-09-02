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
#   .\daemon.ps1 install -Visible   Igual, pero dejando la consola a la vista
#
# Por defecto la tarea arranca el bot a traves de daemon-hidden.vbs, un
# lanzador de wscript.exe que no tiene ventana. Ver Write-HiddenShim.
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

    [int]$Lines = 40,

    # Registra la tarea con sesion interactiva, que muestra la ventana de
    # consola del bot. Util para depurar el arranque; por defecto va oculta.
    [switch]$Visible
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
<#
    El lock vive en el directorio de datos del usuario, no junto al codigo: su
    cometido es "un solo getUpdates por token en esta maquina", y el bridge
    puede existir en dos carpetas a la vez (el checkout de desarrollo y el
    plugin instalado). Debe coincidir con resolveBridgeDataDir() de paths.js.

    Se conserva la ruta antigua como reserva para poder informar del estado de
    un bot de la version anterior que siga vivo.
#>
$DataDir      = if ($env:TELEGRAM_BRIDGE_DATA_DIR) {
    $env:TELEGRAM_BRIDGE_DATA_DIR
} else {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
    Join-Path $base 'antigravity-telegram-bridge'
}
$LockFile     = Join-Path $DataDir 'bridge.lock'
$LegacyLock   = Join-Path $BridgeDir 'bridge.lock'
if (-not (Test-Path $LockFile) -and (Test-Path $LegacyLock)) { $LockFile = $LegacyLock }
$LogFile    = Join-Path $BridgeDir 'daemon.log'
$ShimFile   = Join-Path $BridgeDir 'daemon-hidden.vbs'
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

<#
    Espera a que muera el proceso del bot anotado en el lockfile y limpia el
    lockfile huerfano. Stop-ScheduledTask es asincrono y en Windows mata el
    arbol a lo bruto, asi que el handler de salida de Node no llega a borrar su
    lock: sin esto, la instancia nueva ve un lock vivo, se niega a arrancar y la
    tarea queda en Ready con resultado 1.
#>
function Wait-BotStopped ([int]$TimeoutSeconds = 15) {
    $lock = Get-LockInfo
    if (-not $lock) { return }

    $limite = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $limite) {
        if (-not (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }

    if (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue) {
        Warn "El proceso $($lock.pid) sigue vivo tras $TimeoutSeconds s. Se fuerza el cierre."
        try { Stop-Process -Id $lock.pid -Force -ErrorAction Stop } catch {}
        Start-Sleep -Milliseconds 500
    }

    if ((Test-Path $LockFile) -and -not (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue)) {
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
        Info "Lockfile huerfano del PID $($lock.pid) retirado."
    }
}

<#
    Lanzador oculto. Task Scheduler no sabe esconder la consola de su accion, y
    el principal S4U -que si la esconde- exige privilegios de administrador
    para registrarse ("Acceso denegado" sin elevacion). wscript.exe no tiene
    ventana propia y con bWaitOnReturn = True sigue vivo mientras dure el bot,
    de modo que la tarea lo sigue tratando como su proceso y RestartCount
    conserva el sentido.
#>
function Write-HiddenShim ([string]$NodePath) {
    $comando  = 'cmd.exe /c ""{0}" "{1}" >> "{2}" 2>&1"' -f $NodePath, $BotScript, $LogFile
    $escapado = $comando.Replace('"', '""')

    # Here-string, no una lista de concatenaciones: dentro de @( ... ) la coma
    # tiene mas precedencia que el +, asi que 'a' + $x + 'b' no concatena
    # cadenas, concatena arrays, y cada trozo acababa en su propia linea del
    # .vbs. El resultado era un literal sin cerrar y wscript.exe abria un dialogo
    # de error que se queda esperando para siempre.
    $vbs = @"
' Generado por daemon.ps1 - no editar a mano; install lo reescribe.
' Arranca el bridge sin ventana de consola. Ver Write-HiddenShim.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$BridgeDir"
code = sh.Run("$escapado", 0, True)
WScript.Quit(code)
"@

    # ASCII deliberado: el motor de VBScript no lleva bien un BOM UTF-8.
    [System.IO.File]::WriteAllText($ShimFile, $vbs, [System.Text.Encoding]::ASCII)
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
        # Detener antes de borrar: si el bot sigue vivo, el nuevo arranque choca
        # contra su propio bridge.lock y la tarea entra en bucle de reintentos.
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch {}
        Wait-BotStopped
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    # Task Scheduler no redirige la salida, así que se envuelve en cmd.exe para
    # conservar un log: sin él, un daemon que falla no deja rastro alguno. Ese
    # cmd.exe es justo la ventana vacia que se ve en el escritorio, asi que por
    # defecto va dentro de un lanzador de wscript.exe, que no tiene ventana.
    $oculto = -not $Visible
    if ($oculto -and -not (Get-Command wscript.exe -ErrorAction SilentlyContinue)) {
        Warn 'wscript.exe no esta disponible; se registra con ventana visible.'
        $oculto = $false
    }

    if ($oculto) {
        Write-HiddenShim -NodePath $nodePath
        $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
            -Argument ('"{0}"' -f $ShimFile) -WorkingDirectory $BridgeDir
    } else {
        $argument = '/c ""{0}" "{1}" >> "{2}" 2>&1"' -f $nodePath, $BotScript, $LogFile
        $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $argument -WorkingDirectory $BridgeDir
    }
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
    # Interactive, no S4U: S4U esconderia la consola por si solo, pero
    # registrarlo exige privilegios de administrador ("Acceso denegado" sin
    # elevacion), y este script no debe pedir elevacion para nada. La ventana se
    # resuelve en la accion, con el lanzador de wscript.exe.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

    Register-ScheduledTask -TaskName $TaskName `
        -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description 'Antigravity Telegram Bridge - long polling saliente, compatible con CGNAT.' | Out-Null

    if ($oculto) {
        Ok "Tarea '$TaskName' registrada (arranca al iniciar sesión, sin ventana)."
    } else {
        Ok "Tarea '$TaskName' registrada (arranca al iniciar sesión, con ventana visible)."
    }
    Info "Log: $LogFile"

    # Invoke-Install arrancaba la tarea saltandose la rotacion que si hace
    # Invoke-Start, de modo que reinstalar sobre un log enorme lo dejaba crecer.
    Invoke-RotateLog
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    Invoke-Status
}

function Invoke-Uninstall {
    if (-not (Get-BridgeTask)) { Warn "La tarea '$TaskName' no está registrada."; return }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Wait-BotStopped
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    if (Test-Path $ShimFile) { Remove-Item $ShimFile -Force -ErrorAction SilentlyContinue }
    Ok "Tarea '$TaskName' eliminada."
    Info "El log y el .env se conservan."
}

<#
    Rotación por renombrado. Solo es segura ANTES de arrancar el bot: mientras
    corre, quien tiene abierto el log es el cmd.exe de la redireccion, y el
    rename falla (o peor, el handle sigue al fichero renombrado y daemon.log
    deja de recibir nada). Durante la ejecucion la rotacion la hace el propio
    bot copiando y truncando; ver telegram-bridge/logrotate.js.

    Esto cubre los arranques por daemon.ps1. El trigger AtLogOn no pasa por
    aqui: ese caso lo cubre la rotacion en proceso.
#>
function Invoke-RotateLog {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
        Move-Item $LogFile "$LogFile.old" -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $LogFile)) { Info "Log rotado a $LogFile.old" }
        else { Warn 'No se pudo rotar el log (en uso). Lo hara el bot al arrancar.' }
    }
}

function Invoke-Start {
    if (-not (Get-BridgeTask)) { Fail "La tarea no está registrada. Ejecuta: .\daemon.ps1 install" }
    Invoke-RotateLog
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
