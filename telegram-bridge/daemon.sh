#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Antigravity Telegram Bridge - Daemon para Linux (systemd --user)
#
#   ./daemon.sh install     Registra la unidad y la arranca
#   ./daemon.sh uninstall   Detiene y elimina la unidad
#   ./daemon.sh start       Arranca la unidad ya registrada
#   ./daemon.sh stop        Detiene la unidad sin eliminarla
#   ./daemon.sh status      Estado de la unidad, del proceso y del lockfile
#   ./daemon.sh logs        Ultimas lineas del journal
#
#   ./daemon.sh install --force   Salta la comprobacion de directorio estable
#
# Equivalente de daemon.ps1, con las mismas garantias y las mismas negativas.
#
# Por que `systemd --user` y no una unidad de sistema: el bridge necesita el
# HOME del usuario, sus credenciales de `agy` y el mismo directorio de datos que
# usan las herramientas MCP. Una unidad de sistema correria como root o como un
# usuario de servicio y no encontraria nada de eso.
#
# Los logs van al journal, no a un fichero. Por eso esta unidad NO redirige a
# daemon.log y la rotacion en proceso (logrotate.js) queda inerte aqui: journald
# ya rota por su cuenta, y duplicar el log solo daria dos copias que divergen.
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_SCRIPT="$BRIDGE_DIR/bot.js"
UNIT_NAME="lagrange-telegram-bridge.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"

DATA_DIR="${TELEGRAM_BRIDGE_DATA_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/antigravity-telegram-bridge}"
LOCK_FILE="$DATA_DIR/bridge.lock"

COMMAND="${1:-status}"
FORCE=0
for arg in "${@:2}"; do
  [ "$arg" = "--force" ] && FORCE=1
done

