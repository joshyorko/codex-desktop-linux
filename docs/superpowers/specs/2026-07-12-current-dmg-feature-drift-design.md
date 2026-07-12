# July 12 Current-DMG Feature Drift Design

## Goal

Preserve the user-visible behavior of `remote-control-ui`,
`api-key-service-tier`, `copilot-reasoning-effort`, and `ui-tweaks`
against the July 12, 2026 upstream DMG.

## Design

- Retarget feature descriptors to the current
  `app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-*.js`
  bundle where the affected settings, model, service-tier, remote-control, and
  model-picker code now lives.
- Keep the patches current-DMG-only. Do not retain the prior chunk patterns as
  fallbacks.
- Preserve each patch's existing atomic and idempotent behavior.
- Update the Copilot persistence patch for the current writer sequence, which
  now checks host availability before logging and updating the host model.
- Do not change core patching or the installed Codex runtime.

## Verification

- Add focused fixtures and descriptor assertions for the July 12 bundle shape.
- Run the four feature test files.
- Run all Linux feature tests and the patcher tests.
- Inspect the exact pinned DMG with the full enabled-feature profile and require
  an acceptance verdict of `accepted` or `accepted_with_warnings` with no
  enabled-feature blockers.
