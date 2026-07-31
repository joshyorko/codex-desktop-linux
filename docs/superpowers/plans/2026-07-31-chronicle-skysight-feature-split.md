# Chronicle / Skysight Feature Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently selectable Chronicle / Skysight activity-memory feature that Record & Replay automatically requires.

**Architecture:** A new `chronicle-skysight` feature owns the shared backend, standalone MCP plugin, activity-memory bridge, and Chronicle tray integration. `record-and-replay` becomes a dependent feature that owns only recording/plugin/HUD/skill behavior and reuses the staged backend. The Rust binary exposes a restricted `skysight mcp` server and retains the full `event-stream mcp` server.

**Tech Stack:** Node.js feature descriptors/tests, Bash stage hooks, Rust with `rmcp`, Python/GTK Homebrew setup wizard, JSON feature manifests.

## Global Constraints

- Both features remain disabled by default.
- `record-and-replay` requires `chronicle-skysight`; the reverse dependency is forbidden.
- Enabling either feature must never start continuous capture.
- Standalone Chronicle / Skysight must not expose Record & Replay recording tools, composer UI, HUD, or marketplace entry.
- Existing Chronicle resources under `${CODEX_HOME:-$HOME/.codex}/memories/extensions/chronicle/resources` are never deleted by feature cleanup.
- Preserve unrelated untracked promotion artifacts in the desktop checkout.
- Homebrew setup must discover both switches from manifests and persist ordinary feature IDs only.

---

### Task 1: Feature Dependency Contract

**Files:**
- Create: `linux-features/chronicle-skysight/feature.json`
- Create: `linux-features/chronicle-skysight/README.md`
- Create: `linux-features/chronicle-skysight/test.js`
- Modify: `linux-features/record-and-replay/feature.json`
- Modify: `linux-features/record-and-replay/test.js`

**Interfaces:**
- Produces feature id `chronicle-skysight`.
- Produces manifest dependency `record-and-replay.requires = ["chronicle-skysight"]`.

- [ ] Write failing tests asserting the new manifest is disabled by default, is independently loadable, and Record & Replay fails direct feature loading without it.
- [ ] Run `rtk node --test linux-features/chronicle-skysight/test.js linux-features/record-and-replay/test.js` and confirm failure because the manifest/dependency is absent.
- [ ] Add the new manifest/README and the `requires` entry.
- [ ] Update temporary feature-root fixtures to copy both manifests when testing Record & Replay.
- [ ] Re-run the two feature tests and confirm the dependency tests pass.
- [ ] Commit the dependency contract.

### Task 2: Restricted Skysight MCP Mode

**Files:**
- Modify: `record-replay-linux/src/main.rs`
- Modify: `record-replay-linux/src/mcp.rs`
- Create: `record-replay-linux/tests/mcp_modes.rs`

**Interfaces:**
- Produces `mcp::serve_event_stream_mcp() -> anyhow::Result<()>`.
- Produces `mcp::serve_skysight_mcp() -> anyhow::Result<()>`.
- `skysight mcp` exposes only `skysight_start`, `skysight_status`, `skysight_pause`, `skysight_resume`, `skysight_stop`, `skysight_snapshot`, `skysight_update_exclusion`, and `skysight_list_exclusions` plus a read-only readiness/doctor tool if required by the existing contract.
- `event-stream mcp` retains the complete current router.

- [ ] Add a failing protocol-level test that initializes each stdio MCP mode, calls `tools/list`, and asserts recording tools are absent from `skysight mcp` but present in `event-stream mcp`.
- [ ] Run `rtk cargo test -p codex-record-replay-linux --test mcp_modes` and confirm the Skysight-mode assertion fails against the current shared router.
- [ ] Split the generated `rmcp` tool routers into a focused Skysight server and the existing full server without duplicating tool implementations.
- [ ] Route `Commands::Skysight { command: Mcp }` to the restricted server and the other MCP commands to the full server.
- [ ] Re-run the focused Rust test, then `rtk cargo test -p codex-record-replay-linux`.
- [ ] Commit the MCP mode split.

### Task 3: Chronicle-Owned Patch Surface

**Files:**
- Create: `linux-features/chronicle-skysight/patch.js`
- Modify: `linux-features/record-and-replay/patch.js`
- Modify: `linux-features/chronicle-skysight/test.js`
- Modify: `linux-features/record-and-replay/test.js`

**Interfaces:**
- Chronicle patch exports its descriptors plus shared binary-run helper generation.
- Record & Replay patch exports only plugin gate, recording bridge, HUD, transcript, bundle, and skill handlers.
- Both patches remain idempotent regardless of descriptor order.

