#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${CODEX_DESKTOP_DEVCONTAINER_IMAGE:-ghcr.io/joshyorko/ror:latest}"
CONTAINER_ENGINE="${CONTAINER_ENGINE:-}"
CASK_PATH="contrib/homebrew/codex-desktop-devcontainer.rb"

if [ -z "$CONTAINER_ENGINE" ]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
  else
    echo "docker or podman is required on the host to run the devcontainer Homebrew smoke test" >&2
    exit 127
  fi
fi

exec "$CONTAINER_ENGINE" run --rm \
  -v "$REPO_DIR:/workspace/codex-desktop-linux:ro,z" \
  -w /workspace/codex-desktop-linux \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    trap '\''echo "devcontainer Homebrew smoke failed at line $LINENO: $BASH_COMMAND" >&2'\'' ERR

    export HOMEBREW_NO_AUTO_UPDATE=1
    export HOMEBREW_NO_ANALYTICS=1
    export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"

    command -v brew
    test -f "'"$CASK_PATH"'"
    local_tap="$(mktemp -d)"
    mkdir -p "$local_tap/Casks"
    cp "'"$CASK_PATH"'" "$local_tap/Casks/codex-desktop-devcontainer.rb"
    git -C "$local_tap" init -q
    git -C "$local_tap" config user.email codex-devcontainer@example.invalid
    git -C "$local_tap" config user.name "Codex Devcontainer Smoke"
    git -C "$local_tap" add Casks/codex-desktop-devcontainer.rb
    git -C "$local_tap" commit -qm "Add local Codex Desktop cask"

    brew tap codex-devcontainer/local "$local_tap"
    brew install --cask codex-devcontainer/local/codex-desktop-devcontainer
    command -v codex-desktop

    codex_desktop_help="$(codex-desktop --help)"
    printf "%s\n" "$codex_desktop_help"
    grep -q "serve" <<<"$codex_desktop_help"
    codex-desktop web --inspect > /tmp/codex-desktop-web.json
    grep -q "\"package\": \"codex-desktop-linux\"" /tmp/codex-desktop-web.json
    grep -q "\"auth\"" /tmp/codex-desktop-web.json
    grep -q "\"required\": true" /tmp/codex-desktop-web.json
    grep -q "\"token_present\": true" /tmp/codex-desktop-web.json
    grep -q "\"blocked_host_env\"" /tmp/codex-desktop-web.json
    grep -q "\"mode\": \"desktop\"" /tmp/codex-desktop-web.json
    grep -q "\"physical_host_control\": true" /tmp/codex-desktop-web.json

    CODEX_DESKTOP_RUN_COMPUTER_USE_DOCTOR=0 codex-desktop doctor > /tmp/codex-desktop-doctor.log || doctor_status=$?
    grep -q "Codex Desktop Linux doctor" /tmp/codex-desktop-doctor.log
    grep -q "Computer Use:" /tmp/codex-desktop-doctor.log

    if codex-desktop serve \
      --workspace /workspace \
      --profile /tmp/codex-desktop-profile \
      --bind 0.0.0.0 \
      --port 0 \
      --once-health-check >/tmp/codex-desktop-non-loopback.log 2>&1; then
      echo "expected non-loopback devcontainer web mode to require an explicit token gate" >&2
      exit 1
    fi
    grep -q "non-loopback bind requires --require-token" /tmp/codex-desktop-non-loopback.log

    CODEX_BROWSER_USE_BROWSER_COMMAND=/nonexistent/chromium \
      CODEX_HOME=/tmp/codex-shared-home \
      codex-desktop serve \
      --workspace /workspace \
      --profile /tmp/codex-desktop-profile \
      --bind 127.0.0.1 \
      --port 0 \
      --once-health-check >/tmp/codex-desktop-serve-health.log 2>&1
    grep -q "serving http://127.0.0.1:" /tmp/codex-desktop-serve-health.log
    grep -q "\"mode\": \"devcontainer-web\"" /tmp/codex-desktop-serve-health.log
    grep -q "\"loopback_only_default\": true" /tmp/codex-desktop-serve-health.log
    grep -q "\"codex_home\": \"/tmp/codex-shared-home\"" /tmp/codex-desktop-serve-health.log
    ! grep -q "\"codex_home\": \"/tmp/codex-desktop-profile" /tmp/codex-desktop-serve-health.log
    grep -q "\"auth\"" /tmp/codex-desktop-serve-health.log
    grep -q "\"required\": true" /tmp/codex-desktop-serve-health.log
    grep -q "\"token_present\": true" /tmp/codex-desktop-serve-health.log
    grep -q "\"mode\": \"desktop\"" /tmp/codex-desktop-serve-health.log
    grep -q "\"physical_host_control\": true" /tmp/codex-desktop-serve-health.log

    CODEX_COMPUTER_CONTROL_MODE=browser-only \
      CODEX_BROWSER_USE_BROWSER_COMMAND=/nonexistent/chromium \
      CODEX_HOME=/tmp/codex-shared-home \
      codex-desktop serve \
      --workspace /workspace \
      --profile /tmp/codex-desktop-profile \
      --bind 127.0.0.1 \
      --port 0 \
      --once-health-check >/tmp/codex-desktop-browser-only-health.log 2>&1
    grep -q "\"mode\": \"browser-only\"" /tmp/codex-desktop-browser-only-health.log
    grep -q "\"physical_host_control\": false" /tmp/codex-desktop-browser-only-health.log
    grep -q "\"DISPLAY\"" /tmp/codex-desktop-browser-only-health.log
    grep -q "\"WAYLAND_DISPLAY\"" /tmp/codex-desktop-browser-only-health.log
    grep -q "\"DBUS_SESSION_BUS_ADDRESS\"" /tmp/codex-desktop-browser-only-health.log
    grep -q "\"YDOTOOL_SOCKET\"" /tmp/codex-desktop-browser-only-health.log
  '
