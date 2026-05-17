#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUMBER="${CODEX_DESKTOP_DISPLAY_NUMBER:-99}"
DISPLAY_GEOMETRY="${CODEX_DESKTOP_DISPLAY_GEOMETRY:-1440x1000x24}"
VNC_PORT="${CODEX_DESKTOP_VNC_PORT:-5900}"
WEB_PORT="${CODEX_DESKTOP_WEB_PORT:-6080}"
APP_URL="http://127.0.0.1:$WEB_PORT/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=websockify"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codex-desktop-devcontainer"
PID_DIR="${XDG_RUNTIME_DIR:-/tmp}/codex-desktop-devcontainer"
PROFILE_DIR="${CODEX_DESKTOP_DEVCONTAINER_PROFILE_DIR:-$HOME/.local/share/codex-desktop-devcontainer/profile}"
BROWSER_PROFILE_DIR="${CODEX_BROWSER_USE_USER_DATA_DIR:-$PROFILE_DIR/browser-use-chromium}"
NPM_PREFIX="${CODEX_DESKTOP_DEVCONTAINER_NPM_PREFIX:-$PROFILE_DIR/npm}"
CODEX_CLI_PACKAGE="${CODEX_DESKTOP_DEVCONTAINER_CODEX_CLI_PACKAGE:-@openai/codex@alpha}"
PROFILE_CODEX_HOME="$PROFILE_DIR/codex-home"
PROFILE_XDG_CONFIG_HOME="$PROFILE_DIR/xdg-config"
PROFILE_XDG_CACHE_HOME="$PROFILE_DIR/xdg-cache"
PROFILE_XDG_STATE_HOME="$PROFILE_DIR/xdg-state"

mkdir -p "$LOG_DIR" "$PID_DIR"

info() {
  printf '[codex-devcontainer-host] %s\n' "$*" >&2
}

have() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  local command_name="$1"
  local package_name="${2:-$1}"
  if have "$command_name"; then
    return 0
  fi

  if have apk && have sudo; then
    info "Installing missing package with apk: $package_name"
    sudo apk add --no-cache "$package_name" >/dev/null
  fi

  have "$command_name" || {
    echo "Missing required command: $command_name" >&2
    exit 127
  }
}

ensure_apk_package() {
  local package_name="$1"

  if have apk && have sudo && ! apk info -e "$package_name" >/dev/null 2>&1; then
    info "Installing missing package with apk: $package_name"
    sudo apk add --no-cache "$package_name" >/dev/null
  fi
}

start_background() {
  local name="$1"
  shift
  local log_file="$LOG_DIR/$name.log"

  "$@" >"$log_file" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "$PID_DIR/$name.pid"
  info "Started $name pid=$pid log=$log_file"
}

stop_pid_file() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 0

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
}

stop_host() {
  stop_pid_file "$PID_DIR/codex-desktop.pid"
  stop_pid_file "$PID_DIR/novnc.pid"
  stop_pid_file "$PID_DIR/x11vnc.pid"
  stop_pid_file "$PID_DIR/xvfb.pid"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-80}"

  for _ in $(seq 1 "$attempts"); do
    if curl --disable --silent --fail --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  return 1
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local attempts="${3:-80}"

  for _ in $(seq 1 "$attempts"); do
    if timeout 1 bash -c "cat < /dev/null > /dev/tcp/$host/$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  return 1
}

wait_for_display() {
  local attempts=80

  for _ in $(seq 1 "$attempts"); do
    if xdpyinfo -display ":$DISPLAY_NUMBER" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  return 1
}

ensure_codex_cli() {
  if [ -n "${CODEX_CLI_PATH:-}" ] && [ -x "$CODEX_CLI_PATH" ]; then
    return 0
  fi

  if have codex; then
    CODEX_CLI_PATH="$(command -v codex)"
    export CODEX_CLI_PATH
    return 0
  fi

  if [ "${CODEX_DESKTOP_DEVCONTAINER_INSTALL_CLI:-1}" != "1" ]; then
    return 0
  fi

  if ! have npm && have apk && have sudo; then
    info "Installing missing package with apk: npm"
    sudo apk add --no-cache npm >/dev/null
  fi

  if have npm; then
    info "Installing Codex CLI into persisted devcontainer profile: $NPM_PREFIX ($CODEX_CLI_PACKAGE)"
    mkdir -p "$NPM_PREFIX"
    npm install -g --prefix "$NPM_PREFIX" "$CODEX_CLI_PACKAGE" >"$LOG_DIR/npm-codex-install.log" 2>&1 || {
      echo "Codex CLI install failed; see $LOG_DIR/npm-codex-install.log" >&2
      return 1
    }
    if [ -x "$NPM_PREFIX/bin/codex" ]; then
      CODEX_CLI_PATH="$NPM_PREFIX/bin/codex"
      PATH="$NPM_PREFIX/bin:$PATH"
      export CODEX_CLI_PATH PATH
    fi
  fi
}

