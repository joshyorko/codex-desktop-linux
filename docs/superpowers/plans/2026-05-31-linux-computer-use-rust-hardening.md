# Linux Computer Use Rust Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Fizzy card 459 into a Rust-first implementation path for Linux Computer Use reliability, observability, and future libei/EIS input.

**Architecture:** Keep Linux desktop behavior owned by the Rust `codex-computer-use-linux` crate. First make current backends honest and observable, then add snapshot-scoped accessibility refs, then isolate input backends enough that EIS can be spiked without tangling it into the current RemoteDesktop Notify* flow.

**Tech Stack:** Rust 2021, `rmcp`, `atspi`, `zbus`, `evdev`, Wayland/COSMIC protocols, shell packaging smoke tests, XDG portals, libei/EIS as a feature-gated spike.

---

## Research Correction

The earlier card was directionally right, but it did not look hard enough at the Rust. The actual control plane is not the JavaScript patcher. It is the Rust workspace:

- `computer-use-linux/src/server.rs` is the MCP tool surface and action router.
- `computer-use-linux/src/remote_desktop.rs` owns XDG RemoteDesktop sessions and `Notify*` input.
- `computer-use-linux/src/abs_pointer.rs` owns the privileged absolute `/dev/uinput` pointer.
- `computer-use-linux/src/atspi_tree.rs` owns accessibility snapshots and AT-SPI action/value writes.
- `computer-use-linux/src/windowing/` owns compositor listing, focus, and target resolution.
- `computer-use-linux/src/bin/codex-chrome-extension-host.rs` owns the Linux native messaging bridge.
- `updater/src/builder.rs` and `updater/src/wrapper_apply.rs` carry this Rust and plugin payload into local rebuilds.

The important external correction is EIS. XDG RemoteDesktop `ConnectToEIS` returns an fd for a libei sender context, and the portal spec says that after the EIS connection is established, input must go through EIS and the old `NotifyPointer*` / `NotifyKeyboard*` methods return errors. So EIS is not a small method added to `remote_desktop.rs`; it is a new input backend behind a clear backend boundary.

## Sources Checked

- XDG RemoteDesktop: `CreateSession`, `SelectDevices`, `Start`, `NotifyPointerMotionAbsolute`, and `ConnectToEIS`.
- XDG ScreenCast: stream `mapping_id` and `pipewire-serial`, which matter for pairing PipeWire streams with libei regions.
- XDG InputCapture: useful for passive input capture, not the remote-control sender path.
- libei docs: EI client and EIS compositor model, C library first, protocol/code-generation available.
- Playwright MCP snapshots: refs are scoped to a snapshot and invalidated after page changes.
- KWin scripting docs: KWin scripts can be packaged and enabled, instead of loading temp scripts on every request.
- Hyprland IPC docs: `.socket2.sock` provides live events including `activewindowv2`.
- Chrome native messaging docs: manifest rules, absolute Linux host paths, stdio framing, caller origin argument.

## Plan Boundaries

- Do not turn `/dev/uinput` into an invisible "best" path. It is accurate, but privileged.
- Do not conflate RemoteDesktop control with InputCapture capture. Use RemoteDesktop for sender input.
- Do not add libei to the default build until it can be built and tested in the devcontainer or CI image.
- Do not rewrite all window backends before adding observability. First expose attempts and capabilities.
- Do not post Fizzy updates from implementation agents unless the human explicitly asks for board mutation.

## File Structure

