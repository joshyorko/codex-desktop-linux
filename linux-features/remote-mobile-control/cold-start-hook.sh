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
    local active_cli_path=""
    local resolved_active_cli_path=""
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
            active_cli_path="${CODEX_CLI_PATH:-}"
            if [ -n "$active_cli_path" ]; then
                resolved_active_cli_path="$(readlink -f "$active_cli_path" 2>/dev/null || true)"
                if [ "$active_cli_path" = "$user_codex" ] ||
                    { [ -n "$resolved_active_cli_path" ] && [ "$resolved_active_cli_path" = "$resolved_user_codex" ]; }; then
                    echo "Preserved active CODEX_CLI_PATH symlink: $user_codex -> $resolved_user_codex"
                    return 0
                fi
            fi
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

cleanup_stale_remote_mobile_daemon_state() {
    local codex_home="$1"
    local pid_file=""
    local pid=""

    for pid_file in \
        "$codex_home/app-server-daemon/app-server.pid" \
        "$codex_home/app-server-daemon/app-server-updater.pid"
    do
        [ -e "$pid_file" ] || continue
        pid="$(remote_mobile_control_daemon_pid "$pid_file" || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            continue
        fi
        if rm -f "$pid_file"; then
            echo "Removed stale remote mobile control daemon pid file: $pid_file"
        fi
    done
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

remote_mobile_proc_is_current_user() {
    local pid="$1"
    local uid=""

    [ -r "/proc/$pid/status" ] || return 1
    uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null || true)"
    [ "$uid" = "$(id -u)" ]
}

remote_mobile_proc_env_value() {
    local pid="$1"
    local key="$2"
    local entry=""

    [ -r "/proc/$pid/environ" ] || return 1
    while IFS= read -r -d '' entry; do
        case "$entry" in
            "$key="*)
                printf '%s\n' "${entry#*=}"
                return 0
                ;;
        esac
    done < "/proc/$pid/environ"
    return 1
}

remote_mobile_proc_start_time() {
    local pid="$1"
    local stat_line=""
    local rest=""

    stat_line="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
    rest="${stat_line##*) }"
    # shellcheck disable=SC2086
    set -- $rest
    [ -n "${20:-}" ] || return 1
    printf '%s\n' "$20"
}

remote_mobile_is_remote_control_app_server() {
    local pid="$1"
    local argv=()
    local arg=""
    local has_remote_control=0

    [ -r "/proc/$pid/cmdline" ] || return 1
    mapfile -d '' -t argv < "/proc/$pid/cmdline" 2>/dev/null || return 1
    [ "${argv[1]:-}" = "app-server" ] || return 1
    case "${argv[0]##*/}" in
        codex|codex-*) ;;
        *) return 1 ;;
    esac
    for arg in "${argv[@]:2}"; do
        [ "$arg" = "--remote-control" ] && has_remote_control=1
    done
    [ "$has_remote_control" -eq 1 ]
}

remote_mobile_should_reap_desktop_app_server() {
    local pid="$1"
    local current_app_dir="${CODEX_LINUX_APP_DIR:-}"
    local current_app_id="${CODEX_LINUX_APP_ID:-}"
    local owner_app_dir=""
    local owner_app_id=""

    [ -n "$current_app_dir" ] || return 1
    [ -n "$current_app_id" ] || return 1
    [ "$pid" != "$$" ] || return 1
    [ -d "/proc/$pid" ] || return 1
    remote_mobile_proc_is_current_user "$pid" || return 1
    remote_mobile_is_remote_control_app_server "$pid" || return 1

    owner_app_dir="$(remote_mobile_proc_env_value "$pid" CODEX_LINUX_APP_DIR 2>/dev/null || true)"
    [ -n "$owner_app_dir" ] || return 1
    [ "$owner_app_dir" != "$current_app_dir" ] || return 1

    owner_app_id="$(remote_mobile_proc_env_value "$pid" CODEX_LINUX_APP_ID 2>/dev/null || true)"
    [ -n "$owner_app_id" ] || return 1
    [ "$owner_app_id" = "$current_app_id" ]
}

remote_mobile_proc_identity_matches() {
    local pid="$1"
    local expected_start_time="$2"
    local expected_app_dir="$3"
    local start_time=""
    local app_dir=""

    [ -d "/proc/$pid" ] || return 1
    remote_mobile_is_remote_control_app_server "$pid" || return 1
    start_time="$(remote_mobile_proc_start_time "$pid" 2>/dev/null || true)"
    [ -n "$start_time" ] && [ "$start_time" = "$expected_start_time" ] || return 1
    app_dir="$(remote_mobile_proc_env_value "$pid" CODEX_LINUX_APP_DIR 2>/dev/null || true)"
    [ "$app_dir" = "$expected_app_dir" ]
}

