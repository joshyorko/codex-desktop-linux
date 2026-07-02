# Linux Chronicle / Skysight

Chronicle/Skysight is the screen and event-memory companion to Record & Replay
on Linux. It is part of the demo-to-skill capture path, not a microphone
transcription system.

## Relationship To Record & Replay

- Record & Replay owns the user-facing demo-to-skill flow.
- Chronicle/Skysight keeps the recent activity memory that helps draft the
  resulting skill.
- `speech_context` remains the transcript channel when spoken text is
  available; it is separate from Chronicle-compatible resources.

## Runtime Locations

- Runtime state: `$XDG_RUNTIME_DIR/skysight`
- Chronicle-compatible resources:
  `${CODEX_HOME:-$HOME/.codex}/memories/extensions/chronicle/resources`
- Segment evidence:
  `$XDG_RUNTIME_DIR/skysight/segments/<timestamp>-linux-activity/`

Each segment writes:

- `events.jsonl` with diagnostics, provider readiness, artifact references,
  capture errors, and suppressed-evidence records.
- `metadata.json` with event, artifact, exclusion, and suppression counts.
- `artifacts/` with bounded local evidence such as diagnostics, screenshot
  files, window/app metadata, and AT-SPI/accessibility snapshots when available.

Skysight writes rolling `*-10min-*.md` resources for recent segment windows and
cadence-limited `*-6h-*.md` rollups. Exclusion rules suppress matching
window/app/accessibility evidence and record suppression counts instead of
copying excluded content into resources.

## Verification After Rebuild

1. Run `node --test linux-features/record-and-replay/test.js`.
2. Rebuild and reinstall the feature bundle.
3. Confirm the bridge exposes `linux-record-replay-skysight-pause` and
   `linux-record-replay-skysight-resume`.
4. Confirm `skysight status` reports the active resource path.
5. Exercise `skysight pause`, `skysight resume`, and `skysight stop` through
   the helper or bridge.
6. Capture `skysight snapshot` and confirm the segment has `events.jsonl`,
   `metadata.json`, `artifacts/diagnostics.json`, a `*-10min-*.md` resource,
   and either a newly-created or previously-current `*-6h-*.md` rollup.