- Modify `computer-use-linux/src/diagnostics.rs`: add backend privilege and attempt metadata to the doctor report.
- Modify `computer-use-linux/src/windowing/registry.rs`: expose backend attempts on success and failure.
- Modify `computer-use-linux/src/windowing/target.rs`: consume backend-attempt data only after registry can provide it.
- Modify `computer-use-linux/src/server.rs`: add snapshot IDs, stale-cache checks, and per-action backend attempts.
- Create `computer-use-linux/src/accessibility_cache.rs`: own cached AT-SPI snapshot identity and node resolution.
- Create `computer-use-linux/src/input/mod.rs`: common input backend model and attempt reporting.
- Move or wrap `computer-use-linux/src/abs_pointer.rs`: keep implementation, expose through `input`.
- Move or wrap `computer-use-linux/src/remote_desktop.rs`: keep existing Notify* backend, expose through `input::portal_notify`.
- Create `computer-use-linux/src/input/eis.rs`: feature-gated EIS proof, starting with fd acquisition and explicit disabled status.
- Create `computer-use-linux/src/trajectory.rs`: opt-in local JSONL recorder for Computer Use evidence.
- Modify `computer-use-linux/src/bin/codex-chrome-extension-host.rs`: add a same-session nonce handshake for Browser Use clients.
- Modify `computer-use-linux/Cargo.toml`: add feature gates and any build-only deps only when the EIS spike requires them.
- Modify `tests/scripts_smoke.sh`: add static guards for new fields and no default EIS dependency.
- Modify `README.md` and `CHANGELOG.md`: document the honest backend posture and EIS as experimental.

All commands below are intended to run inside the repo devcontainer. The Bluefin host currently lacks `cargo`, and the repo already defines `.devcontainer/Dockerfile` with Rust, Node, `rustfmt`, and `clippy`.

## Task 1: Report Current Backend Attempts And Privilege

**Files:**
- Modify: `computer-use-linux/src/diagnostics.rs`
- Modify: `computer-use-linux/src/server.rs`
- Modify: `computer-use-linux/src/windowing/registry.rs`
- Test: `computer-use-linux/src/diagnostics.rs`
- Test: `computer-use-linux/src/windowing/registry.rs`
- Test: `computer-use-linux/src/server.rs`

- [ ] **Step 1: Add input backend report structs**

Add these public report types in `computer-use-linux/src/diagnostics.rs` near `InputReport`:

```rust
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct InputBackendReport {
    pub id: String,
    pub available: bool,
    pub privileged: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct WindowBackendAttempt {
    pub id: String,
    pub ok: bool,
    pub can_list_windows: bool,
    pub can_focus_apps: bool,
    pub can_focus_windows: bool,
    pub detail: String,
}
```

Extend `InputReport` without removing existing fields:

```rust
pub struct InputReport {
    pub ydotool: Check,
    pub ydotoold: Check,
    pub ydotool_socket: Check,
    pub uinput: Check,
    pub backends: Vec<InputBackendReport>,
}
```

In `input_report()`, populate:

```rust
let ydotool = command_path_check("ydotool");
let ydotoold = process_check("ydotoold");
let ydotool_socket = ydotool_socket_check();
let uinput = read_write_path_check(Path::new("/dev/uinput"));
let backends = vec![
    InputBackendReport {
        id: "abs_pointer".to_string(),
        available: uinput.ok,
        privileged: true,
        detail: if uinput.ok {
            "read/write /dev/uinput is available; this backend can synthesize global input without a portal prompt".to_string()
        } else {
            uinput.detail.clone()
        },
    },
    InputBackendReport {
        id: "remote_desktop_notify".to_string(),
        available: portal_report().remote_desktop.ok,
        privileged: false,
        detail: "XDG RemoteDesktop Notify* input, subject to portal permission prompts and stream coordinates".to_string(),
    },
    InputBackendReport {
        id: "ydotool".to_string(),
        available: ydotool.ok && ydotoold.ok && ydotool_socket.ok,
        privileged: true,
        detail: "ydotool daemon socket input; privilege depends on daemon/socket ownership".to_string(),
    },
];
```

- [ ] **Step 2: Add action backend attempt output**

In `computer-use-linux/src/server.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub(crate) struct ActionBackendAttempt {
    backend: String,
    ok: bool,
    detail: String,
}
```

Extend `ActionOutput`:

```rust
backend_attempts: Vec<ActionBackendAttempt>,
```

Update constructors `action_result`, `successful_action_with_focus`, direct success branches, and direct error branches so every action returns the backends tried in order. Existing callers should still get `ok`, `implemented`, `action`, and `message`.

- [ ] **Step 3: Preserve old behavior while adding evidence**

For `click` and `drag`, report:

```text
abs_pointer -> remote_desktop_notify -> ydotool
```

For `scroll`, report:

```text
remote_desktop_notify -> ydotool
```

For `type_text`, report:

```text
kde_clipboard_portal -> remote_desktop_notify_keyboard -> ydotool
```

For `press_key`, report:

```text
ydotool
```

- [ ] **Step 4: Add tests**

Add tests in `server.rs` that assert an `ActionOutput` schema includes `backend_attempts`, and helper unit tests that construct success and failure outputs with non-empty attempts.

Add tests in `diagnostics.rs`:

```rust
#[test]
fn input_report_marks_abs_pointer_privileged() {
    let report = input_report();
    let abs = report.backends.iter().find(|backend| backend.id == "abs_pointer").unwrap();
    assert!(abs.privileged);
}
```

- [ ] **Step 5: Verify**

Run:

```bash
cargo test -p codex-computer-use-linux diagnostics::tests::input_report_marks_abs_pointer_privileged
cargo test -p codex-computer-use-linux server::tests
```

Expected: both commands pass.

## Task 2: Snapshot-Scoped Accessibility Refs

**Files:**
- Create: `computer-use-linux/src/accessibility_cache.rs`
- Modify: `computer-use-linux/src/main.rs`
- Modify: `computer-use-linux/src/server.rs`
- Modify: `computer-use-linux/src/atspi_tree.rs`
- Test: `computer-use-linux/src/server.rs`

- [ ] **Step 1: Create the cache type**

Create `computer-use-linux/src/accessibility_cache.rs`:

```rust
use crate::atspi_tree::AccessibilityNode;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_SNAPSHOT: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
pub struct AccessibilitySnapshot {
    pub id: String,
    pub nodes: Vec<AccessibilityNode>,
}

#[derive(Debug, Default)]
pub struct AccessibilityCache {
    current: Option<AccessibilitySnapshot>,
}

impl AccessibilityCache {
    pub fn replace(&mut self, nodes: Vec<AccessibilityNode>) -> AccessibilitySnapshot {
        let id = format!("a11y-{}", NEXT_SNAPSHOT.fetch_add(1, Ordering::Relaxed));
        let snapshot = AccessibilitySnapshot { id, nodes };
        self.current = Some(snapshot.clone());
        snapshot
    }

    pub fn clear(&mut self) {
        self.current = None;
    }

    pub fn resolve(&self, snapshot_id: Option<&str>, index: u32) -> Result<AccessibilityNode, String> {
        let Some(snapshot) = &self.current else {
            return Err("No accessibility snapshot is cached. Call get_app_state first.".to_string());
        };
        if let Some(requested) = snapshot_id {
            if requested != snapshot.id {
                return Err(format!(
                    "Accessibility snapshot {requested} is stale. Current snapshot is {}. Call get_app_state again and use the new refs.",
                    snapshot.id
                ));
            }
        }
        snapshot
            .nodes
            .iter()
            .find(|node| node.index == index)
            .cloned()
            .ok_or_else(|| format!("No cached accessibility node for element_index {index}. Call get_app_state first."))
    }
}
```

- [ ] **Step 2: Wire it into the MCP server**

In `computer-use-linux/src/main.rs`, add:

```rust
mod accessibility_cache;
```

In `server.rs`, replace:

```rust
last_nodes: Arc<Mutex<Vec<AccessibilityNode>>>,
```

with:

```rust
accessibility_cache: Arc<Mutex<crate::accessibility_cache::AccessibilityCache>>,
```

Add fields to `GetAppStateOutput`:

```rust
accessibility_snapshot_id: Option<String>,
```

Add optional params to `ClickParams`, `ActionParams`, `SetValueParams`, and `ScrollParams`:

```rust
#[serde(default)]
accessibility_snapshot_id: Option<String>,
```

- [ ] **Step 3: Keep old `element_index` compatibility**

Existing `element_index` calls still work when no `accessibility_snapshot_id` is passed and there is only one live cached snapshot. If a user passes a stale `accessibility_snapshot_id`, reject with the stale message above.

- [ ] **Step 4: Add Playwright-style element refs**

Add a serialized ref to `AccessibilityNode`:

```rust
pub ref_id: String,
```

Set it in `read_node()`:

```rust
ref_id: format!("e{index}"),
```

Add `element_ref: Option<String>` to action params. Parse `e7` into index `7`, and reject malformed refs with:

```text
element_ref must look like e7 from the latest get_app_state accessibility snapshot.
```

- [ ] **Step 5: Add stale-cache tests**

Add tests proving:

- an old snapshot id is rejected after a later `get_app_state`;
- `element_ref="e7"` resolves to index 7;
- malformed refs fail;
- old `element_index=7` still resolves without a snapshot id.

- [ ] **Step 6: Verify**

Run:

```bash
cargo test -p codex-computer-use-linux server::tests::stale_snapshot_id_is_rejected
cargo test -p codex-computer-use-linux server::tests::element_ref_resolves_to_cached_object_ref
```

Expected: both pass.

## Task 3: Extract Input Backend Boundary Before EIS

**Files:**
- Create: `computer-use-linux/src/input/mod.rs`
- Modify: `computer-use-linux/src/main.rs`
- Modify: `computer-use-linux/src/server.rs`
- Modify: `computer-use-linux/src/abs_pointer.rs`
- Modify: `computer-use-linux/src/remote_desktop.rs`
- Test: `computer-use-linux/src/server.rs`

- [ ] **Step 1: Add common input model**

Create `computer-use-linux/src/input/mod.rs`:

```rust
pub mod abs_pointer;
pub mod portal_notify;

#[derive(Debug, Clone)]
pub struct InputAttempt {
    pub backend: &'static str,
    pub ok: bool,
    pub detail: String,
}

impl InputAttempt {
    pub fn ok(backend: &'static str, detail: impl Into<String>) -> Self {
        Self { backend, ok: true, detail: detail.into() }
    }

    pub fn fail(backend: &'static str, detail: impl Into<String>) -> Self {
        Self { backend, ok: false, detail: detail.into() }
    }
}

pub const ABS_POINTER_BACKEND: &str = "abs_pointer";
pub const PORTAL_NOTIFY_BACKEND: &str = "remote_desktop_notify";
pub const YDOTOOL_BACKEND: &str = "ydotool";
```

- [ ] **Step 2: Re-export existing implementations**

Do not move large code in the first pass. Create wrapper modules that re-export existing functions:

```rust
// computer-use-linux/src/input/abs_pointer.rs
pub use crate::abs_pointer::*;
```

```rust
// computer-use-linux/src/input/portal_notify.rs
pub use crate::remote_desktop::*;
```

- [ ] **Step 3: Convert `server.rs` helpers to return attempts**

Change `try_abs_click()` to:

```rust
async fn try_abs_click(...) -> InputAttempt
```

Return failed attempts for disabled env, screenshot failure, create failure, and emit failure. Keep fallback behavior identical.

- [ ] **Step 4: Verify no behavior regression**

Run:

```bash
cargo test -p codex-computer-use-linux server::tests::pointer_actions_keep_pixel_coordinates_for_ydotool_absolute_moves
cargo test -p codex-computer-use-linux
```

Expected: existing tests pass.

## Task 4: EIS Probe Behind An Explicit Feature

