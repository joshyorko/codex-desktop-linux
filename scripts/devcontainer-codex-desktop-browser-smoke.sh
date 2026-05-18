#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${CODEX_DESKTOP_DEVCONTAINER_IMAGE:-ghcr.io/joshyorko/ror:latest}"
CONTAINER_ENGINE="${CONTAINER_ENGINE:-}"
SCREENSHOT_PATH="${CODEX_DESKTOP_SCREENSHOT_PATH:-$REPO_DIR/dist-next/devcontainer-codex-desktop-web.png}"
CONTAINER_SCREENSHOT="/workspace/codex-desktop-linux/dist-next/devcontainer-codex-desktop-web.png"
CONTAINER_DEBUG="/workspace/codex-desktop-linux/dist-next/devcontainer-codex-desktop-web-debug.json"
CONTAINER_WORKSPACE="/tmp/codex-desktop-workspace"
CASK_PATH="contrib/homebrew/codex-desktop-devcontainer.rb"
SERVE_PORT="${CODEX_DESKTOP_SERVE_PORT:-3773}"
CDP_PORT="${CODEX_DESKTOP_SMOKE_CDP_PORT:-9444}"

if [ -z "$CONTAINER_ENGINE" ]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
  else
    echo "docker or podman is required on the host to run the devcontainer browser smoke test" >&2
    exit 127
  fi
fi

mkdir -p "$(dirname "$SCREENSHOT_PATH")"

