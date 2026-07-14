# Linux Computer Use Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linux Computer Use appear as available in upstream DMG `26.707.72221`, and reject future candidates when the opted-in UI cannot be made available.

**Architecture:** Treat the exact installed `computer-use-settings-*` asset as the current owner of both the availability object and plugin-card selection. Patch those two contracts atomically in the existing renderer patch, make that opt-in descriptor required when enabled, and delete the obsolete shared/install-flow descriptors that no longer have owners in the latest DMG.

**Tech Stack:** Node.js ASAR patch descriptors, `node:test`, upstream-DMG acceptance reports, Homebrew local conversion.

## Global Constraints

- Support only upstream DMG `26.707.72221` shape; retain no legacy bundle routes.
- Preserve upstream rollout gates unrelated to Linux platform support.
- Keep Computer Use UI disabled unless `codex-linux-computer-use-ui-enabled` is enabled.
- Do not modify generated `codex-app/` or the installed Homebrew bundle.

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
