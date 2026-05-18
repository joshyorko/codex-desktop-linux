# Codex Desktop Serve Contract Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codex-desktop serve` measurable as its own host product before more web-mode feature patches land.

**Architecture:** Keep the browser-hosted renderer, but define the host side as a contract: runtime classification, capability matrix, typed bridge responses, protected resource proxy, and screen contract tests. The first bet is a one-day spike that produces evidence, not another minified-bundle chase.

**Tech Stack:** Node.js web-mode server and bootstrap, Codex app-server stdio RPC, browser-facing HTTP endpoints, shell smoke tests.

---

## Pitch

`codex-desktop serve` should be treated as its own host product, not "whatever browser shim makes the current upstream desktop bundle limp along."

The current failure pattern is a contract problem. Settings pages disappear when the renderer sees the wrong runtime. Connections partially renders, then reaches backend routes web mode does not own yet. Mic visibility depends on feature/capability gates, not only Chrome permission. Plugin images break when desktop-local paths leak into a browser. Chrome and Computer Use must reflect the current runtime instead of pretending all hosts are equal. Refresh and cancel must be explicit lifecycle behavior, not side effects.

## Appetite

One cycle, with a one-day contract spike first.

The spike is successful only if it produces:

- A runtime classifier for real Linux desktop, devcontainer with forwarded browser, headless server, and CI.
- A capability matrix that says available, degraded, or unavailable for each screen.
- A host-call matrix for Chat, Settings, Connections, Plugins Manage, Apps/Connectors, Chrome, Computer Use, mic/realtime, refresh persistence, and stop/cancel.
- A runnable harness that emits JSON evidence.

## No-Gos

- Do not pretend devcontainer web mode has full desktop control.
- Do not clone all Electron native behavior blindly.
- Do not keep chasing one minified crash at a time without a bridge contract.
- Do not fake Connections if there is no usable remote/control backend.

## Rabbit Holes

- Upstream minified bundle drift.
- Statsig and account feature-gate guessing.
- Chrome native messaging across forwarded or headless contexts.
- Real desktop Computer Use from inside a container.
- OAuth callback surfaces and connector install state.

## Runtime Classes

| Runtime | Classifier Signal | Browser Use | Computer Use | Chrome Plugin | UI Posture |
| --- | --- | --- | --- | --- | --- |
| Real Linux desktop | `DISPLAY` or `WAYLAND_DISPLAY`, user D-Bus, runtime dir | Local Chrome or CDP | Desktop control can be available | Native host can be installed | Show full controls with live status |
| Devcontainer forwarded browser | No physical desktop env, loopback serve, app-server available | Container Chromium or user-provided CDP | Browser-only unless explicitly overridden | Native host may be unavailable; CDP/browser bridge preferred | Show browser-capable controls, mark desktop control unavailable |
| Headless server | No display, no user D-Bus, no browser sidecar | Disabled unless CDP supplied | Unavailable | Unavailable unless remote bridge exists | Hide or disable host-control controls with reason |
| CI | Fixture mode or no account/app-server | Fixture only | Fixture only | Fixture only | Test contracts, not live capability |

## Capability Matrix

| Surface | Required Contract | Real Desktop | Devcontainer | Headless | Current Status |
| --- | --- | --- | --- | --- | --- |
| Chat | app-server thread RPC, project/workspace defaults, interrupt endpoint | Available | Available | Available if app-server auth works | Harness checks `thread/list` and interrupt shape |
| Settings | SPA deep-link refresh, typed settings fallbacks, desktop-shaped nav runtime | Available | Available | Mostly available | Harness checks route metadata and bootstrap markers |
| Connections | `/aip/connectors`, OAuth callback URL, remote-control clients backend | Available if backend exists | Degraded until remote/control backend exists | Unavailable unless remote backend exists | Harness requires `/wham/remote/control/clients?limit=100` to return a typed available/degraded/unavailable contract, never 404 or fake connected state |
| Plugins Manage | `plugin/list`, bundled marketplace sync, local asset proxy | Available | Available | Available if app-server/plugin state works | Harness checks Chrome, Computer Use, logo proxy |
| Apps/Connectors | `app/list`, `/aip/connectors/:id`, logo endpoint | Available | Available | Available with app-server | Harness checks list/detail/logo |
| Chrome | plugin registration plus browser-sidecar status | Available | Available through CDP/container browser when configured | Degraded/disabled | Harness checks plugin and `/__codex/browser/status` |
| Computer Use | explicit `computer_use.mode` and `physical_host_control` | Available when backend works | Browser-only by default | Unavailable | Harness checks honest mode, not tool success |
| Mic/Realtime | capability RPC plus browser media permission IPC | Available if account/browser allow | Available if browser allows media | Unavailable | Harness checks `realtimeVoice`/`voiceInput` and dictation bridge markers |
| Refresh | SPA fallback keeps initial route | Available | Available | Available | Harness checks key routes |
| Stop/Cancel | explicit interrupt bridge result | Available | Available | Available if app-server has active turn data | Harness checks typed interrupt response |

