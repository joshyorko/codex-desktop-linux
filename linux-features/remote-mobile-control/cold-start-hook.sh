#!/usr/bin/env bash
set -euo pipefail

truthy_env_value() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

install_remote_mobile_control_runtime() {
    local codex_home="$1"
    local private_bin="$codex_home/packages/standalone/.bin"
    local system_path="/usr/bin:/bin:/usr/sbin:/sbin"
    local installer_path="$private_bin:$system_path"
    local setsid_path=""
    local fetch_cmd=""
    local installer_args=()

    mkdir -p "$private_bin"
    if [ -n "${CODEX_REMOTE_CONTROL_CODEX_RELEASE:-}" ]; then
        installer_args+=(--release "$CODEX_REMOTE_CONTROL_CODEX_RELEASE")
    fi

    if ! setsid_path="$(PATH="$system_path" command -v setsid 2>/dev/null)"; then
        echo "Remote mobile control runtime install requires setsid"
        return 1
    fi
    if fetch_cmd="$(PATH="$installer_path" command -v curl 2>/dev/null)"; then
        :
    elif fetch_cmd="$(PATH="$installer_path" command -v wget 2>/dev/null)"; then
        :
    else
        echo "Remote mobile control runtime install requires curl or wget on the system PATH"
        return 1
    fi
    if ! PATH="$installer_path" command -v tar >/dev/null 2>&1; then
        echo "Remote mobile control runtime install requires tar on the system PATH"
        return 1
    fi

    echo "Installing remote mobile control standalone runtime into $codex_home/packages/standalone"
    # CODEX_INSTALL_DIR points the official installer at a private bin dir under
    # CODEX_HOME. Running it through setsid and a system-only PATH prevents TTY
    # prompts, user-managed CLI conflict prompts, ~/.local/bin/codex writes, and
    # shell profile PATH blocks.
    if [ "${fetch_cmd##*/}" = "curl" ]; then
        ( set -o pipefail
          "$fetch_cmd" -fsSL https://chatgpt.com/codex/install.sh | \
              CODEX_HOME="$codex_home" CODEX_INSTALL_DIR="$private_bin" PATH="$installer_path" "$setsid_path" sh -s -- "${installer_args[@]}"
        )
    else
        ( set -o pipefail
          "$fetch_cmd" -q -O - https://chatgpt.com/codex/install.sh | \
              CODEX_HOME="$codex_home" CODEX_INSTALL_DIR="$private_bin" PATH="$installer_path" "$setsid_path" sh -s -- "${installer_args[@]}"
        )
    fi
}

remote_mobile_control_main() {
    if truthy_env_value "${CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED:-}"; then
        echo "Remote mobile control daemon autostart disabled by CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED"
        return 0
    fi

    local codex_home="${CODEX_HOME:-$HOME/.codex}"
    local standalone_codex="${CODEX_REMOTE_CONTROL_CODEX_PATH:-$codex_home/packages/standalone/current/codex}"

    if [ ! -x "$standalone_codex" ]; then
        if [ -n "${CODEX_REMOTE_CONTROL_CODEX_PATH:-}" ]; then
            echo "Remote mobile control daemon runtime override is not executable: $CODEX_REMOTE_CONTROL_CODEX_PATH"
            return 0
        fi
        if truthy_env_value "${CODEX_REMOTE_CONTROL_RUNTIME_AUTO_INSTALL_DISABLED:-}"; then
            echo "Remote mobile control standalone runtime auto-install disabled by CODEX_REMOTE_CONTROL_RUNTIME_AUTO_INSTALL_DISABLED"
            return 0
        fi
        if ! install_remote_mobile_control_runtime "$codex_home"; then
            echo "Remote mobile control is enabled, but the standalone Codex daemon runtime could not be installed at $standalone_codex"
            echo "Brew or another CLI can remain the interactive Codex CLI; remote mobile control uses CODEX_REMOTE_CONTROL_CODEX_PATH separately."
            return 0
        fi
        if [ ! -x "$standalone_codex" ]; then
            echo "Remote mobile control standalone runtime installer completed but $standalone_codex is still missing"
            return 0
        fi
    fi

    if "$standalone_codex" app-server daemon start --enable remote_control; then
        echo "Remote mobile control daemon is ready via $standalone_codex"
    else
        echo "Remote mobile control daemon start failed via $standalone_codex; Android remote hosts may remain disconnected."
    fi
}

run_with_timeout() {
    local timeout_seconds="${CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_TIMEOUT_SECONDS:-30}"
    if command -v timeout >/dev/null 2>&1; then
        timeout "$timeout_seconds" "$0" --run-main || \
            echo "Remote mobile control hook timed out or failed after ${timeout_seconds}s"
    else
        remote_mobile_control_main
    fi
}

if [ "${1:-}" = "--run-main" ]; then
    remote_mobile_control_main
    exit $?
fi

echo "Remote mobile control cold-start hook started at $(date -Is 2>/dev/null || date)"
run_with_timeout
