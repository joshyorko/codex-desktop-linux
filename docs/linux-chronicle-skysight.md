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
  `${CODEX_HOME:-$HOME/.codex}/memories_extensions/chronicle/resources`

## Verification After Rebuild

1. Run `node --test linux-features/record-and-replay/test.js`.
2. Rebuild and reinstall the feature bundle.
3. Confirm the bridge exposes `linux-record-replay-skysight-pause` and
   `linux-record-replay-skysight-resume`.
4. Confirm `skysight status` reports the active resource path.
5. Exercise `skysight pause`, `skysight resume`, and `skysight stop` through
   the helper or bridge.
