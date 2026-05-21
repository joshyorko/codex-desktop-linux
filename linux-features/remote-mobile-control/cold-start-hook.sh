#!/usr/bin/env bash
set -euo pipefail

truthy_env_value() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

cleanup_remote_mobile_control_interactive_symlink() {
    local codex_home="$1"
    local home_dir="${HOME:-}"
    local user_codex=""
    local resolved_user_codex=""
    local standalone_root=""

    [ -n "$home_dir" ] || return 0
    user_codex="$home_dir/.local/bin/codex"
    [ -L "$user_codex" ] || return 0
    resolved_user_codex="$(readlink -f "$user_codex" 2>/dev/null || true)"
    [ -n "$resolved_user_codex" ] || return 0
    standalone_root="$(readlink -f "$codex_home/packages/standalone" 2>/dev/null || true)"
    [ -n "$standalone_root" ] || standalone_root="$codex_home/packages/standalone"

    case "$resolved_user_codex" in
        "$standalone_root"/*)
            if rm -f "$user_codex"; then
                echo "Removed remote mobile control standalone symlink from interactive PATH: $user_codex -> $resolved_user_codex"
            fi
            ;;
    esac
}

install_remote_mobile_control_runtime() {
    local codex_home="$1"
    local private_bin="$codex_home/packages/standalone/.bin"
    local system_path="/run/current-system/sw/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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

resolve_remote_mobile_control_codex() {
    local codex_home="$1"

    if [ -n "${CODEX_REMOTE_CONTROL_CODEX_PATH:-}" ]; then
        printf '%s\n' "$CODEX_REMOTE_CONTROL_CODEX_PATH"
        return 0
    fi

    if [ -n "${CODEX_CLI_PATH:-}" ] && [ -x "$CODEX_CLI_PATH" ]; then
        printf '%s\n' "$CODEX_CLI_PATH"
        return 0
    fi

    if command -v codex >/dev/null 2>&1; then
        command -v codex
        return 0
    fi

    printf '%s\n' "$codex_home/packages/standalone/current/codex"
}

path_inside_dir() {
    local candidate="$1"
    local dir="$2"

    [ -n "$candidate" ] || return 1
    [ -n "$dir" ] || return 1
    case "$candidate" in
        "$dir"|"$dir"/*) return 0 ;;
        *) return 1 ;;
    esac
}

remote_mobile_control_daemon_pid() {
    local pid_file="$1"

    [ -f "$pid_file" ] || return 1
    sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$pid_file" | head -n 1
}

remote_mobile_process_mentions_path() {
    local pid="$1"
    local needle="$2"
    local cmdline=""

    [ -n "$pid" ] || return 1
    [ -n "$needle" ] || return 1
    [ -r "/proc/$pid/cmdline" ] || return 1
    cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmdline" in
        *"$needle"*) return 0 ;;
        *) return 1 ;;
    esac
}

stop_stale_standalone_remote_mobile_daemon() {
    local codex_home="$1"
    local daemon_codex="$2"
    local standalone_root="$3"
    local daemon_pid=""
    local daemon_codex_resolved=""
    local daemon_exe=""

    daemon_codex_resolved="$(readlink -f "$daemon_codex" 2>/dev/null || true)"
    [ -n "$daemon_codex_resolved" ] || daemon_codex_resolved="$daemon_codex"
    if path_inside_dir "$daemon_codex_resolved" "$standalone_root"; then
        return 0
    fi

    daemon_pid="$(remote_mobile_control_daemon_pid "$codex_home/app-server-daemon/app-server.pid" || true)"
    [ -n "$daemon_pid" ] || return 0
    kill -0 "$daemon_pid" 2>/dev/null || return 0

    daemon_exe="$(readlink -f "/proc/$daemon_pid/exe" 2>/dev/null || true)"
    if ! path_inside_dir "$daemon_exe" "$standalone_root" &&
        ! remote_mobile_process_mentions_path "$daemon_pid" "$standalone_root"; then
        return 0
    fi

    echo "Stopping stale remote mobile control standalone daemon pid=$daemon_pid before switching to $daemon_codex"
    "$daemon_codex" remote-control stop || \
        echo "Remote mobile control could not stop stale standalone daemon pid=$daemon_pid; continuing best-effort"
}

remote_mobile_control_main() {
    local codex_home="${CODEX_HOME:-$HOME/.codex}"

    cleanup_remote_mobile_control_interactive_symlink "$codex_home"

    if truthy_env_value "${CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED:-}"; then
        echo "Remote mobile control daemon autostart disabled by CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED"
        return 0
    fi
    if command -v systemctl >/dev/null 2>&1 &&
        systemctl --user is-active --quiet codex-remote-control.service 2>/dev/null; then
        echo "Remote mobile control daemon autostart skipped; codex-remote-control.service is already active"
        return 0
    fi

    local standalone_codex="$codex_home/packages/standalone/current/codex"
    local standalone_root
    local daemon_codex
    standalone_root="$(readlink -f "$codex_home/packages/standalone" 2>/dev/null || true)"
    [ -n "$standalone_root" ] || standalone_root="$codex_home/packages/standalone"
    daemon_codex="$(resolve_remote_mobile_control_codex "$codex_home")"

    if [ ! -x "$daemon_codex" ]; then
        if [ -n "${CODEX_REMOTE_CONTROL_CODEX_PATH:-}" ]; then
            echo "Remote mobile control daemon runtime override is not executable: $CODEX_REMOTE_CONTROL_CODEX_PATH"
            return 0
        fi
        if [ "$daemon_codex" != "$standalone_codex" ]; then
            echo "Remote mobile control daemon runtime is not executable: $daemon_codex"
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
        if [ ! -x "$daemon_codex" ]; then
            echo "Remote mobile control standalone runtime installer completed but $daemon_codex is still missing"
            return 0
        fi
    fi

    stop_stale_standalone_remote_mobile_daemon "$codex_home" "$daemon_codex" "$standalone_root"

    if "$daemon_codex" remote-control start; then
        echo "Remote mobile control daemon is ready via $daemon_codex"
    else
        echo "Remote mobile control daemon start failed via $daemon_codex; Android remote hosts may remain disconnected."
    fi
}

run_with_timeout() {
    local timeout_seconds="${CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_TIMEOUT_SECONDS:-30}"
    if command -v timeout >/dev/null 2>&1; then
        timeout "$timeout_seconds" "$0" --run-main || \
            echo "Remote mobile control hook timed out or failed after ${timeout_seconds}s"
    else
        echo "Remote mobile control hook running without timeout; continuing best-effort in the background"
        remote_mobile_control_main &
    fi
}

if [ "${1:-}" = "--run-main" ]; then
    remote_mobile_control_main
    exit $?
fi

echo "Remote mobile control cold-start hook started at $(date -Is 2>/dev/null || date)"
run_with_timeout
