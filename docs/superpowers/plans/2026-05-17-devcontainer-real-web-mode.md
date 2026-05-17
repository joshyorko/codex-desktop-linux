# Devcontainer Real Web Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove `codex-desktop serve` as a real browser-hosted devcontainer mode for issue #9 without using noVNC/Xvfb as the UI transport.

**Architecture:** The first implementation is a loopback-only Node web host shipped beside `start.sh`. It serves the patched `content/webview` bundle, injects a browser bootstrap, exposes `/__codex/*` diagnostics and bridge endpoints, proxies a devcontainer-local `codex app-server` through an owned loopback process, persists state under `--profile`, launches container-local Chromium/CDP for Browser Use diagnostics, and forces Computer Use into browser-only/disabled mode unless an explicit future virtual-display mode is requested. Native Electron launch remains unchanged.

**Tech Stack:** POSIX/Bash launcher, managed Node.js runtime already bundled by this repo, Node built-in `http`/`child_process`/`fs`, existing `launcher/webview-server.py` kept for native Electron path, existing shell smoke tests, Docker/ghcr.io/joshyorko/ror:latest devcontainer smoke, Chromium CDP screenshot capture.

---

## File Structure

- Create `launcher/web-mode-server.mjs`: Node web host for `codex-desktop serve`. Owns argument parsing, loopback listener policy, profile directories, app-server child lifecycle, static webview serving, bootstrap injection, health/doctor JSON, bridge WebSocket/HTTP facade, and browser sidecar diagnostics.
- Create `launcher/web-mode-bootstrap.js`: browser bootstrap injected before the upstream webview entrypoint. Provides safe browser globals for the first render and a bridge client under `window.codexDesktopWeb`.
- Create `scripts/web-mode-inventory.mjs`: scans extracted/generated webview assets for Electron/preload/VS Code host API dependencies and emits `dist-next/web-mode/bridge-inventory.json`.
- Modify `install.sh`: stage `web-mode-server.mjs`, `web-mode-bootstrap.js`, and any web-mode helper files into `codex-app/.codex-linux/`.
- Modify `launcher/start.sh.template`: add `serve`, `web --inspect`, and `doctor --mode devcontainer` command routing before native Electron startup; keep existing `web --inspect` compatibility.
- Modify `packaging/linux/codex-packaged-runtime.sh`: export devcontainer-safe defaults only for `serve`, not native desktop launch.
- Modify `scripts/lib/package-common.sh`: include new launcher files in update-builder bundles.
- Modify `contrib/homebrew/codex-desktop-devcontainer.rb`: update caveats/smoke command to use `codex-desktop serve`.
- Modify `scripts/devcontainer-codex-desktop-browser-smoke.sh`: replace noVNC smoke with real web-mode smoke and screenshot.
- Modify `scripts/devcontainer-codex-desktop-host.sh`: keep as Phase 1 compatibility harness, but stop presenting it as the primary acceptance path.
- Modify `tests/scripts_smoke.sh`: add static tests for command routing, listener policy, staged files, Computer Use guard defaults, Browser Use CDP defaults, and updated devcontainer smoke.
- Modify `README.md`: document `codex-desktop serve`, loopback security, profile layout, Browser Use mode, Computer Use guard, and noVNC as Phase 1 compatibility only.

## Task 1: Bridge Inventory

**Files:**
- Create: `scripts/web-mode-inventory.mjs`
- Test: `tests/scripts_smoke.sh`

- [ ] **Step 1: Add failing smoke assertions**

Add a smoke test that requires:

```bash
assert_file_exists "$REPO_DIR/scripts/web-mode-inventory.mjs"
node "$REPO_DIR/scripts/web-mode-inventory.mjs" --webview-dir "$TMP_DIR/webview-fixture" --out "$TMP_DIR/bridge-inventory.json"
assert_contains "$TMP_DIR/bridge-inventory.json" '"schema_version": 1'
assert_contains "$TMP_DIR/bridge-inventory.json" '"host_api_markers"'
```

- [ ] **Step 2: Implement inventory script**

The script accepts `--webview-dir <dir>` and `--out <file>`, recursively scans `.js`, `.mjs`, and `.html`, counts markers for `acquireVsCodeApi`, `dispatchHostMessage`, `dispatchMessage`, `ipcRenderer`, `electron`, `vscode://codex`, `get-global-state`, `set-global-state`, `computer_use`, `Browser Use`, and writes deterministic JSON.

- [ ] **Step 3: Verify**

Run:

```bash
bash tests/scripts_smoke.sh
```

Expected: smoke test passes.

## Task 2: Serve Command Skeleton

