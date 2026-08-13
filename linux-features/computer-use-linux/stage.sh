#!/bin/bash
set -Eeuo pipefail

backend="${CODEX_COMPUTER_USE_BINARY_SOURCE:-$SCRIPT_DIR/target/release/codex-computer-use-linux}"
cosmic="${CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE:-$SCRIPT_DIR/target/release/codex-computer-use-cosmic}"
template="$SCRIPT_DIR/plugins/openai-bundled/plugins/computer-use"
target="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/computer-use"

[ -x "$backend" ] || {
    echo "Linux Computer Use is enabled but its release binary is missing: $backend" >&2
    exit 1
}
[ -x "$cosmic" ] || {
    echo "Linux Computer Use is enabled but its COSMIC helper is missing: $cosmic" >&2
    exit 1
}
[ -d "$template" ] || {
    echo "Linux Computer Use plugin template is missing: $template" >&2
    exit 1
}

rm -rf "$target"
mkdir -p "$(dirname "$target")"
cp -a "$template" "$target"
mkdir -p "$target/bin"
cp "$backend" "$target/bin/codex-computer-use-linux"
cp "$cosmic" "$target/bin/codex-computer-use-cosmic"
chmod 0755 "$target/bin/codex-computer-use-linux" "$target/bin/codex-computer-use-cosmic"