- [ ] Add failing tests proving Chronicle-only patch descriptors add Chronicle tray/Skysight bridge handlers and no recording handlers.
- [ ] Add failing tests proving Record & Replay descriptors no longer own Chronicle tray handlers and compose safely after Chronicle descriptors.
- [ ] Run both Node feature suites and confirm failures identify the currently combined patch.
- [ ] Extract Chronicle helper/handler/tray patch code into the new feature while keeping the shared executable lookup/run helper composable.
- [ ] Narrow Record & Replay completeness/artifact detection to its own handlers.
- [ ] Re-run both feature suites and `rtk node --test scripts/patch-linux-window-ui.test.js`.
- [ ] Commit the patch ownership split.

### Task 4: Standalone Chronicle Plugin And Shared Backend Staging

**Files:**
- Create: `linux-features/chronicle-skysight/stage.sh`
- Create: `linux-features/chronicle-skysight/cleanup.sh`
- Create: `linux-features/chronicle-skysight/plugin-template/.codex-plugin/plugin.json`
- Create: `linux-features/chronicle-skysight/plugin-template/.mcp.json`
- Create: `linux-features/chronicle-skysight/plugin-template/skills/chronicle-skysight/SKILL.md`
- Create: `linux-features/chronicle-skysight/shared-backend.sh`
- Modify: `linux-features/record-and-replay/stage.sh`
- Modify: `linux-features/record-and-replay/cleanup.sh`
- Modify: both feature test files and READMEs.

**Interfaces:**
- Chronicle stage writes `resources/native/codex-record-replay-linux` and plugin `chronicle-skysight` configured with `args: ["skysight", "mcp"]`.
- Record & Replay stage consumes the executable shared native path and copies it into its own plugin.
- Chronicle cleanup owns the native backend and Chronicle plugin; Record & Replay cleanup owns only its plugin/marketplace entry.

- [ ] Add failing stage-layout tests for Chronicle-only and combined builds, including exactly one shared native backend and correct MCP arguments.
- [ ] Add failing cleanup tests proving Record & Replay cleanup preserves Chronicle payloads and Chronicle cleanup preserves user memory resources.
- [ ] Run both feature suites and confirm the new layout assertions fail.
- [ ] Move the backend build function into the shared feature helper and implement idempotent Chronicle staging.
- [ ] Change Record & Replay staging to require/reuse the staged backend.
- [ ] Split marketplace entries and cleanup ownership.
- [ ] Re-run both feature suites and `rtk bash tests/scripts_smoke.sh`.
- [ ] Commit the staged-runtime split.

### Task 5: Homebrew Setup UX And Profiles

**Files in `/home/kdlocpanda/second_brain/Areas/devcontainers/homebrew-tools`:**
- Modify: `Makefile`
- Modify: `scripts/test-codex-desktop-feature-wizard.py`
- Modify only if needed: `scripts/codex-desktop-feature-wizard.py`

**Interfaces:**
- Daily driver includes both feature IDs explicitly.
- Custom displays separate rows from the conversion manifests.
- Existing dependency closure automatically enables Chronicle / Skysight when Record & Replay is selected and disables Record & Replay when Chronicle / Skysight is deselected.

- [ ] Add failing wizard tests using the real dependency direction and titles.
- [ ] Run `rtk test make test-codex-desktop-setup` and confirm the expected profile/dependency failure.
- [ ] Add `chronicle-skysight` to Daily driver before `record-and-replay`; keep Minimal aligned because it currently contains Record & Replay.
- [ ] Change wizard code only if the existing dependency closure test reveals a real UI/state defect.
- [ ] Run `rtk test make test-codex-desktop-local`.
- [ ] Commit the Homebrew UX/profile change after the desktop conversion commit is final and update `codex-desktop-conversion.ref` to it.

### Task 6: Documentation, Full Verification, And Latest DMG Acceptance

**Files:**
- Modify: `docs/linux-chronicle-skysight.md`
- Modify: `docs/record-and-replay-linux.md`
- Modify: `linux-features/README.md`
- Modify in Homebrew repo: `codex-desktop-conversion.ref`

**Interfaces:**
- Documents standalone Chronicle use, dependency behavior, explicit capture lifecycle, and rebuild selection.

- [ ] Update docs and exact post-rebuild verification commands.
- [ ] Run `rtk git diff --check` in both repositories.
- [ ] Run all feature tests, core patch tests, script smoke, `cargo fmt --check`, `cargo check`, and full Record & Replay Rust tests.
- [ ] Run Homebrew Dagger tests and `make test-codex-desktop-local`.
- [ ] Build a latest-DMG candidate with both features enabled and require `accepted` or `accepted_with_warnings` with no enabled-feature drift blocker.
- [ ] Commit and push `patchraptor-main`, update/push Homebrew `main`, verify both remote SHAs, and provide the rebuild command.