if [ -t 1 ]; then
  C_INFO=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[90m'; C_OFF=$'\033[0m'
else
  C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_OFF=''
fi

info() { printf '%s[bridge]%s %s\n' "$C_INFO" "$C_OFF" "$1"; }
ok()   { printf '%s[OK]%s %s\n'     "$C_OK"   "$C_OFF" "$1"; }
warn() { printf '%s[!]%s %s\n'      "$C_WARN" "$C_OFF" "$1"; }
fail() { printf '%s[ERROR]%s %s\n'  "$C_ERR"  "$C_OFF" "$1" >&2; exit 1; }

# ──────────────────────────────────────────────────────────────────────
# Comprobaciones
# ──────────────────────────────────────────────────────────────────────

require_systemd() {
  command -v systemctl >/dev/null 2>&1 \
    || fail "systemctl no esta disponible. Este daemon usa systemd --user; sin el, arranca el bridge a mano con 'npm run bridge'."
  systemctl --user show-environment >/dev/null 2>&1 \
    || fail "No hay un bus de systemd de usuario en esta sesion. Suele pasar por SSH sin sesion de login: prueba 'loginctl enable-linger $USER' y vuelve a entrar."
}

# Un daemon NO puede registrarse desde el directorio de una version instalada
# del plugin.
#
# `claude plugin update` instala cada version en su propia carpeta
# (plugins/cache/<market>/<plugin>/<version>/) y NO borra las anteriores. La
# unidad guarda una ruta absoluta en ExecStart, asi que un daemon registrado ahi
# queda anclado a esa version para siempre: tras actualizar, el bot sigue
# ejecutando el codigo viejo mientras las herramientas MCP corren el nuevo.
#
# Y como el directorio antiguo sigue existiendo, nada falla. No hay error, no
# hay aviso: solo dos mitades del mismo puente ejecutando codigo distinto. Si
# las versiones se borrasen, la unidad reventaria al arrancar y el usuario se
# enteraria; que sobrevivan es justo lo que hace este fallo silencioso.
assert_directorio_estable() {
  case "$BRIDGE_DIR" in
    */.claude/plugins/cache/*|*/.claude/plugins/marketplaces/*|*/claude/plugins/cache/*|*/claude/plugins/marketplaces/*)
      ;;
    *) return 0 ;;
  esac

  echo
  warn 'Este daemon NO puede instalarse desde una copia gestionada del plugin.'
  echo
  printf '%s  Directorio actual: %s%s\n' "$C_DIM" "$BRIDGE_DIR" "$C_OFF"
  echo
  echo '  Cada version del plugin se instala en su propia carpeta y las antiguas'
  echo '  no se borran. La unidad de systemd guardaria una ruta anclada a ESTA'
  echo '  version: tras el proximo `claude plugin update`, el bot seguiria'
  echo '  ejecutando este codigo mientras las herramientas MCP corren el nuevo,'
  echo '  sin ningun error que lo delate.'
  echo
  printf '%s  Instalalo desde un clon del repositorio:%s\n' "$C_INFO" "$C_OFF"
  echo
  echo '    git clone https://github.com/KZvilla/claude-plugin-antigravity.git'
  echo '    cd claude-plugin-antigravity'
  echo '    npm install --prefix telegram-bridge'
  echo '    npm run bridge:daemon:install'
  echo
  echo '  Las credenciales y el estado ya son compartidos, asi que el clon usara'
  echo '  el mismo .env y el mismo state.json que el plugin instalado.'
  echo
  printf '%s  Si aun asi quieres continuar: ./daemon.sh install --force%s\n' "$C_DIM" "$C_OFF"
  echo
  exit 1
}

test_prerequisites() {
  local node_path
  node_path="$(command -v node || true)"
  [ -n "$node_path" ] || fail "node no esta en el PATH. Instala Node >= 20.12."

  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  local minor
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$major" -lt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -lt 12 ]; }; then
    fail "Node $(node -v) es demasiado antiguo: el bridge carga el .env con process.loadEnvFile, disponible desde 20.12."
  fi
  ok "Node $(node -v)"

  [ -f "$BOT_SCRIPT" ] || fail "No se encuentra $BOT_SCRIPT"

  # El .env no se exige: puede estar en el directorio de datos duradero, que es
  # justo lo que recomienda BE-008. Solo se informa de cual se usaria.
  #
  # La lista de candidatos NO se reescribe aqui: se le pregunta a paths.js, que
  # es la que el bot consulta de verdad. Una copia a mano en este script podria
  # divergir de la del codigo, y entonces el daemon informaria de un fichero
  # mientras el bot carga otro — precisamente el tipo de desfase silencioso que
  # este bridge lleva toda una revision eliminando.
  #
  # Se imprimen TODOS los que existen, no solo el ganador: dos .env a la vez es
  # una situacion real (un clon con uno propio mas el duradero) y saber cual
  # pierde importa tanto como saber cual gana.
  local env_reporte
  env_reporte="$(cd "$BRIDGE_DIR" && node --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const dir = process.cwd();
    const paths = await import(pathToFileURL(path.join(dir, "paths.js")).href);
    const existen = paths.bridgeEnvCandidates(dir).filter((f) => fs.existsSync(f));
    if (existen.length === 0) { console.log("NINGUNO"); }
    else {
      console.log("USA\t" + existen[0]);
      for (const f of existen.slice(1)) console.log("IGNORA\t" + f);
    }
  ' 2>/dev/null || true)"

  if [ -z "$env_reporte" ] || [ "$env_reporte" = "NINGUNO" ]; then
    warn "No se encontro ningun .env. El bot arrancara y fallara al conectar."
    warn "Colocalo en $DATA_DIR/.env (sobrevive a claude plugin update)."
  else
    while IFS=$'\t' read -r tipo ruta; do
      [ -z "$ruta" ] && continue
      if [ "$tipo" = "USA" ]; then
        info "Credenciales: $ruta"
      else
        warn "Hay otro .env que NO se usa (menor precedencia): $ruta"
      fi
    done <<< "$env_reporte"
  fi

  # `agy` se busca aqui para poder meter SU directorio en el PATH de la unidad.
  # Un servicio de usuario no hereda el PATH del shell, asi que un agy instalado
  # en ~/.local/bin o similar seria invisible para el bot aunque funcione
  # perfectamente en la terminal.
  local agy_path
  agy_path="$(command -v agy || true)"
  if [ -n "$agy_path" ]; then
    ok "agy en $agy_path"
  else
    warn "agy no esta en el PATH de este shell. El bot arrancara, pero las tareas fallaran."
    warn "Instalalo desde https://antigravity.google/cli y vuelve a ejecutar install."
  fi

  # El resultado sale por VARIABLES, no por stdout.
  #
  # Devolverlo con printf y capturarlo con $(test_prerequisites) parece
  # natural, pero esta funcion tambien le habla al usuario con ok/info/warn, y
  # eso va al mismo stdout. La captura se llevaba las dos cosas: ExecStart acabo
  # conteniendo "[OK] Node v22..." y systemd rechazo la unidad entera con
  # "Executable name contains special characters". Una funcion no puede a la vez
  # informar al usuario y devolver un valor por el mismo canal.
  PREREQ_NODE_PATH="$node_path"
  PREREQ_AGY_PATH="$agy_path"
}

# ──────────────────────────────────────────────────────────────────────
# Lockfile
# ──────────────────────────────────────────────────────────────────────

lock_pid() {
  [ -f "$LOCK_FILE" ] || return 1
  node -e '
    const fs = require("fs");
    try {
      const raw = fs.readFileSync(process.argv[1], "utf8").trim();
      const pid = raw.startsWith("{") ? JSON.parse(raw).pid : parseInt(raw, 10);
      if (Number.isInteger(pid)) process.stdout.write(String(pid));
    } catch {}
  ' "$LOCK_FILE" 2>/dev/null
}

lock_started_at() {
  [ -f "$LOCK_FILE" ] || return 1
  node -e '
    const fs = require("fs");
    try {
      const raw = fs.readFileSync(process.argv[1], "utf8").trim();
      if (raw.startsWith("{")) process.stdout.write(JSON.parse(raw).startedAt || "");
    } catch {}
  ' "$LOCK_FILE" 2>/dev/null
}

# ──────────────────────────────────────────────────────────────────────
# Comandos
# ──────────────────────────────────────────────────────────────────────

write_unit() {
  local node_path="$1"
  local agy_path="${2:-}"
  local node_dir
  node_dir="$(dirname "$node_path")"
  local agy_dir=''
  [ -n "$agy_path" ] && agy_dir="$(dirname "$agy_path"):"

  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_FILE" <<UNIT
# Generado por daemon.sh - no editar a mano; install lo reescribe.
[Unit]
Description=Antigravity Telegram Bridge (long polling saliente, compatible con CGNAT)
# StartLimit* va en [Unit], no en [Service]: sistemd los movio aqui en la v229
# y en [Service] se ignoran con un aviso de clave desconocida.
#
# Tres reinicios por minuto y para. Sin tope, un fallo permanente -un token
# invalido, por ejemplo- reintentaria en bucle para siempre.
StartLimitBurst=3
StartLimitIntervalSec=60

# NO se ordena contra network-online.target: es un target del gestor de SISTEMA
# y un servicio de usuario no puede depender de el de forma fiable (un Wants=
# hacia una unidad que su gestor no conoce solo produce ruido). No hace falta:
# el bot hace long polling con reintentos y grammY reconecta solo.

[Service]
Type=simple
# Ojo con las comillas: NO se aplican igual en todos los ajustes.
#
#   WorkingDirectory= toma el valor literal, sin interpretar comillas. Si se
#   entrecomilla, la comilla pasa a formar parte de la ruta y systemd rechaza
#   la unidad con "path is not absolute". Va en crudo, y un espacio en la ruta
#   no molesta porque el valor es el resto de la linea.
#
#   ExecStart= si es una linea de comandos y se divide por espacios, asi que
#   ahi las comillas son obligatorias: sin ellas, un clon en "~/mis proyectos/"
#   partiria la ruta en dos argumentos.
WorkingDirectory=$BRIDGE_DIR
ExecStart="$node_path" "$BOT_SCRIPT"
Restart=on-failure
RestartSec=10

# El entorno de un servicio de usuario es minimo: NO hereda el PATH del shell.
# Sin esto, resolveAgyBin() hace 'which agy', no lo encuentra, y las tareas
# fallan con "agy no esta en el PATH" aunque en la terminal funcione. Es el
# fallo mas probable de este arranque, y el mas confuso.
Environment="PATH=$node_dir:$agy_dir%h/.local/bin:%h/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# La salida va al journal: 'daemon.sh logs' la lee con journalctl. No se
# redirige a un fichero a proposito; ver la cabecera de este script.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lagrange-bridge

[Install]
WantedBy=default.target
UNIT
}

invoke_install() {
  [ "$FORCE" -eq 1 ] || assert_directorio_estable
  require_systemd

  PREREQ_NODE_PATH=''
  PREREQ_AGY_PATH=''
  test_prerequisites
  local node_path="$PREREQ_NODE_PATH"
  local agy_path="$PREREQ_AGY_PATH"

  # Cinturon y tirantes: si algo volviera a colar diagnosticos en estas
  # variables, es mejor negarse a escribir la unidad que producir un ExecStart
  # corrupto que systemd rechaza con un error que no apunta a la causa.
  case "$node_path" in
    /*) ;;
    *) fail "Ruta de node inesperada: '$node_path'. No se escribe la unidad." ;;
  esac

  if systemctl --user list-unit-files "$UNIT_NAME" --no-legend 2>/dev/null | grep -q .; then
    warn "La unidad '$UNIT_NAME' ya existe. Se vuelve a escribir con la configuracion actual."
    systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
  fi

  write_unit "$node_path" "$agy_path"
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"

  ok "Unidad '$UNIT_NAME' registrada y arrancada."
  info "Unidad: $UNIT_FILE"
  info "Logs:   journalctl --user -u $UNIT_NAME -f"

  # El equivalente de la semantica "al iniciar sesion" de Task Scheduler. Sin
  # linger, el servicio muere al cerrar la ultima sesion del usuario y no
  # arranca en el boot. Es la piedra con la que tropieza todo el mundo, asi que
  # se comprueba en vez de asumirlo.
  if command -v loginctl >/dev/null 2>&1; then
    local linger
    linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo 'no')"
    if [ "$linger" != "yes" ]; then
      echo
      warn 'El servicio se detendra al cerrar sesion y no arrancara en el boot.'
      printf '%s  Para que sobreviva:%s  sudo loginctl enable-linger %s\n' "$C_INFO" "$C_OFF" "$USER"
      echo
    else
      ok "Linger activo: el servicio sobrevive al cierre de sesion."
    fi
  fi

  sleep 2
  invoke_status
}

invoke_uninstall() {
  require_systemd
  if ! systemctl --user list-unit-files "$UNIT_NAME" --no-legend 2>/dev/null | grep -q .; then
    warn "La unidad '$UNIT_NAME' no esta registrada."
    return 0
  fi
  systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  ok "Unidad '$UNIT_NAME' eliminada."
  info "El .env y el estado se conservan."
}

invoke_start() {
  require_systemd
  systemctl --user list-unit-files "$UNIT_NAME" --no-legend 2>/dev/null | grep -q . \
    || fail "La unidad no esta registrada. Ejecuta: ./daemon.sh install"
  systemctl --user start "$UNIT_NAME"
  ok 'Unidad arrancada.'
}

invoke_stop() {
  require_systemd
  systemctl --user list-unit-files "$UNIT_NAME" --no-legend 2>/dev/null | grep -q . \
    || fail "La unidad no esta registrada."
  systemctl --user stop "$UNIT_NAME"
  ok 'Unidad detenida.'
}

invoke_status() {
  require_systemd

  if systemctl --user list-unit-files "$UNIT_NAME" --no-legend 2>/dev/null | grep -q .; then
    local estado
    estado="$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)"
    local habilitada
    habilitada="$(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null || echo 'disabled')"
    info "Unidad '$UNIT_NAME': $estado ($habilitada)"
  else
    warn "La unidad '$UNIT_NAME' no esta registrada."
    info 'Registrala con: ./daemon.sh install'
    return 0
  fi

  local pid
  pid="$(lock_pid || true)"
  if [ -z "$pid" ]; then
    warn "No hay lockfile en $LOCK_FILE"
  elif kill -0 "$pid" 2>/dev/null; then
    ok "Bot vivo - PID $pid, desde $(lock_started_at || echo desconocido)"
  else
    warn "Lockfile huerfano del PID $pid: el proceso ya no existe."
  fi

  info "Datos: $DATA_DIR"

  if command -v loginctl >/dev/null 2>&1; then
    local linger
    linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo 'no')"
    [ "$linger" = "yes" ] \
      && ok 'Linger activo: sobrevive al cierre de sesion.' \
      || warn "Linger inactivo: se detiene al cerrar sesion (sudo loginctl enable-linger $USER)."
  fi
}

invoke_logs() {
  require_systemd
  local lines="${LINES_ARG:-40}"
  journalctl --user -u "$UNIT_NAME" -n "$lines" --no-pager
}

case "$COMMAND" in
  install)   invoke_install ;;
  uninstall) invoke_uninstall ;;
  start)     invoke_start ;;
  stop)      invoke_stop ;;
  status)    invoke_status ;;
  logs)      invoke_logs ;;
  *) fail "Comando desconocido: $COMMAND (install|uninstall|start|stop|status|logs)" ;;
esac
