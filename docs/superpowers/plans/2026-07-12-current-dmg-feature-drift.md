# July 12 Current-DMG Feature Drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the full enabled-feature acceptance profile for the July 12 DMG without dropping behavior.

**Architecture:** Keep every change inside the owning feature directory. Retarget descriptors to the one current upstream chunk and adapt only the changed Copilot writer needle.

**Tech Stack:** Node.js test runner, JavaScript ASAR patch descriptors, Bash DMG inspection.

## Global Constraints

- Support only the latest upstream DMG shape.
- Keep optional features disabled by default.
- Do not modify generated app output or the installed runtime.
- Preserve fail-soft, idempotent patch behavior.

---

### Task 1: Retarget current bundle ownership

**Files:**
- Modify: `linux-features/remote-control-ui/patch.js`
- Modify: `linux-features/remote-control-ui/test.js`
- Modify: `linux-features/api-key-service-tier/patch.js`
- Modify: `linux-features/api-key-service-tier/test.js`
- Modify: `linux-features/ui-tweaks/patches/model-picker-model-list.js`
- Modify: `linux-features/ui-tweaks/test.js`

- [ ] Add July 12 descriptor tests and verify they fail.
- [ ] Replace obsolete chunk patterns with the current `ho~iufn7mg3` pattern.
- [ ] Run the three focused test files and verify they pass.

### Task 2: Preserve Copilot effort persistence

**Files:**
- Modify: `linux-features/copilot-reasoning-effort/patch.js`
- Modify: `linux-features/copilot-reasoning-effort/test.js`

- [ ] Add a July 12 writer fixture and verify persistence coverage fails.
- [ ] Retarget descriptors and minimally adapt the writer patch to the current sequence.
- [ ] Run the focused Copilot test and verify it passes.

### Task 3: Verify the full profile

**Files:**
- No production files beyond Tasks 1 and 2.

- [ ] Run all four focused feature tests.
- [ ] Run all Linux feature tests and patcher tests.
- [ ] Inspect the pinned July 12 DMG with the full feature config.
- [ ] Re-evaluate the acceptance decision and require zero enabled-feature blockers.
