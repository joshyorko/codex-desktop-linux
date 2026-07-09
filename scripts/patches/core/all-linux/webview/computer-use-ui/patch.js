"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxComputerUseInstallFlowPatch,
} = require("../../../../impl/computer-use.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-computer-use-ui-availability",
    phase: "webview-asset",
    order: 1100,
    ciPolicy: "opt-in",
    enabled: (context) => context.enableComputerUseUi,
    pattern: /^(use-model-settings|apps|use-in-app-browser-use-availability|use-is-plugins-enabled|use-native-apps\.electron|computer-use-settings|app-initial~app-main~onboarding-page|app-initial~app-main~worktree-init-v2-page~remote-conversation-page~pull-requests-page~new-).*\.js$/,
    missingDescription: "Computer Use availability bundle",
    skipDescription: "Linux Computer Use UI availability patch",
    apply: applyLinuxComputerUseRendererAvailabilityPatch,
  }),
  webviewAssetPatch({
    id: "linux-computer-use-install-flow",
    phase: "webview-asset",
    order: 1110,
    ciPolicy: "opt-in",
    enabled: (context) => context.enableComputerUseUi,
    pattern: /^app-initial~app-main~remote-conversation-page~new-thread-panel-page~onboarding-page~appgen-~.*\.js$/,
    missingDescription: "plugin install flow bundle",
    skipDescription: "Linux Computer Use install flow patch",
    apply: applyLinuxComputerUseInstallFlowPatch,
  }),
];
