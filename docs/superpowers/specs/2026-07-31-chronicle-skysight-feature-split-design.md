# Chronicle / Skysight Feature Split Design

## Goal

Make Chronicle / Skysight independently selectable in `codex-desktop-setup`
while preserving the obvious dependency behavior:

- enabling Record & Replay automatically enables Chronicle / Skysight;
- Chronicle / Skysight can be enabled without Record & Replay;
- disabling Chronicle / Skysight also disables Record & Replay;
- selecting either feature never starts continuous capture by itself.

## Chosen Architecture

Add a disabled-by-default `chronicle-skysight` Linux feature and make
`record-and-replay` require it. The existing feature dependency closure in the
Homebrew setup wizard provides the selection behavior in both directions.

Chronicle / Skysight owns the shared Linux backend binary, Linux Chronicle
Settings and tray integration, and a dedicated bundled MCP plugin running the
backend in `skysight mcp` mode. That MCP mode exposes only activity-memory
tools. Record & Replay owns its composer/plugin surface, bounded recording
tools, recording HUD, transcript integration, and skill drafting workflow. Its
plugin continues to run the full `event-stream mcp` mode.

The shared backend is built once by Chronicle / Skysight. Record & Replay
copies that staged backend into its own plugin instead of rebuilding it.

## Alternatives Considered

1. Keep one feature and only rename the setup row. This improves discovery but
   does not provide independent control.
2. Add a setup-only pseudo-toggle backed by feature settings. This couples the
   Homebrew wizard to one feature's private schema and leaves direct
   `features.json` users with a different model.
3. Split Chronicle / Skysight into a real feature dependency. This is the
   selected approach because the same contract works in the wizard, direct
   config, local builds, updater rebuilds, and acceptance reports.

## Components

### `chronicle-skysight` feature

- Manifest title: `Chronicle / Skysight Activity Memory`.
- Disabled by default and usable alone.
- Stages `codex-record-replay-linux` into shared native resources.
- Stages a bundled Chronicle / Skysight plugin and skill with a
  `skysight mcp` server.
- Owns Linux Chronicle Settings/tray patching and Skysight bridge handlers.
- Owns cleanup of its plugin and shared native backend.

### `record-and-replay` feature

- Declares `requires: ["chronicle-skysight"]`.
- Stages only the Record & Replay plugin-specific files and reuses the shared
  native backend.
- Owns bounded recording, HUD, transcript, bundle, draft, and skill-import
  handlers.
- Its cleanup removes only Record & Replay-owned files.

### Rust MCP modes

- `event-stream mcp` exposes the existing full Record & Replay plus Skysight
  tool set.
- `skysight mcp` exposes only `skysight_*` tools and activity-memory readiness.
- Neither server starts Skysight during startup or status discovery.

## Data And Lifecycle

The feature selection is stored as ordinary enabled feature IDs. No new
Homebrew-only settings schema is introduced. Builds validate the manifest
dependency before patching or staging. Stage hooks are idempotent. A standalone
Chronicle build contains no Record & Replay marketplace entry, composer UI,
HUD, or recording tools. A combined build contains both plugins but only one
shared native backend payload.

Continuous capture starts only through an explicit Chronicle tray action,
Skysight MCP start call, or direct CLI start. Disabling the feature on a future
rebuild removes its plugin and backend without deleting existing user memory
resources.

## Failure Handling

- Chronicle staging fails clearly if the shared backend cannot be built or a
  configured prebuilt binary is invalid.
- Record & Replay staging fails clearly if its required shared backend is
  missing.
- Dependency validation rejects Record & Replay-only direct configs.
- Patch drift remains fail-soft according to existing feature policy, while
  enabled-feature acceptance rejects a candidate whose enabled feature drifts.

## Verification

- Wizard tests prove dependency selection and deselection behavior.
- Feature-framework tests prove direct config dependency validation.
- Chronicle feature tests prove standalone patch/plugin/backend layout.
- Record & Replay tests prove its plugin reuses the shared backend and contains
  no Chronicle-owned patch descriptors.
- Rust tests prove `skysight mcp` exposes no recording tools and
  `event-stream mcp` retains the full tool set.
- Final verification runs both feature suites, core patch tests, script smoke,
  Rust checks/tests, Homebrew setup tests, and a latest-DMG candidate acceptance
  build with both features enabled.
