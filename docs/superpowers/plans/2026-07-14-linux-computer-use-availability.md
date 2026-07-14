# Linux Computer Use Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Linux Computer Use as an upstream-shaped Linux port that remains available globally, preserves the current DMG plugin identity and skill contract, and rejects future candidates when either surface drifts.

**Architecture:** Stage the current DMG's `computer-use` plugin as the base, remove only the macOS app payload, and overlay the Linux MCP backend and platform wording while preserving upstream version, identity, skill, scripts, icon, and portable metadata. Patch both the Computer Use settings bundle and the global Plugins page, with required acceptance descriptors for each UI contract.

**Tech Stack:** Node.js ASAR patch descriptors, `node:test`, upstream-DMG acceptance reports, Homebrew local conversion.

## Global Constraints

- Support only upstream DMG `26.707.72221` shape; retain no legacy bundle routes.
- Preserve upstream rollout gates unrelated to Linux platform support.
- Keep Computer Use UI disabled unless `codex-linux-computer-use-ui-enabled` is enabled.
- Do not modify generated `codex-app/` or the installed Homebrew bundle.
- Keep plugin ID `computer-use`; `Any App` is an upstream UI label, not a replacement ID.
- Preserve the upstream confirmation policy and prefer-purpose-built-interface guidance.

---

### Task 1: Current settings availability contract

**Files:**
- Modify: `scripts/patch-linux-window-ui.test.js`
- Modify: `scripts/patches/impl/computer-use.js`

**Interfaces:**
- Consumes: `applyLinuxComputerUseRendererAvailabilityPatch(source: string): string`
- Produces: an atomic current-settings patch that forces `{available: true, isFetching: false, isLoading: false}` on Linux and injects the installed `computer-use` plugin card.

- [x] **Step 1: Write the failing current-DMG test**

Use the exact declarator shape from `computer-use-settings-B9iEdDjp.js`:

```js
const source =
  "function Settings(){let availability=useAvailability(args),{platform}=usePlatform(),isLocal=host.kind===`local`,gate=useGate(`188145323`);" +
  "let props={computerUseAvailability:availability,platform};" +
  "let pluginsQuery=usePlugins(host,[]),marketplacePath=useMarketplacePath(host),flag=useFlag(flagArg),computerUsePlugin;" +
  "computerUsePlugin=selectPlugin(pluginsQuery.availablePlugins,pluginName,marketplacePath);" +
  "if(availability.available&&computerUsePlugin!=null)render(props)}";
```

Assert the result contains both the Linux availability override and the `openai-bundled` synthetic plugin.

- [x] **Step 2: Verify red**

Run:

```bash
rtk node --test --test-name-pattern='current DMG Computer Use settings' scripts/patch-linux-window-ui.test.js
```

Expected: failure because the consumer matcher requires the platform hook to end the declaration.

- [x] **Step 3: Implement the minimal current matcher**

Expand the settings consumer matcher to include trailing declarators through its semicolon, preserve the full declaration, and append:

```js
platformVar === `linux` &&
  (availabilityVar = { ...availabilityVar, available: true, isFetching: false, isLoading: false });
```

If the current settings bundle exposes both the availability consumer and plugin selector, require both transformations; otherwise warn and return the original source atomically.

- [x] **Step 4: Verify green**

Run the focused test command again and expect one passing test with zero failures.

### Task 2: Remove obsolete routes and enforce acceptance

**Files:**
- Modify: `scripts/patches/core/all-linux/webview/computer-use-ui/patch.js`
- Modify: `scripts/patches/impl/computer-use.js`
- Modify: `scripts/patch-linux-window-ui.test.js`

**Interfaces:**
- Consumes: `context.enableComputerUseUi`
- Produces: one current `linux-computer-use-ui-availability` descriptor with `ciPolicy: "required-upstream"`.

- [x] **Step 1: Add descriptor-policy assertions**

Assert the current descriptor list contains only `linux-computer-use-ui-availability`, targets `computer-use-settings-B9iEdDjp.js`, and is required when the UI opt-in is enabled.

- [x] **Step 2: Verify red**

Run:

```bash
rtk node --test --test-name-pattern='Computer Use availability descriptor' scripts/patch-linux-window-ui.test.js
```

Expected: failure while the obsolete shared/install-flow descriptors remain and the current descriptor is `opt-in` policy.

- [x] **Step 3: Remove obsolete latest-DMG code**

Delete `linux-computer-use-shared-availability`, `linux-computer-use-install-flow`, `sharedComputerUseAvailabilityState`, `applyLinuxComputerUseSharedAvailabilityPatch`, and `applyLinuxComputerUseInstallFlowPatch`. Set the remaining descriptor policy to `required-upstream`; its enable predicate continues to scope it to the explicit UI opt-in.

- [x] **Step 4: Verify green**

Run:

```bash
rtk node --test --test-name-pattern='Computer Use' scripts/patch-linux-window-ui.test.js
```

Expected: all selected tests pass and the two obsolete warning IDs are absent.

### Task 3: Exact-DMG and publish verification

**Files:**
- Verify: `/tmp/ChatGPT-26.707.72221-40e34814.dmg`
- Verify: `/var/home/kdlocpanda/.config/homebrew-tools/codex-desktop-features.json`

**Interfaces:**
- Consumes: exact DMG SHA-256 `40e34814e74e30943c209ebd4da94cd4de3581a52c5bffbe2bcf2e488d6361c6`
- Produces: accepted candidate with the current Computer Use descriptor applied and no Computer Use warnings.

- [x] **Step 1: Run focused and core checks**

```bash
rtk node --test scripts/patch-linux-window-ui.test.js
CI_SKIP_PULL=1 rtk proxy ./scripts/ci-local.sh core
rtk git diff --check
```

