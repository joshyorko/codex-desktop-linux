{ lib }:
let
  supportedFeatureIds = [
    "agent-workspace"
    "api-key-model-visibility"
    "api-key-service-tier"
    "appshots"
    "authenticated-proxy"
    "automation-extensions"
    "codex-micro"
    "computer-use-linux"
    "copilot-reasoning-effort"
    "directory-only-working-tree-watch"
    "frameless-titlebar"
    "global-dictation"
    "linux-performance-workarounds"
    "mcp-helper-reaper"
    "node-repl-reaper"
    "omarchy-theme"
    "persistent-status-panel"
    "pet-overlay"
    "project-group-last-updated-sort"
    "project-task-sort"
    "read-aloud"
    "read-aloud-mcp"
    "record-and-replay"
    "remote-control-ui"
    "remote-mobile-control"
    "shallow-repository-watches"
    "shared-app-server-socket"
    "thorium-chrome-plugin"
    "ui-tweaks"
  ];

  sortAndDeduplicate = featureIds:
    lib.sort builtins.lessThan (lib.unique featureIds);

  normalize = featureIds:
    if !builtins.isList featureIds then
      throw "Nix Linux feature IDs must be provided as a list"
    else if !(lib.all builtins.isString featureIds) then
      throw "Nix Linux feature IDs must all be strings"
    else
      let
        normalized = sortAndDeduplicate featureIds;
        unsupported = lib.filter (featureId: !(lib.elem featureId supportedFeatureIds)) normalized;
      in
      if unsupported != [ ] then
        throw "Unsupported Nix Linux feature IDs: ${lib.concatStringsSep ", " unsupported}"
      else
        normalized;
in
{
  inherit normalize supportedFeatureIds;

  optionType = lib.types.listOf (lib.types.enum supportedFeatureIds);
}