**Files:**
- Create: `computer-use-linux/src/input/eis.rs`
- Modify: `computer-use-linux/src/input/mod.rs`
- Modify: `computer-use-linux/src/remote_desktop.rs`
- Modify: `computer-use-linux/Cargo.toml`
- Modify: `.devcontainer/Dockerfile` only if the feature needs distro libraries for CI
- Test: `computer-use-linux/src/remote_desktop.rs`
- Test: `computer-use-linux/src/input/eis.rs`

- [ ] **Step 1: Add feature flag**

In `computer-use-linux/Cargo.toml`:

```toml
[features]
default = []
eis = []
```

Do not add a default libei dependency in this task.

- [ ] **Step 2: Add fd-only RemoteDesktop method**

In `remote_desktop.rs`, add a method on the existing started session:

```rust
#[cfg(feature = "eis")]
pub async fn connect_to_eis_fd(session: &OwnedObjectPath) -> Result<std::os::fd::OwnedFd> {
    // Use zbus to call org.freedesktop.portal.RemoteDesktop.ConnectToEIS
    // with the existing session handle and an empty vardict.
}
```

This task is successful when a unit test can compile the zbus signature and the live code path returns a clear runtime error if the portal interface is missing.

- [ ] **Step 3: Add disabled-by-default EIS backend status**

In `input/eis.rs`, expose:

```rust
pub const EIS_BACKEND: &str = "eis";

pub fn availability_detail() -> String {
    "EIS is experimental and only compiled with --features eis; RemoteDesktop ConnectToEIS must replace Notify* input for the session once connected.".to_string()
}
```

- [ ] **Step 4: Add compile checks**

Run:

```bash
cargo check -p codex-computer-use-linux
cargo check -p codex-computer-use-linux --features eis
```

Expected: default check does not require libei. The feature check compiles at least the portal fd acquisition layer.

## Task 5: libei Sender Spike

**Files:**
- Modify: `computer-use-linux/src/input/eis.rs`
- Modify: `computer-use-linux/Cargo.toml`
- Create: `computer-use-linux/build.rs` if link detection is needed
- Test: `computer-use-linux/src/input/eis.rs`

- [ ] **Step 1: Choose binding path after a one-command proof**

Try these inside a disposable devcontainer branch:

```bash
pkg-config --modversion libei
pkg-config --modversion liboeffis-1.0 || pkg-config --modversion liboeffis
```

Expected:

- If `libei` is available, use minimal C FFI behind `--features eis`.
- If it is not available in the devcontainer base, do not mutate the Bluefin host. Either extend the devcontainer image or keep Task 4 as the landed spike and write down the missing distro package.

- [ ] **Step 2: Implement only a minimal sender**

The first libei spike only needs:

- create sender context;
- attach the `ConnectToEIS` fd;
- dispatch until connect, seat, and device events are seen;
- expose device region metadata, including mapping ids if available;
- send one absolute pointer move in a manual-only dev command.

Do not route MCP `click` through EIS in this task.

- [ ] **Step 3: Add safety comments at the FFI boundary**

Every `unsafe` call must document:

- pointer ownership;
- fd ownership;
- lifetime of strings passed to libei;
- when libei objects must be unrefed.

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p codex-computer-use-linux --features eis
cargo clippy -p codex-computer-use-linux --features eis -- -D warnings
```

Expected: tests and clippy pass in the devcontainer image that has libei development headers.

## Task 6: Window Backend Attempt Layer

**Files:**
- Modify: `computer-use-linux/src/windowing/registry.rs`
- Modify: `computer-use-linux/src/windowing/target.rs`
- Modify: `computer-use-linux/src/server.rs`
- Test: `computer-use-linux/src/windowing/registry.rs`
- Test: `computer-use-linux/src/windowing/mod.rs`

- [ ] **Step 1: Add list result with attempts**

In `registry.rs`, add:

```rust
#[derive(Debug, Clone)]
pub struct WindowListResult {
    pub windows: Vec<WindowInfo>,
    pub selected_backend: String,
    pub attempts: Vec<BackendProbe>,
}
```

Add `list_windows_with_attempts()` and have old `list_windows()` call it and return only `windows`.

- [ ] **Step 2: Make `list_windows` tool return attempts**

Extend `ListWindowsOutput`:

```rust
backend_attempts: Vec<WindowBackendAttempt>,
```

The tool should show failed earlier backends even when a later backend succeeds.

- [ ] **Step 3: Keep backend order stable**

Keep the current order:

```text
gnome_shell_extension
gnome_introspect
cosmic
kwin
hyprland
i3
```

Add a regression test that the attempt output preserves this order.

- [ ] **Step 4: Verify**

Run:

```bash
cargo test -p codex-computer-use-linux windowing::tests::registry_keeps_stable_backend_order
cargo test -p codex-computer-use-linux windowing::registry::tests
```

Expected: tests pass and `list_windows` still returns `windows` for current clients.

## Task 7: KWin And Hyprland Follow-Up Spikes

**Files:**
- Modify: `computer-use-linux/src/windowing/backends/kwin.rs`
- Modify: `computer-use-linux/src/windowing/backends/hyprland.rs`
- Test: `computer-use-linux/src/windowing/mod.rs`

- [ ] **Step 1: KWin package spike**

Before replacing the current temporary-script path, add a second backend path named:

```rust
const KWIN_PACKAGED_BRIDGE_BACKEND: &str = "kwin_packaged_bridge";
```

It may remain unused until a setup command installs the package. The point is to prove the shape before deleting temp script behavior.

- [ ] **Step 2: Hyprland event cache spike**

Add a parser for `.socket2.sock` event lines:

```rust
fn parse_hyprland_event(line: &str) -> Option<HyprlandEvent>
```

Support at least `activewindowv2>>ADDRESS` and add tests. Do not open a long-lived socket in the first parser-only commit.

- [ ] **Step 3: Verify**

Run:

```bash
cargo test -p codex-computer-use-linux windowing::tests::parses_hyprland_activewindowv2_event
cargo test -p codex-computer-use-linux windowing::tests::registry_keeps_stable_backend_order
```

Expected: parser tests pass, existing backend behavior unchanged.

## Task 8: Opt-In Trajectory Capture

**Files:**
- Create: `computer-use-linux/src/trajectory.rs`
- Modify: `computer-use-linux/src/main.rs`
- Modify: `computer-use-linux/src/server.rs`
- Modify: `README.md`
- Test: `computer-use-linux/src/trajectory.rs`

- [ ] **Step 1: Add local-only recorder**

Create `trajectory.rs` with:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct TrajectoryEvent<'a> {
    pub ts: String,
    pub tool: &'a str,
    pub action: &'a str,
    pub ok: bool,
    pub backend_attempts: &'a [crate::server::ActionBackendAttempt],
    pub window_backend: Option<&'a str>,
    pub accessibility_snapshot_id: Option<&'a str>,
}
```

Write JSONL only when:

```text
CODEX_COMPUTER_USE_TRAJECTORY=1
```

Path:

```text
${XDG_STATE_HOME:-~/.local/state}/codex-computer-use-linux/trajectory.jsonl
```

Do not record screenshots by default. Add a separate future flag if screenshot evidence is needed.

- [ ] **Step 2: Wire action results**

After each action constructs `ActionOutput`, call the recorder with tool/action/ok/backend attempts and snapshot id.

- [ ] **Step 3: Verify**

Run:

```bash
cargo test -p codex-computer-use-linux trajectory::tests
```

Expected: JSONL writer creates parent dirs and writes one valid JSON object per line.

## Task 9: Chrome Native Host Nonce Handshake

**Files:**
- Modify: `computer-use-linux/src/bin/codex-chrome-extension-host.rs`
- Modify: `scripts/lib/bundled-plugins.sh` if the browser client needs the nonce path/env
- Test: `computer-use-linux/src/bin/codex-chrome-extension-host.rs`