**Files:**
- Create: `launcher/web-mode-server.mjs`
- Create: `launcher/web-mode-bootstrap.js`
- Modify: `install.sh`
- Modify: `launcher/start.sh.template`
- Modify: `scripts/lib/package-common.sh`
- Test: `tests/scripts_smoke.sh`

- [ ] **Step 1: Add failing smoke assertions**

Assert the launcher stages and routes:

```bash
assert_contains "$REPO_DIR/install.sh" 'web-mode-server.mjs'
assert_contains "$REPO_DIR/install.sh" 'web-mode-bootstrap.js'
assert_contains "$REPO_DIR/launcher/start.sh.template" 'codex_desktop_serve'
assert_contains "$REPO_DIR/launcher/start.sh.template" 'serve --workspace'
assert_contains "$REPO_DIR/launcher/start.sh.template" 'CODEX_DESKTOP_WEB_MODE=1'
assert_contains "$REPO_DIR/scripts/lib/package-common.sh" 'web-mode-server.mjs'
```

- [ ] **Step 2: Implement `codex_desktop_serve` routing**

Before native Electron preflight, route:

```bash
codex-desktop serve --workspace /workspace --profile /workspace/.codex-desktop
codex-desktop web --inspect
codex-desktop doctor --mode devcontainer
```

`serve` calls the managed Node runtime if present, else `node`, executing `.codex-linux/web-mode-server.mjs`.

- [ ] **Step 3: Implement web host health**

`web-mode-server.mjs` must:

- parse `--workspace`, `--profile`, `--bind`, `--port`;
- default bind to `127.0.0.1`;
- fail if bind is non-loopback and no `--require-token` is present;
- create profile subdirs `profile`, `browser`, `run`, `logs`;
- serve `/__codex/health`, `/__codex/doctor`, `/__codex/bridge`;
- serve `content/webview` static assets;
- inject `web-mode-bootstrap.js` into `index.html`;
- print the final URL.

- [ ] **Step 4: Verify local generated app path**

Run against a tiny fixture:

```bash
tmp="$(mktemp -d)"
mkdir -p "$tmp/content/webview" "$tmp/.codex-linux"
printf '<html><head></head><body><div id="startup-loader"></div></body></html>' > "$tmp/content/webview/index.html"
cp launcher/web-mode-server.mjs launcher/web-mode-bootstrap.js "$tmp/.codex-linux/"
"$tmp/.codex-linux/web-mode-server.mjs" --workspace "$tmp/workspace" --profile "$tmp/profile" --port 0 --once-health-check
```

Expected: exits 0 after health check.

## Task 3: App-Server Bridge

**Files:**
- Modify: `launcher/web-mode-server.mjs`
- Test: `tests/scripts_smoke.sh`

- [ ] **Step 1: Add static and fixture assertions**

Require:

```bash
assert_contains "$REPO_DIR/launcher/web-mode-server.mjs" 'codex app-server'
assert_contains "$REPO_DIR/launcher/web-mode-server.mjs" 'stdio'
assert_contains "$REPO_DIR/launcher/web-mode-server.mjs" 'initialize'
assert_contains "$REPO_DIR/launcher/web-mode-server.mjs" 'get-auth-status'
```

- [ ] **Step 2: Implement bridge process lifecycle**

Start `codex app-server --listen stdio://` with env scoped to the profile:

```text
CODEX_HOME=<profile>/profile/codex-home
XDG_CONFIG_HOME=<profile>/profile/xdg-config
XDG_CACHE_HOME=<profile>/profile/xdg-cache
XDG_STATE_HOME=<profile>/profile/xdg-state
```

Expose:

- `GET /__codex/app-server/status`;
- `POST /__codex/app-server/rpc`;
- `GET /__codex/app-server/events` as server-sent events for notifications.

- [ ] **Step 3: Implement JSON-RPC framing**

Use newline-delimited JSON-RPC messages for stdio if supported by observed app-server behavior. If app-server uses Content-Length framing, implement Content-Length parser/writer and keep tests fixture-based.

- [ ] **Step 4: Verify with local CLI**

Run:

```bash
CODEX_HOME="$(mktemp -d)" codex app-server --listen stdio://
```

Then use the server fixture endpoint to call initialize/auth status. Expected: bridge starts and reports either authenticated or login-needed, not crash.

## Task 4: Browser Use Container Mode

**Files:**
- Modify: `launcher/web-mode-server.mjs`
- Modify: `scripts/devcontainer-codex-desktop-browser-smoke.sh`
- Test: `tests/scripts_smoke.sh`

- [ ] **Step 1: Add assertions**