## Task 1: Create The Contract Harness

**Files:**
- Create: `scripts/web-mode-contract-harness.mjs`
- Modify: `tests/scripts_smoke.sh`

- [x] **Step 1: Add the harness script**

Create a Node script that accepts:

```bash
node scripts/web-mode-contract-harness.mjs --base-url http://127.0.0.1:3773/ --out dist-next/web-mode/contract-matrix.json --allow-failures
node scripts/web-mode-contract-harness.mjs --fixture --out /tmp/web-mode-contract.json
```

Expected behavior:

- Fetch `/__codex/health`.
- Extract the bridge token from `/__codex/web-mode-bootstrap.js`.
- Prove protected routes reject missing tokens.
- Exercise bridge RPCs and host HTTP endpoints for every screen in the matrix.
- Emit a JSON matrix with pass/fail/unknown checks.
- Exit nonzero on failures unless `--allow-failures` is set.

- [ ] **Step 2: Run the fixture harness**

Run:

```bash
node scripts/web-mode-contract-harness.mjs --fixture --out /tmp/web-mode-contract-matrix.json
```

Expected:

```text
"status": "pass"
```

- [ ] **Step 3: Add smoke coverage**

Add a smoke test that runs:

```bash
node --check "$REPO_DIR/scripts/web-mode-contract-harness.mjs"
node "$REPO_DIR/scripts/web-mode-contract-harness.mjs" --fixture --out "$TMP_DIR/web-mode-contract-matrix.json"
```

Expected matrix assertions:

- `"schema_version": 1`
- `"status": "pass"`
- `"connections"`
- `"remote-control-clients"`
- `"mic-realtime"`
- `"computer-use"`

## Task 2: Record The Spike Contract

**Files:**
- Create: `docs/superpowers/plans/2026-05-18-codex-desktop-serve-contract-spike.md`

- [x] **Step 1: Save the pitch and matrices**

This document is the durable contract artifact for the one-day spike.

- [ ] **Step 2: Keep implementation tied to the matrix**

Before patching another renderer symptom, add or update one harness check showing the missing contract.

## Task 3: Use The Harness Against A Live Serve

**Files:**
- No code changes required unless the harness exposes a missing endpoint.

- [ ] **Step 1: Start serve on an open port**

Run from the host or devcontainer where `codex-desktop serve` is installed:

```bash
codex-desktop serve --workspace "$HOME" --port 0
```

- [ ] **Step 2: Run the harness against the printed URL**

Run:

```bash
node scripts/web-mode-contract-harness.mjs --base-url http://127.0.0.1:<port>/ --out dist-next/web-mode/contract-matrix.json --allow-failures
```

Expected:

- The matrix should pass for runtime, chat, plugins, apps/connectors, Chrome status, Computer Use mode, mic capability, and refresh.
- Connections may report `unavailable` for `remote-control-clients` until a real remote/control backend exists. That is acceptable; 404 or fake connected state is not.

- [ ] **Step 3: Stop serve cleanly**

Run:

```bash
codex-desktop serve stop --workspace "$HOME"
```

## Circuit Breaker

If the live run cannot produce a concrete host-call list and screen matrix, stop implementation and reshape. If it can, the cycle bet is to make the failing checks pass one at a time.