- [ ] **Step 1: Add handshake requirement**

The native host already checks same UID and socket dir ownership. Add a logical session nonce so any same-UID process cannot attach as a browser client without knowing the current host token.

Use:

```rust
struct ClientHandshake {
    nonce: String,
}
```

The first client frame must be:

```json
{"jsonrpc":"2.0","method":"hello","params":{"nonce":"..."}}
```

Reject and close if the nonce does not match.

- [ ] **Step 2: Source the nonce**

Generate the nonce in the native host process at startup, expose it to the browser client through a root-owned-by-session, user-only readable temp file under the already `0700` socket dir:

```text
${CODEX_BROWSER_USE_SOCKET_DIR}/extension-<pid>-<nonce>.json
```

Remove it on exit beside socket cleanup.

- [ ] **Step 3: Verify**

Add tests for:

- wrong nonce rejects;
- missing hello rejects;
- correct hello registers client;
- pending requests are still cleared when a new valid client connects.

Run:

```bash
cargo test -p codex-computer-use-linux --bin codex-chrome-extension-host
```

Expected: tests pass.

## Task 10: Staged Plugin Contract After Rust Changes

**Files:**
- Modify: `scripts/lib/bundled-plugins.sh`
- Modify: `updater/src/builder.rs`
- Modify: `tests/scripts_smoke.sh`

- [ ] **Step 1: Write a staged contract file**

During `install_bundled_plugin_resources`, emit:

```text
codex-app/resources/plugins/openai-bundled/.codex-linux/staged-plugins.json
```

Shape:

```json
{
  "version": 1,
  "plugins": [
    {"name":"browser","staged":true},
    {"name":"chrome","staged":true},
    {"name":"computer-use","staged":true,"rust_backend":"codex-computer-use-linux"}
  ]
}
```

- [ ] **Step 2: Make updater tests preserve it**

Update the `updater/src/builder.rs` fixture helpers so `plugins/openai-bundled/plugins/computer-use` and the staged contract are both copied into update-builder tests.

- [ ] **Step 3: Verify**

Run:

```bash
cargo test -p codex-update-manager builder::tests
bash tests/scripts_smoke.sh
```

Expected: update-builder tests and smoke tests pass.

## Execution Order

1. Task 1: backend attempts and privilege labels.
2. Task 2: snapshot refs and stale-cache checks.
3. Task 3: input backend boundary.
4. Task 4: EIS fd-only probe.
5. Task 6: window backend attempts.
6. Task 8: trajectory capture.
7. Task 9: native host nonce.
8. Task 10: staged plugin contract.
9. Task 5 and Task 7 remain spike tracks unless the devcontainer can prove their dependencies cleanly.

## Validation Gate

Before claiming this work complete, run inside the devcontainer:

```bash
cargo fmt --check
cargo test -p codex-computer-use-linux
cargo test -p codex-update-manager
node --test scripts/patch-linux-window-ui.test.js
bash tests/scripts_smoke.sh
```

If full smoke is too slow during development, each task lists a narrower command. The final gate is still the full list.

## Fizzy Card Update Draft

Do not post this automatically. If Josh asks to update card 459, use this exact HTML body as a Fizzy comment:

```html
<p>I re-ran the research with the Rust code as the center of gravity. The key correction is that EIS is not a small add-on to the existing XDG RemoteDesktop Notify* code. The portal spec says once <code>ConnectToEIS</code> is established, input must go through EIS and Notify* calls return errors, so we need a real Rust input-backend boundary first.</p>

<p>I saved a Rust-first plan at <code>docs/superpowers/plans/2026-05-31-linux-computer-use-rust-hardening.md</code>. The recommended first moves are: backend attempts plus privileged input labels, snapshot-scoped accessibility refs, an input backend extraction, then an fd-only EIS probe behind <code>--features eis</code>. The libei sender work stays a spike until the devcontainer proves the dependency path cleanly.</p>
```
