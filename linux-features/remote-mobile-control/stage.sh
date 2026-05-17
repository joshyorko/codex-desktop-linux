#!/usr/bin/env bash
set -euo pipefail

client="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs"
patch_module="$SCRIPT_DIR/linux-features/remote-mobile-control/patch.js"

if [ ! -f "$client" ]; then
    echo "WARN: Chrome browser-client.mjs not found; skipping remote-mobile Chrome bridge patch" >&2
    exit 0
fi

node - "$client" "$patch_module" <<'NODE'
const fs = require("node:fs");

const [clientPath, patchModulePath] = process.argv.slice(2);
const { applyLinuxRemoteMobileChromeBridgePatch } = require(patchModulePath);

const source = fs.readFileSync(clientPath, "utf8");
const patched = applyLinuxRemoteMobileChromeBridgePatch(source);
if (patched !== source) {
  fs.writeFileSync(clientPath, patched, "utf8");
  console.error("Remote mobile Chrome bridge patch applied");
} else if (patched.includes("codexLinuxRemoteMobileBrowserBackends")) {
  console.error("Remote mobile Chrome bridge patch already applied");
}
NODE
