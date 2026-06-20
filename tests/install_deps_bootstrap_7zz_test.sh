#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_deps="$repo_dir/scripts/install-deps.sh"

if ! grep -Fq '2601' "$install_deps"; then
    echo "install-deps should try current 7-Zip 26.01 Linux tarballs" >&2
    exit 1
fi

if ! grep -Fq 'github.com/ip7z/7zip/releases/download' "$install_deps"; then
    echo "install-deps should fall back to official GitHub release assets when 7-zip.org probes fail" >&2
    exit 1
fi

