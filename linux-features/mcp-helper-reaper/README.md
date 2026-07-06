# MCP Helper Reaper

Codex can reload MCP helpers under the same live backend process without
reaping the older generation. On Linux this is especially costly when a helper
owns language servers or desktop sidecars.

This feature is bundle-native. It installs a small Rust reaper plus three
runtime triggers:

- a wrapper around the staged `resources/node_repl` entrypoint;
- Desktop cold-start/after-exit scan hooks;
- a Codex `SessionStart` hook merged into `CODEX_HOME/hooks.json`.

When a Codex backend starts a new MCP helper generation, these triggers schedule
short delayed cleanup passes scoped to each live Codex parent PID. The
`node_repl` wrapper targets its direct parent; the scan hooks inspect live Codex
parents independently. Separate Codex sessions remain independent.

## Scope

The reaper deduplicates direct MCP helper children under one Codex parent. It
keeps the newest process for each helper signature and reaps older duplicates
plus their descendants.

Helper detection is generic:

- configured MCP server commands are read from Codex config;
- bundled plugin helpers are recognized by staged app plugin/resource paths;
- command lines with MCP/stdio-style conventions are recognized;
- shell `-c` children are ignored so normal tool executions are not reaped.

The feature does not hardcode local tools or providers.

## Enable

Add to `linux-features/features.json`:

```json
{ "enabled": ["mcp-helper-reaper"] }
```

then rebuild/reinstall. The feature is disabled by default.

When disabled on a later rebuild, the cleanup hook restores
`resources/node_repl` from this feature's backup, removes staged launcher hooks
and binaries, and removes this feature's `SessionStart` command marker from
`CODEX_HOME/hooks.json` when that file is available.

## Runtime Controls

- `CODEX_MCP_HELPER_REAPER_DISABLE=1` disables the `node_repl` wrapper trigger.
- `CODEX_MCP_HELPER_REAPER_DISABLE_HOOK=1` skips installing the `SessionStart`
  hook from Desktop runtime hooks.
- `CODEX_MCP_HELPER_REAPER_DELAY` sets the first delayed pass in seconds
  (default `3`).
- `CODEX_MCP_HELPER_REAPER_PASSES` sets how many cleanup passes run
  (default `3`).
- `CODEX_MCP_HELPER_REAPER_INTERVAL` sets seconds between passes
  (default `2`).
- `CODEX_MCP_HELPER_REAPER_TERM_TIMEOUT` sets the SIGTERM grace period
  (default `2`).

## Test

```bash
rtk cargo test -p codex-mcp-helper-reaper
node --test linux-features/mcp-helper-reaper/test.js
```
