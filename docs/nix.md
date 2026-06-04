# Nix

Run Codex Desktop for Linux directly with:

```bash
nix run github:ilysenko/codex-desktop-linux
```

The flake handles dependencies and patches Electron for NixOS. A GitHub Actions
bot refreshes the upstream `Codex.dmg` hash and verifies the Nix package outputs
in `main`. If you hit a hash mismatch right after an upstream release, wait for
the next bot run and retry.

## Codex CLI Requirement

The Nix package does not install the Codex CLI for you. Before first launch,
make sure the `codex` command is available in your user environment, or set
`CODEX_CLI_PATH` to the binary you want Codex Desktop to use.

One option is the upstream npm package:

```bash
npm i -g @openai/codex
```

If `nix run` appears to do nothing, check the launcher log first:

```bash
sed -n '1,220p' ~/.cache/codex-desktop/launcher.log
```

## Feature Outputs

Flakes do not include the git-ignored `linux-features/features.json` opt-in
file, so Nix exposes feature-specific app variants.

Remote mobile control:

```bash
nix run github:ilysenko/codex-desktop-linux#remote-mobile-control
```

Computer Use UI plus remote mobile control:

```bash
nix run github:ilysenko/codex-desktop-linux#computer-use-ui-remote-mobile-control
```

Computer Use UI only:

```bash
nix run github:ilysenko/codex-desktop-linux#codex-desktop-computer-use-ui
```

## Home Manager / NixOS Module

For a declarative install with the mobile remote-control app-server managed by
systemd instead of the Desktop launcher:

```nix
{
  imports = [
    inputs.codex-desktop-linux.homeManagerModules.default
  ];

  programs.codexDesktopLinux = {
    enable = true;
    computerUseUi.enable = true;
    remoteMobileControl.enable = true;
    remoteControl.enable = true;
  };
}
```

This installs the selected Codex Desktop package variant and starts a user
`codex-remote-control.service` with:

```text
codex app-server --remote-control --listen unix://
```

A `nixosModules.default` export is also available for system-level
configurations that prefer a global user unit.

## Development Shell

```bash
nix develop github:ilysenko/codex-desktop-linux
```

## Cachix

CI can populate a Cachix cache named `codex-desktop-linux` for flake package
outputs. To push to the cache, create it in Cachix and add a repository secret
named `CACHIX_AUTH_TOKEN` with write access.

Users can opt in locally with:

```bash
cachix use codex-desktop-linux
```

The scheduled `Populate Cachix` workflow builds the default package,
feature-specific package variants, and `.#installer`.