Require web mode to expose:

```text
CODEX_BROWSER_MODE=container-chromium
CODEX_BROWSER_PROFILE_DIR=<profile>/browser
CODEX_BROWSER_CDP_ENDPOINT=http://127.0.0.1:<port>
CODEX_BROWSER_USE_SOCKET_DIR=<profile>/run/browser-use
```

- [ ] **Step 2: Implement Chromium/CDP discovery**

Find `chromium`, `chromium-browser`, `google-chrome`, or `brave-browser` inside the container. Launch with:

```bash
--headless=new
--remote-debugging-address=127.0.0.1
--remote-debugging-port=0
--user-data-dir=<profile>/browser/chromium
--no-sandbox
--disable-dev-shm-usage
```

If launch fails, report `browser_mode: disabled` with reason.

- [ ] **Step 3: Verify CDP**

`GET /__codex/browser/status` returns `container-chromium` and a loopback CDP endpoint when Chromium exists.

## Task 5: Computer Use Guard

**Files:**
- Modify: `launcher/web-mode-server.mjs`
- Modify: `plugins/openai-bundled/plugins/computer-use/.mcp.json` only if needed
- Modify: `computer-use-linux/src/main.rs` only if runtime guard is needed
- Test: `tests/scripts_smoke.sh`

- [ ] **Step 1: Add smoke assertions**

Require:

```bash
assert_contains "$REPO_DIR/launcher/web-mode-server.mjs" 'CODEX_COMPUTER_USE_BROWSER_ONLY'
assert_contains "$REPO_DIR/launcher/web-mode-server.mjs" 'browser-only'
```

- [ ] **Step 2: Enforce web-mode guard**

For `serve`, set:

```text
CODEX_DESKTOP_DEVCONTAINER_MODE=1
CODEX_COMPUTER_USE_BROWSER_ONLY=1
CODEX_COMPUTER_CONTROL_MODE=browser-only
```

Doctor must report desktop control disabled by mode and must not recommend host `ydotool`, portals, GNOME extensions, or compositor setup.

- [ ] **Step 3: Rust backend guard if reachable**

If the plugin can still start the Rust backend in web mode, add an early guard in `computer-use-linux/src/main.rs` before desktop/session bus hydration. With browser-only mode, desktop tools should not probe host APIs.

## Task 6: Devcontainer Smoke And Screenshot

**Files:**
- Modify: `scripts/devcontainer-codex-desktop-browser-smoke.sh`
- Modify: `scripts/devcontainer-homebrew-smoke.sh`
- Modify: `contrib/homebrew/codex-desktop-devcontainer.rb`
- Test: `tests/scripts_smoke.sh`

- [ ] **Step 1: Replace acceptance smoke path**

The browser smoke must:

- install cask into `ghcr.io/joshyorko/ror:latest`;
- run `codex-desktop serve --workspace /workspace --profile /workspace/.codex-desktop --port 3773`;
- open `http://127.0.0.1:3773` in headless Chromium;
- assert no URL contains `/vnc.html`;
- assert `/__codex/health` says `loopback_only_default: true`;
- capture screenshot to `dist-next/devcontainer-codex-desktop-web.png`.

- [ ] **Step 2: Preserve Phase 1 harness**

Keep `scripts/devcontainer-codex-desktop-host.sh` as compatibility harness and label it that way in docs/tests.

- [ ] **Step 3: Run smoke**

Run:

```bash
./scripts/devcontainer-codex-desktop-browser-smoke.sh
```

Expected: installs in RoR image, starts serve mode, produces non-empty screenshot.

## Task 7: Docs And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-05-17-real-web-architecture-design.md` if implementation reality differs
- Test: all relevant commands

- [ ] **Step 1: Update docs**

Document:

- `codex-desktop serve --workspace /workspace --profile /workspace/.codex-desktop`;
- DevPod/local port-forward access;
- loopback-only default and non-loopback auth requirement;
- profile persistence paths;
- Browser Use container Chromium/CDP;
- Computer Use browser-only/disabled guard;
- noVNC as Phase 1 compatibility only.

- [ ] **Step 2: Run verification**

Run:

```bash
bash tests/scripts_smoke.sh
./scripts/devcontainer-homebrew-smoke.sh
./scripts/devcontainer-codex-desktop-browser-smoke.sh
```

Expected: all pass.

- [ ] **Step 3: Final proof**

Final artifact must include:

- `dist-next/devcontainer-codex-desktop-web.png`;
- command output summary proving brew install, serve URL, loopback listener, Browser Use mode, Computer Use mode, and app-server bridge status.