- [x] **Step 2: Run exact Homebrew-profile acceptance**

Run `install.sh --inspect` with `CODEX_LINUX_FEATURES_CONFIG=/var/home/kdlocpanda/.config/homebrew-tools/codex-desktop-features.json`, then enforce `scripts/validate-upstream-dmg.js` against the generated patch report.

Expected: `accepted_with_warnings`, zero blockers, `linux-computer-use-ui-availability` applied, and neither obsolete Computer Use warning present.

- [x] **Step 3: Commit and push**

```bash
rtk git add scripts/patches/core/all-linux/webview/computer-use-ui/patch.js scripts/patches/impl/computer-use.js scripts/patch-linux-window-ui.test.js docs/superpowers/plans/2026-07-14-linux-computer-use-availability.md
rtk git commit -m "Fix current Linux Computer Use availability"
rtk git push origin patchraptor-main
```

- [x] **Step 4: Verify remote**

```bash
rtk git rev-list --left-right --count HEAD...origin/patchraptor-main
```

Expected: `0 0`.

### Task 4: Upstream-shaped Linux plugin staging

**Files:**
- Modify: `tests/scripts_smoke.sh`
- Modify: `scripts/lib/bundled-plugins.sh`

**Interfaces:**
- Consumes: `CODEX_UPSTREAM_APP_DIR/Contents/Resources/plugins/openai-bundled/plugins/computer-use`
- Produces: a staged `computer-use` plugin with the upstream version, skill, scripts, icon, and OpenAI identity plus Linux MCP wiring and wording.

- [x] **Step 1: Write the failing staging regression**

Create a fake upstream plugin containing version `1.0.1000387`, `skills/computer-use/SKILL.md`, `scripts/computer-use-client.mjs`, the upstream icon, and a fake `Codex Computer Use.app`. Stage with prebuilt Linux binaries and assert that the portable upstream files and version survive, the macOS app is removed, and `.mcp.json` points to `./bin/codex-computer-use-linux`.

- [x] **Step 2: Verify red**

Run the isolated smoke function and expect failure because current staging replaces the upstream tree with `0.1.2-linux-alpha2` and has no skill or scripts.

- [x] **Step 3: Implement the minimal upstream-base overlay**

Require and copy the current upstream base, remove `Codex Computer Use.app` and metadata junk, then overlay Linux binaries, `.mcp.json`, and Linux-specific manifest/skill wording without changing the upstream version or plugin ID. Fail closed on missing or malformed upstream plugin inputs when Computer Use UI is enabled.

- [x] **Step 4: Verify green**

Run the isolated smoke function again and expect all upstream-shell assertions to pass.

### Task 5: Global Plugins-page availability

**Files:**
- Modify: `scripts/patch-linux-window-ui.test.js`
- Modify: `scripts/patches/impl/computer-use.js`
- Modify: `scripts/patches/core/all-linux/webview/computer-use-ui/patch.js`

**Interfaces:**
- Consumes: the current `plugins-page-*.js` installed/available set expression.
- Produces: `applyLinuxComputerUsePluginsPageAvailabilityPatch(source)` and a required `linux-computer-use-plugins-page-availability` descriptor.

- [x] **Step 1: Write the failing current-bundle regression**

Use the exact current expression:

```js
const source = "Ji=new Set([...Pt,...Qt??[],...nn??[]].map(e=>e.plugin.id)),Xi=new Set(Vr.filter(e=>!Ji.has(e.plugin.id)).map(e=>e.plugin.id))";
```

Assert the patched unavailable set excludes only plugin ID `computer-use`, is idempotent, and the descriptor targets `plugins-page-*.js` with `ciPolicy: "required-upstream"`.

- [x] **Step 2: Verify red**

Run the focused Node test and expect failure because no Plugins-page patch or descriptor exists.

- [x] **Step 3: Implement the minimal patch**

Transform the unavailable filter to:

```js
Vr.filter(e => !Ji.has(e.plugin.id) && e.plugin.id !== `computer-use`)
```

Keep the patch exact-current-DMG, idempotent, and fail-soft; make its descriptor required only when Computer Use UI is enabled.

- [x] **Step 4: Verify green**

Run all Computer Use Node tests and expect zero failures.

### Task 6: Fresh acceptance and publication

**Files:**
- Verify: `reports/upstream-dmg/downloads/Codex.dmg`
- Verify: `/var/home/kdlocpanda/.config/homebrew-tools/codex-desktop-features.json`

**Interfaces:**
- Consumes: exact DMG SHA-256 `40e34814e74e30943c209ebd4da94cd4de3581a52c5bffbe2bcf2e488d6361c6`
- Produces: an accepted candidate where both Computer Use UI descriptors apply and the staged plugin matches the upstream version/skill contract.

- [x] **Step 1: Run focused and broad tests**

```bash
rtk node --test --test-name-pattern='Computer Use' scripts/patch-linux-window-ui.test.js
rtk cargo test -p codex-computer-use-linux
rtk proxy bash tests/scripts_smoke.sh
CI_SKIP_PULL=1 rtk proxy ./scripts/ci-local.sh core
rtk git diff --check
```

- [x] **Step 2: Run exact-DMG acceptance**

Run the pinned Homebrew feature profile against `reports/upstream-dmg/downloads/Codex.dmg`. Require zero blockers, both Computer Use availability descriptors applied, upstream plugin version retained, the Linux-adapted skill staged, and no Computer Use drift warning.

- [ ] **Step 3: Commit, push, and verify**

Commit the source/tests/plan on `patchraptor-main`, push `origin patchraptor-main`, and require `git rev-list --left-right --count HEAD...origin/patchraptor-main` to return `0 0`.
