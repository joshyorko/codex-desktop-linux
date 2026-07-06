#!/usr/bin/env bash
set -euo pipefail

feature_dir="$SCRIPT_DIR/linux-features/mcp-helper-reaper"
codex_linux_dir="$INSTALL_DIR/.codex-linux"
mcp_reaper_dir="$codex_linux_dir/mcp-helper-reaper"
resources_dir="$INSTALL_DIR/resources"
node_repl="$resources_dir/node_repl"
original_node_repl="$resources_dir/node_repl.codex-linux-original"

resolve_reaper_source() {
    if [ -n "${CODEX_MCP_HELPER_REAPER_SOURCE:-}" ]; then
        [ -x "$CODEX_MCP_HELPER_REAPER_SOURCE" ] || {
            echo "mcp-helper-reaper source is not executable: $CODEX_MCP_HELPER_REAPER_SOURCE" >&2
            return 1
        }
        printf '%s\n' "$CODEX_MCP_HELPER_REAPER_SOURCE"
        return 0
    fi

    (cd "$SCRIPT_DIR" && cargo build --release -p codex-mcp-helper-reaper >&2)
    printf '%s\n' "$SCRIPT_DIR/target/release/codex-mcp-helper-reaper"
}

reaper_source="$(resolve_reaper_source)"

mkdir -p "$mcp_reaper_dir" "$codex_linux_dir/cold-start.d" "$codex_linux_dir/after-exit.d"
install -m 0755 "$reaper_source" "$mcp_reaper_dir/codex-mcp-helper-reaper"
install -m 0755 "$feature_dir/node-repl-wrapper.sh" "$mcp_reaper_dir/node-repl-wrapper.sh"
install -m 0755 "$feature_dir/install-session-hook.sh" "$mcp_reaper_dir/install-session-hook.sh"
install -m 0755 "$feature_dir/cold-start-hook.sh" "$codex_linux_dir/cold-start.d/mcp-helper-reaper"
install -m 0755 "$feature_dir/after-exit-hook.sh" "$codex_linux_dir/after-exit.d/mcp-helper-reaper"

if [ ! -e "$node_repl" ]; then
    echo "mcp-helper-reaper staged: reaper installed; resources/node_repl not present to wrap" >&2
    exit 0
fi

if [ ! -e "$original_node_repl" ]; then
    mv "$node_repl" "$original_node_repl"
elif ! grep -q "mcp-helper-reaper-node-repl-wrapper" "$node_repl" 2>/dev/null; then
    echo "mcp-helper-reaper: refusing to overwrite resources/node_repl because original backup already exists and current entrypoint is not this feature's wrapper" >&2
    exit 1
fi

install -m 0755 "$feature_dir/node-repl-wrapper.sh" "$node_repl"

echo "mcp-helper-reaper staged: resources/node_repl wrapper and MCP helper reaper installed" >&2
