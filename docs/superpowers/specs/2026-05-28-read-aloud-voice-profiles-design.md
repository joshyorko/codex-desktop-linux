# Read Aloud Voice Profiles Design

## Context

Linux Read Aloud currently exists as two opt-in Linux features:

- `read-aloud` adds an explicit assistant-message speaker button, a dedicated Read Aloud settings page, Kokoro setup/download controls, and a pace slider.
- `read-aloud-mcp` stages a bundled `read-aloud` MCP plugin backed by the local Rust binary `codex-read-aloud-linux`, exposing `doctor`, `read_aloud`, and `stop`.

The implementation works, but it is still a first slice. It can speak through Kokoro, system TTS, or a custom command, but voice/provider selection is mostly hidden behind env vars. Kokoro voice can be overridden per MCP call, but the app has no easy persistent voice picker. Startup is also too slow because the current Kokoro path launches a fresh Python process and loads the ONNX model for each utterance.

## Problem

Read Aloud should feel like a polished Linux feature, not a proof-of-concept:

- Users need an obvious way to choose a voice when Read Aloud is enabled.
- The MCP server needs the same voice/profile controls as the app UI.
- The first spoken audio should start quickly after pressing the button.
- The implementation should make future providers easy to add without burying provider-specific code in minified webview patches.
- Free/local/no-account providers should be supported. Paid cloud providers are out of scope.

## Goals

1. Add first-class voice selection in the Read Aloud settings UI.
2. Persist the selected voice and pace in the same Linux settings file used by the app and MCP.
3. Add MCP tools to inspect, set, and preview voice settings.
4. Keep the existing explicit-click behavior: Read Aloud does not speak automatically unless the user starts conversation mode or explicitly asks the MCP to speak.
5. Make Kokoro playback noticeably faster by avoiding per-utterance model load where practical.
6. Introduce a provider/profile abstraction that can support local providers and no-account browser/system voices.

## Non-Goals For The First Patch

- Do not add OpenAI TTS, ElevenLabs, Google Cloud TTS, or any paid/billing-backed provider.
- Do not store API keys in `settings.json`.
- Do not make Read Aloud always-on.
- Do not replace upstream realtime voice.
- Do not bundle large model files in the app package.

Paid providers are not part of this spec. If a Google-branded voice path requires a Google Cloud project, API key, OAuth credential, billing account, or metered API call, it is out. The only Google-related path worth evaluating here is a free local/browser/system speech voice exposed through the running desktop environment or browser runtime.

## Product Behavior

### Settings UI

When Read Aloud is enabled, the Read Aloud settings page should show:

- Provider selector
- Voice selector
- Speed control
- Preview button
- Setup/status row

Initial provider choices:

- `Kokoro` for the current local ONNX setup.
- `System voice` for Speech Dispatcher / `spd-say` / `espeak-ng` fallback.
- `Browser voice` for no-account browser/runtime voices if Electron exposes a reliable `speechSynthesis` path.
- `Custom command` for user-provided stdin-based TTS.

Initial voice selector behavior:

- For Kokoro, list voices discovered from the installed `voices-v1.0.bin` file when possible.
- If discovery is not available, show known Kokoro voice ids from the bundled/default voices file list as a fallback.
- For system voice, show available system voice metadata when discovery is cheap; otherwise expose a text input for the voice id.
- For browser voice, list only voices available locally through the runtime. Do not call Google Cloud or any paid API.
- For custom command, hide voice selection unless the command advertises supported voices later.

The speed control stays next to voice selection. It should continue to use the current `0.70x` to `1.40x` range for Kokoro.

### Speaker Button UX

The current assistant speaker icon looks bolted on. The redesigned control should feel native to Codex Desktop:

- Use the existing assistant action toolbar pattern rather than a separate awkward row.
- Use the app's icon style, spacing, hover treatment, tooltip behavior, and disabled opacity.
- Show clear states: idle, loading voice, speaking, stopping, and unavailable.
- When loading, use a small inline spinner or pulsing waveform, not a full extra status block.
- When speaking, the button should become a stop control with a subtle active accent.
- Error state should be quiet but useful: tooltip or short inline label such as `Voice unavailable`, with details in logs/doctor.
- The control should not shift message layout when state changes.

This is product work, not just a functionality patch. The button should look like it belongs in the app.

### MCP Tools

Add tools to `codex-read-aloud-linux`:

- `list_voices`
  - Returns providers, available voices, current provider, current voice, pace, and readiness.
- `get_voice_settings`
  - Returns the persisted provider/voice/pace/config state.
- `set_voice_settings`
  - Persists provider, voice, and pace.
  - Validates known providers and clamps pace.
  - Does not require speaking.
- `preview_voice`
  - Speaks a short preview phrase using the requested or current profile.

Keep existing tools:

- `doctor`
- `read_aloud`
- `stop`

`read_aloud` should continue to support per-call `voice` and `pace` overrides. Per-call values must not mutate saved defaults unless `set_voice_settings` is called.

## Settings Model

Add these persisted keys:

- `codex-linux-read-aloud-provider`
- `codex-linux-read-aloud-kokoro-voice`
- `codex-linux-read-aloud-kokoro-speed`
- `codex-linux-read-aloud-custom-command`
- `codex-linux-read-aloud-system-voice`