novnc_root() {
  local candidate
  for candidate in \
    /usr/share/novnc \
    /usr/share/webapps/novnc \
    /usr/share/noVNC \
    /usr/lib/novnc
  do
    if [ -f "$candidate/vnc.html" ] || [ -f "$candidate/index.html" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

start_host() {
  stop_host

  require_command Xvfb Xvfb
  require_command xkbcomp xkbcomp
  ensure_apk_package xkeyboard-config
  require_command xdpyinfo xdpyinfo
  require_command x11vnc x11vnc
  require_command websockify websockify
  require_command curl curl
  require_command codex-desktop codex-desktop

  local novnc_dir
  novnc_dir="$(novnc_root || true)"
  if [ -z "$novnc_dir" ] && have apk && have sudo; then
    info "Installing missing package with apk: novnc"
    sudo apk add --no-cache novnc >/dev/null
    novnc_dir="$(novnc_root || true)"
  fi
  [ -n "$novnc_dir" ] || {
    echo "Could not locate noVNC web assets" >&2
    exit 127
  }

  export DISPLAY=":$DISPLAY_NUMBER"
  export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$PROFILE_XDG_CONFIG_HOME}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$PROFILE_XDG_CACHE_HOME}"
  export XDG_STATE_HOME="${XDG_STATE_HOME:-$PROFILE_XDG_STATE_HOME}"
  export CODEX_HOME="${CODEX_HOME:-$PROFILE_CODEX_HOME}"
  export CODEX_DESKTOP_LINUX_OZONE=x11
  export CODEX_SYNC_CLI_PREFLIGHT=0
  export CODEX_DESKTOP_DEVCONTAINER_MODE=1
  export CODEX_ELECTRON_USER_DATA_DIR="$PROFILE_DIR/electron-user-data"
  export CODEX_BROWSER_USE_PREFER_LOCAL_BROWSER=1
  export CODEX_BROWSER_USE_BROWSER_COMMAND="${CODEX_BROWSER_USE_BROWSER_COMMAND:-chromium}"
  export CODEX_BROWSER_USE_BROWSER_ARGS="${CODEX_BROWSER_USE_BROWSER_ARGS:---no-sandbox --disable-dev-shm-usage --disable-gpu}"
  export CODEX_BROWSER_USE_USER_DATA_DIR="$BROWSER_PROFILE_DIR"
  export CODEX_COMPUTER_USE_BROWSER_ONLY=1

  mkdir -p "$PROFILE_DIR" "$BROWSER_PROFILE_DIR" "$NPM_PREFIX" "$CODEX_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
  ensure_codex_cli

  if have sudo; then
    sudo mkdir -p /tmp/.X11-unix
    sudo chmod 1777 /tmp/.X11-unix
  fi

  start_background xvfb Xvfb "$DISPLAY" -screen 0 "$DISPLAY_GEOMETRY" -nolisten tcp -ac
  wait_for_display || {
    echo "Xvfb did not become ready on display $DISPLAY" >&2
    exit 70
  }

  start_background x11vnc x11vnc \
    -display "$DISPLAY" \
    -forever \
    -shared \
    -nopw \
    -localhost \
    -noipv6 \
    -rfbport "$VNC_PORT"
  wait_for_tcp 127.0.0.1 "$VNC_PORT" || {
    echo "x11vnc did not become ready on port $VNC_PORT" >&2
    exit 70
  }

  start_background novnc websockify \
    --web "$novnc_dir" \
    "127.0.0.1:$WEB_PORT" \
    "127.0.0.1:$VNC_PORT"
  wait_for_tcp 127.0.0.1 "$WEB_PORT" || {
    echo "noVNC web server did not become ready on port $WEB_PORT" >&2
    exit 70
  }

  wait_for_http "http://127.0.0.1:$WEB_PORT/vnc.html" || {
    echo "noVNC did not become ready on port $WEB_PORT" >&2
    exit 70
  }

  start_background codex-desktop codex-desktop --x11 --no-sandbox

  info "Codex Desktop devcontainer host is ready"
  printf '%s\n' "$APP_URL"
}

status_host() {
  echo "URL: $APP_URL"
  echo "Profile: $PROFILE_DIR"
  echo "CODEX_HOME: ${CODEX_HOME:-$PROFILE_CODEX_HOME}"
  echo "Listeners:"
  ss -ltnp 2>/dev/null | grep -E "127\\.0\\.0\\.1:($WEB_PORT|$VNC_PORT|5175)|\\[::1\\]:($WEB_PORT|$VNC_PORT|5175)" || true
  echo "Processes:"
  pgrep -fa 'Xvfb|x11vnc|websockify|codex-desktop|electron|codex app-server' || true
  for log in "$LOG_DIR/xvfb.log" "$LOG_DIR/x11vnc.log" "$LOG_DIR/novnc.log" "$LOG_DIR/codex-desktop.log" "${XDG_CACHE_HOME:-$PROFILE_XDG_CACHE_HOME}/codex-desktop/launcher.log"; do
    [ -f "$log" ] || continue
    echo "--- $log"
    tail -n 200 "$log" || true
  done
}

case "${1:-start}" in
  start)
    start_host
    ;;
  stop)
    stop_host
    ;;
  status)
    status_host
    ;;
  url)
    printf '%s\n' "$APP_URL"
    ;;
  *)
    echo "Usage: $0 [start|stop|status|url]" >&2
    exit 64
    ;;
esac