reap_stale_desktop_remote_control_app_servers() {
    local proc=""
    local pid=""
    local owner_app_dir=""
    local start_time=""
    local entries=()
    local entry=""
    local still_running=0

    for proc in /proc/[0-9]*/cmdline; do
        [ -r "$proc" ] || continue
        pid="${proc#/proc/}"
        pid="${pid%/cmdline}"
        remote_mobile_should_reap_desktop_app_server "$pid" || continue
        owner_app_dir="$(remote_mobile_proc_env_value "$pid" CODEX_LINUX_APP_DIR 2>/dev/null || true)"
        start_time="$(remote_mobile_proc_start_time "$pid" 2>/dev/null || true)"
        [ -n "$owner_app_dir" ] && [ -n "$start_time" ] || continue
        echo "Stopping stale Desktop remote-control app-server pid=$pid app_dir=$owner_app_dir"
        kill "$pid" 2>/dev/null || continue
        entries+=("$pid:$start_time:$owner_app_dir")
    done

    [ "${#entries[@]}" -gt 0 ] || return 0
    for _ in $(seq 1 40); do
        still_running=0
        for entry in "${entries[@]}"; do
            pid="${entry%%:*}"
            if kill -0 "$pid" 2>/dev/null; then
                still_running=1
                break
            fi
        done
        [ "$still_running" -eq 0 ] && return 0
        sleep 0.05
    done

    for entry in "${entries[@]}"; do
        pid="${entry%%:*}"
        start_time="${entry#*:}"
        start_time="${start_time%%:*}"
        owner_app_dir="${entry#*:*:}"
        remote_mobile_proc_identity_matches "$pid" "$start_time" "$owner_app_dir" || continue
        echo "WARN: stale Desktop remote-control app-server still running after SIGTERM; sending SIGKILL pid=$pid app_dir=$owner_app_dir"
        kill -9 "$pid" 2>/dev/null || true
    done
}

desktop_app_server_remote_control_enabled() {
    local app_dir="${CODEX_LINUX_APP_DIR:-}"
    local marker=""

    if truthy_env_value "${CODEX_REMOTE_CONTROL_FORCE_COLD_START_DAEMON:-}"; then
        return 1
    fi

    [ -n "$app_dir" ] || return 1
    marker="$app_dir/.codex-linux/desktop-app-server-remote-control-enabled"
    [ -f "$marker" ]
}

stop_stale_standalone_remote_mobile_daemon() {
    local codex_home="$1"
    local daemon_codex="$2"
    local standalone_root="$3"
    local standalone_codex="$4"
    local daemon_pid=""
    local daemon_codex_resolved=""
    local daemon_exe=""
    local stop_codex=""

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
    if [ -x "$standalone_codex" ]; then
        stop_codex="$standalone_codex"
    else
        stop_codex="$daemon_codex"
    fi
    "$stop_codex" remote-control stop || \
        echo "Remote mobile control could not stop stale standalone daemon pid=$daemon_pid; continuing best-effort"
}

remote_mobile_control_main() {
    local codex_home="${CODEX_HOME:-$HOME/.codex}"
    local standalone_codex="$codex_home/packages/standalone/current/codex"
    local standalone_root
    local daemon_codex

    standalone_root="$(readlink -f "$codex_home/packages/standalone" 2>/dev/null || true)"
    [ -n "$standalone_root" ] || standalone_root="$codex_home/packages/standalone"

    cleanup_remote_mobile_control_interactive_symlink "$codex_home"
    if desktop_app_server_remote_control_enabled; then
        reap_stale_desktop_remote_control_app_servers
    fi

    if truthy_env_value "${CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED:-}"; then
        echo "Remote mobile control daemon autostart disabled by CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED"
        return 0
    fi
    if command -v systemctl >/dev/null 2>&1 &&
        systemctl --user is-active --quiet codex-remote-control.service 2>/dev/null; then
        echo "Remote mobile control daemon autostart skipped; codex-remote-control.service is already active"
        return 0
    fi
    if desktop_app_server_remote_control_enabled; then
        cleanup_stale_remote_mobile_daemon_state "$codex_home"
        daemon_codex="$(resolve_remote_mobile_control_codex "$codex_home")"
        stop_stale_standalone_remote_mobile_daemon "$codex_home" "$daemon_codex" "$standalone_root" "$standalone_codex"
        echo "Remote mobile control daemon autostart skipped; Desktop app-server launches with remote-control enabled"
        return 0
    fi

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

    stop_stale_standalone_remote_mobile_daemon "$codex_home" "$daemon_codex" "$standalone_root" "$standalone_codex"

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