Precedence for a speech request:

1. Per-call MCP/UI override.
2. Environment variable override.
3. Persisted setting.
4. Provider default.

Existing env vars remain supported for compatibility:

- `CODEX_LINUX_READ_ALOUD_COMMAND`
- `CODEX_LINUX_READ_ALOUD_KOKORO_VOICE`
- `CODEX_LINUX_READ_ALOUD_KOKORO_SPEED`
- `CODEX_LINUX_READ_ALOUD_KOKORO_MODEL`
- `CODEX_LINUX_READ_ALOUD_KOKORO_VOICES`
- `CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON`

## Provider Architecture

Introduce a small provider boundary inside `read-aloud-linux`:

- `VoiceProvider`
  - `id`
  - `display_name`
  - `doctor`
  - `list_voices`
  - `speak`
  - `stop`

Initial provider implementations:

- `KokoroProvider`
- `SystemProvider`
- `CustomCommandProvider`

The webview patch should not grow provider-specific complexity. It should call the existing main-process Read Aloud handler for config/setup/speak and let the Rust MCP/backend own provider details where possible.

## Performance Plan

Current Kokoro startup likely feels slow because each utterance starts a fresh Python process and reloads the ONNX model.

Performance work should be measured around:

- button click to process spawn
- process spawn to first PCM bytes
- first PCM bytes to audible playback
- total synthesis time

Target behavior:

- Warm path: first audio starts within roughly 500-900 ms for a short sentence on Josh's Bluefin machine.
- Cold path: if the model is not loaded yet, the UI should show a clear loading state and then keep the backend warm for subsequent speech.

Implementation direction:

1. Add timing diagnostics to `doctor` or a new internal benchmark path.
2. Add a persistent Kokoro worker mode that loads the model once and accepts multiple speak requests.
3. Make `stop` interrupt active playback without killing the warm worker unless the worker is unhealthy.
4. Keep the one-shot `kokoro-stdin` runner as a fallback for reliability.

The warm worker can be implemented as either:

- a Rust-managed child process using a JSONL protocol to a Python Kokoro worker, or
- a local user-session daemon/socket owned by `codex-read-aloud-linux`.

Recommendation: start with the Rust-managed Python worker inside `codex-read-aloud-linux`. It is less invasive than introducing a daemon and still solves the repeated model-load cost for MCP-driven speech. If the app-side button cannot share that warm process cleanly, then the second patch should route app Read Aloud through the Rust backend too.

## Free Provider Direction

Free/local/no-account providers worth evaluating:

- Kokoro ONNX: current default, good quality, local, already installed.
- Piper: local, fast, many voices, model management needed.
- RHVoice: local/system package on some distros, voice availability varies.
- Speech Dispatcher: already useful as fallback, quality depends on installed voices.
- Browser/runtime voices: possible no-account path through `speechSynthesis`, depending on what Electron exposes on Linux. This may or may not include good Google-style voices, so it needs real runtime testing before we promise it.

Pushback: Google Cloud, OpenAI, and ElevenLabs are out for this spec because they require credentials, billing/privacy choices, network error handling, and quota management. A free Google-like voice is acceptable only if it is already exposed by the local browser/runtime without a paid API.

## Testing

Rust tests:

- settings read/write preserves unrelated keys
- env overrides beat persisted settings
- per-call voice/pace overrides do not mutate defaults
- `set_voice_settings` validates provider and clamps pace
- `list_voices` returns Kokoro fallback voices when discovery is unavailable
- `doctor` reports current provider/voice/pace
- provider selection falls back cleanly when a provider is unavailable

Node feature tests:

- Read Aloud settings page includes provider, voice, pace, and preview controls
- assistant speaker control has stable markup/classes for idle, loading, speaking, and error states
- generated UI persists `codex-linux-read-aloud-kokoro-voice`
- main-process Read Aloud config includes selected provider/voice
- old builds/settings remain compatible

Manual validation:

- enable `read-aloud` and `read-aloud-mcp`
- pick `af_heart`, preview, then click an assistant speaker button
- change speed and confirm both MCP and app button use it
- run `doctor` and confirm it reports the selected voice
- measure cold and warm click-to-audio time before/after

## Acceptance Criteria

- User can change Kokoro voice from the Read Aloud settings UI without editing env vars.
- User can change Kokoro voice through the MCP.
- Voice and speed persist across app restarts.
- App button, conversation mode, and MCP all use the same persisted voice unless overridden.
- Preview works from UI or MCP.
- Assistant speaker button looks and behaves like a native Codex action, without layout jumps.
- Kokoro warm path is materially faster than the current one-shot path, with timing evidence in the PR.
- No paid provider, cloud API key, OAuth credential, or billing-backed speech path is introduced.

## Open Questions

- Should the first UI ship as a dropdown only for Kokoro, or should provider selection ship in the same patch?
- Should the app-side button call the Rust backend directly, or keep the current main-process JavaScript path until the warm worker exists?
- Should voice discovery parse `voices-v1.0.bin` directly in Rust/Python, or ship a static known-voice fallback list and defer full discovery?
- Does Electron on Linux expose useful no-account browser voices through `speechSynthesis`, or should `Browser voice` be dropped from the first implementation?