exec "$CONTAINER_ENGINE" run --rm \
  -v "$REPO_DIR:/workspace/codex-desktop-linux:rw,z" \
  -w /workspace/codex-desktop-linux \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail

    export HOMEBREW_NO_AUTO_UPDATE=1
    export HOMEBREW_NO_ANALYTICS=1
    export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"

    sudo apk add --no-cache chromium curl git iproute2 npm procps >/dev/null

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
    grep -q "serve" <<<"$codex_desktop_help"

    install -d -m 700 "'"$CONTAINER_WORKSPACE"'"
    profile_dir="'"$CONTAINER_WORKSPACE"'/.codex-desktop"

    if ! command -v codex >/dev/null 2>&1; then
      install -d -m 700 "$profile_dir"
      mkdir -p "$profile_dir/npm"
      npm install -g --prefix "$profile_dir/npm" @openai/codex@alpha >/tmp/codex-cli-install.log 2>&1
      export PATH="$profile_dir/npm/bin:$PATH"
      export CODEX_CLI_PATH="$profile_dir/npm/bin/codex"
    fi

    install -d -m 700 "$profile_dir"
    mkdir -p /workspace/codex-desktop-linux/dist-next

    CODEX_COMPUTER_CONTROL_MODE=browser-only \
      CODEX_BROWSER_USE_BROWSER_COMMAND=/nonexistent/chromium \
      codex-desktop serve \
      --workspace "'"$CONTAINER_WORKSPACE"'" \
      --profile "$profile_dir" \
      --bind 127.0.0.1 \
      --port 0 \
      --once-health-check >/tmp/codex-web-browser-only-health.json 2>&1
    grep -q "\"mode\": \"browser-only\"" /tmp/codex-web-browser-only-health.json
    grep -q "\"physical_host_control\": false" /tmp/codex-web-browser-only-health.json

    CODEX_BROWSER_USE_BROWSER_COMMAND=chromium \
      CODEX_BROWSER_CDP_PORT="'"$CDP_PORT"'" \
      codex-desktop serve \
      --workspace "'"$CONTAINER_WORKSPACE"'" \
      --profile "$profile_dir" \
      --bind 127.0.0.1 \
      --port "'"$SERVE_PORT"'" \
      >/tmp/codex-desktop-serve.log 2>&1 &
    serve_pid=$!
    chromium_pid=""
    cleanup() {
      if [ -n "${serve_pid:-}" ]; then
        kill "$serve_pid" >/dev/null 2>&1 || true
      fi
      if [ -n "${chromium_pid:-}" ]; then
        kill "$chromium_pid" >/dev/null 2>&1 || true
      fi
    }
    trap cleanup EXIT

    for _ in $(seq 1 160); do
      if curl --silent --fail --max-time 1 "http://127.0.0.1:'"$SERVE_PORT"'/__codex/health" >/tmp/codex-web-health.json; then
        break
      fi
      sleep 0.25
    done

    grep -q "\"mode\": \"devcontainer-web\"" /tmp/codex-web-health.json
    grep -q "\"bind\": \"127.0.0.1\"" /tmp/codex-web-health.json
    grep -q "\"loopback_only_default\": true" /tmp/codex-web-health.json
    grep -q "\"codex_home\": \"${CODEX_HOME:-$HOME/.codex}\"" /tmp/codex-web-health.json
    ! grep -q "\"codex_home\": \"$profile_dir" /tmp/codex-web-health.json
    grep -q "\"mode\": \"container-chromium\"" /tmp/codex-web-health.json
    grep -q "\"cdp_ready\": true" /tmp/codex-web-health.json
    grep -q "\"mode\": \"browser-only\"" /tmp/codex-web-health.json
    grep -q "\"physical_host_control\": false" /tmp/codex-web-health.json
    grep -q "\"available_backends\": \\[" /tmp/codex-web-health.json
    grep -q "\"cdp\"" /tmp/codex-web-health.json
    curl --silent --fail --max-time 1 "http://127.0.0.1:'"$CDP_PORT"'/json/version" >/tmp/codex-browser-use-cdp-version.json
    ss -ltnp | grep -q "127.0.0.1:'"$SERVE_PORT"'"
    ! ss -ltnp | grep -q "0.0.0.0:'"$SERVE_PORT"'"
    ! pgrep -fa "[X]vfb|[x]11vnc|[w]ebsockify|[n]ovnc" >/tmp/codex-web-forbidden-ui-transport.log 2>/dev/null
    curl --silent --fail "http://127.0.0.1:'"$SERVE_PORT"'/__codex/web-mode-bootstrap.js" >/tmp/codex-web-bootstrap.js
    bridge_token="$(awk -F "\"" '\''/^window\.__CODEX_WEB_TOKEN__ = / { print $2; exit }'\'' /tmp/codex-web-bootstrap.js)"
    test -n "$bridge_token"

    no_token_status="$(curl --silent --output /tmp/codex-web-bridge-no-token.json --write-out "%{http_code}" \
      -H "content-type: application/json" \
      -d "{\"method\":\"health.read\"}" \
      "http://127.0.0.1:'"$SERVE_PORT"'/__codex/bridge")"
    test "$no_token_status" = "401"
    grep -q "missing_or_invalid_token" /tmp/codex-web-bridge-no-token.json

    forbidden_origin_status="$(curl --silent --output /tmp/codex-web-bridge-forbidden-origin.json --write-out "%{http_code}" \
      -H "content-type: application/json" \
      -H "origin: http://example.invalid" \
      -H "x-codex-web-token: $bridge_token" \
      -d "{\"method\":\"health.read\"}" \
      "http://127.0.0.1:'"$SERVE_PORT"'/__codex/bridge")"
    test "$forbidden_origin_status" = "403"
    grep -q "forbidden_origin" /tmp/codex-web-bridge-forbidden-origin.json

    curl --silent --fail \
      -H "x-codex-web-token: $bridge_token" \
      "http://127.0.0.1:'"$SERVE_PORT"'/__codex/browser/status" >/tmp/codex-web-browser-status.json
    grep -q "\"mode\": \"container-chromium\"" /tmp/codex-web-browser-status.json
    grep -q "\"cdp_endpoint\": \"http://127.0.0.1:'"$CDP_PORT"'\"" /tmp/codex-web-browser-status.json
    grep -q "\"cdp_ready\": true" /tmp/codex-web-browser-status.json
    grep -q "\"native_pipe\"" /tmp/codex-web-browser-status.json
    grep -q "\"status\": \"listening\"" /tmp/codex-web-browser-status.json

    curl --silent --fail \
      -H "content-type: application/json" \
      -H "x-codex-web-token: $bridge_token" \
      -d "{\"method\":\"webState.write\",\"params\":{\"state\":{\"persistedAtoms\":{},\"globalState\":{\"devcontainer-smoke-marker\":\"persisted\"},\"sharedObjects\":{}}}}" \
      "http://127.0.0.1:'"$SERVE_PORT"'/__codex/bridge" >/tmp/codex-web-state-write.json
    kill "$serve_pid" >/dev/null 2>&1 || true
    wait "$serve_pid" >/dev/null 2>&1 || true

    CODEX_BROWSER_USE_BROWSER_COMMAND=chromium \
      CODEX_BROWSER_CDP_PORT=9334 \
      codex-desktop serve \
      --workspace "'"$CONTAINER_WORKSPACE"'" \
      --profile "$profile_dir" \
      --bind 127.0.0.1 \
      --port "'"$SERVE_PORT"'" \
      >/tmp/codex-desktop-serve-restart.log 2>&1 &
    serve_pid=$!

    for _ in $(seq 1 160); do
      if curl --silent --fail --max-time 1 "http://127.0.0.1:'"$SERVE_PORT"'/__codex/health" >/tmp/codex-web-health-restart.json; then
        break
      fi
      sleep 0.25
    done
    grep -q "\"cdp_endpoint\": \"http://127.0.0.1:9334\"" /tmp/codex-web-health-restart.json
    grep -q "\"cdp_ready\": true" /tmp/codex-web-health-restart.json
    curl --silent --fail --max-time 1 "http://127.0.0.1:9334/json/version" >/tmp/codex-browser-use-cdp-version-restart.json
    curl --silent --fail "http://127.0.0.1:'"$SERVE_PORT"'/__codex/web-mode-bootstrap.js" >/tmp/codex-web-bootstrap-restart.js
    bridge_token="$(awk -F "\"" '\''/^window\.__CODEX_WEB_TOKEN__ = / { print $2; exit }'\'' /tmp/codex-web-bootstrap-restart.js)"
    test -n "$bridge_token"
    curl --silent --fail \
      -H "content-type: application/json" \
      -H "x-codex-web-token: $bridge_token" \
      -d "{\"method\":\"webState.read\"}" \
      "http://127.0.0.1:'"$SERVE_PORT"'/__codex/bridge" >/tmp/codex-web-state-read.json
    grep -q "devcontainer-smoke-marker" /tmp/codex-web-state-read.json

    chromium \
      --headless=new \
      --no-sandbox \
      --disable-gpu \
      --window-size=1440,1000 \
      --remote-debugging-address=127.0.0.1 \
      --remote-debugging-port="'"$CDP_PORT"'" \
      --user-data-dir=/tmp/codex-devcontainer-web-chrome \
      "http://127.0.0.1:'"$SERVE_PORT"'/" >/tmp/codex-devcontainer-web-chromium.log 2>&1 &
    chromium_pid=$!

    for _ in $(seq 1 80); do
      if curl --silent --fail --max-time 1 "http://127.0.0.1:'"$CDP_PORT"'/json/list" >/tmp/codex-devtools-pages.json; then
        break
      fi
      sleep 0.25
    done

    CODEX_WEB_SCREENSHOT="'"$CONTAINER_SCREENSHOT"'" CODEX_WEB_DEBUG="'"$CONTAINER_DEBUG"'" CODEX_WEB_CDP_PORT="'"$CDP_PORT"'" node <<\NODE
