# Launcher Performance Notes

## Context

This decision record captures a performance comparison between Codex Desktop
and another Electron 42 app (Claude Desktop) running side by side on the same
X11 GNOME 4K host, what the launcher changed as a result, and — just as
importantly — what was reviewed and deliberately left alone so future work
does not re-litigate it without new evidence.

Evidence came from live process command lines, `/proc/<pid>/maps`, the
launcher log, and repository history rather than synthetic benchmarks.

## What Changed

- `--disable-dev-shm-usage` is now passed only when `/dev/shm` is missing,
  not writable, or smaller than 1 GiB. The flag exists for containers with a
  tiny `/dev/shm` (Docker defaults to 64 MiB); everywhere else it pushed
  Chromium's renderer/GPU shared-memory buffers into disk-backed temp storage
  (observable as `/tmp/.org.chromium.Chromium.*` mappings in every process).
  Override: `CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=auto|0|1`.
- `--force-renderer-accessibility` is now added only when an assistive
  technology is detected: Orca or brltty running, the GNOME screen-reader
  setting, the AT-SPI state that `codex-computer-use-linux setup` enables
  (`org.a11y.Status IsEnabled` via busctl, or its
  `org.gnome.desktop.interface toolkit-accessibility` gsettings fallback), or
  accessibility env markers. Keeping the accessibility engine on in every
  renderer makes each DOM update also rebuild and serialize the accessibility
  tree; the WSLg and wayland-gpu profiles already skipped the flag for that
  reason. Session-bus probes (gsettings/busctl) run under the launcher's
  ppid-guarded watchdog pattern capped at 0.5 s, so a broken session bus
  counts as "not detected" instead of delaying launch.
  Override: `CODEX_FORCE_RENDERER_ACCESSIBILITY=1|0`.

Both decisions are visible at runtime in the `Electron launch mode:` line of
`~/.cache/codex-desktop/launcher.log` (`dev_shm_usage_disabled=`,
`renderer_accessibility_forced=`).

## Reviewed And Deliberately Not Changed

### `--no-sandbox` and `--disable-gpu-sandbox`

These are security-posture flags, not measurable rendering-performance
factors. Removing them is a separate compatibility project: the Electron
SUID/user-namespace sandbox behaves differently across distributions and
container/AppImage environments, and the troubleshooting docs currently
promise `--no-sandbox` behavior. Out of scope for performance work.

### Wayland `--disable-gpu-compositing` workaround

On Wayland sessions the launcher intentionally trades compositing performance
for side-panel rendering stability. That is a documented workaround with an
explicit opt-out (`CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=0`); do not remove
it for performance reasons without re-testing the side-panel flicker it
papers over.

### Webview server model

The bundled Python server already uses `ThreadingHTTPServer` and serves the
hashed `/assets/` bundle with `Cache-Control: public, max-age=31536000,
immutable`, so parallel chunk fetches and cross-restart disk caching are
covered. Replacing it with a Rust server was evaluated and rejected until
evidence shows Python itself is the bottleneck — see
[Webview server evaluation](webview-server-evaluation.md).

### Serialized startup ordering

The launcher intentionally starts the webview server, verifies the origin,
and only then launches Electron so Chromium never races a server that has
not bound yet. The server binds in milliseconds; parallelizing the spawn
would buy little and risk the documented startup markers and warm-start
handoff behavior.

### In-app startup latency

Most of the visible loading-screen time is spent inside the upstream app:
the renderer blocks on `codex app-server` RPCs after the static assets load
(the launcher log shows individual calls such as `app/list` taking multiple
seconds on cold start). That is upstream application behavior inside
`app.asar`, not Linux adaptation glue, and is out of scope for this
repository beyond faithfully reporting it.

### CLI preflight

Launcher CLI preflight is best-effort, recently hardened, and not part of the
rendering path. No performance changes were made there.
