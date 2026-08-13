# Thorium Chrome Plugin Support

This optional Linux feature extends the bundled Chrome plugin to recognize
Thorium as a Chromium-family browser.

It is disabled by default because Thorium is a narrower browser variant that the
core Linux port does not regularly test. Enable it by adding the feature id to
`linux-features/features.json` before building or installing:

```json
{
  "enabled": [
    "thorium-chrome-plugin"
  ]
}
```

When enabled, the feature:

- adds Thorium native-messaging manifest locations for the generated launcher
- registers Thorium in the staged Chrome plugin's browser registry
  (`scripts/extension-ids.json`), which is where upstream reads install
  commands, process names, profile directories, and native-messaging manifest
  locations from
- adds Thorium to the Electron-side Chrome extension settings/status helper

Thorium inherits the Chrome extension identity, because it loads the same
extension build. Upstream moved this contract into the registry in
26.803.41515; before that the same coverage needed seven separate patches
against Chrome-only constants in individual plugin scripts.

Run the focused tests with:

```bash
node --test linux-features/thorium-chrome-plugin/test.js
```