const fs = await import("node:fs");
const pages = await fetch(`http://127.0.0.1:${process.env.CODEX_WEB_CDP_PORT}/json/list`).then((response) => response.json());
const page = pages.find((candidate) => candidate.url.startsWith("http://127.0.0.1:'"$SERVE_PORT"'/"));
if (!page) {
  throw new Error(`no Codex web page found: ${JSON.stringify(pages)}`);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const events = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled") {
    events.push({
      type: "console",
      level: message.params.type,
      args: message.params.args?.map((arg) => arg.value ?? arg.description ?? arg.type),
    });
  } else if (message.method === "Runtime.exceptionThrown") {
    events.push({
      type: "exception",
      text: message.params.exceptionDetails?.text,
      description: message.params.exceptionDetails?.exception?.description,
    });
  } else if (message.method === "Log.entryAdded") {
    events.push({
      type: "log",
      level: message.params.entry?.level,
      text: message.params.entry?.text,
    });
  }
  if (!message.id) return;
  const callbacks = pending.get(message.id);
  if (!callbacks) return;
  pending.delete(message.id);
  if (message.error) {
    callbacks.reject(new Error(`${message.error.code}: ${message.error.message}`));
  } else {
    callbacks.resolve(message.result);
  }
});

function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Log.enable");

let lastState = null;
for (let attempt = 0; attempt < 120; attempt += 1) {
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const doc = document.documentElement;
      const body = document.body?.innerText || "";
      return {
        title: document.title,
        bodyText: body.trim().slice(0, 1000),
        bodyTextLength: body.trim().length,
        hasBridge: Boolean(window.electronBridge),
        codexWindowType: doc.dataset.codexWindowType || doc.dataset.windowType || null,
        codexOs: doc.dataset.codexOs || null,
        hasRoot: Boolean(document.querySelector("#root, [data-testid], [data-codex-window-type]")),
        hasErrorBoundary: body.includes("Oops, an error has occurred"),
        url: location.href
      };
    })()`,
    returnByValue: true,
  });
  lastState = result.result.value;
  if (
    lastState.hasBridge &&
    lastState.codexWindowType === "electron" &&
    lastState.codexOs === "linux" &&
    lastState.bodyTextLength > 0 &&
    !lastState.hasErrorBoundary
  ) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
fs.writeFileSync(process.env.CODEX_WEB_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
fs.writeFileSync(process.env.CODEX_WEB_DEBUG, `${JSON.stringify({ lastState, events }, null, 2)}\n`);
ws.close();

if (
  !(
    lastState?.hasBridge &&
    lastState?.codexWindowType === "electron" &&
    lastState?.codexOs === "linux" &&
    lastState?.bodyTextLength > 0 &&
    !lastState?.hasErrorBoundary
  )
) {
  throw new Error(`Codex web UI did not become ready: ${JSON.stringify(lastState)}; events=${JSON.stringify(events.slice(-20))}`);
}
NODE
    kill "$chromium_pid" >/dev/null 2>&1 || true

    test -s "'"$CONTAINER_SCREENSHOT"'"
    printf "%s\n" "'"$CONTAINER_SCREENSHOT"'"
  '
