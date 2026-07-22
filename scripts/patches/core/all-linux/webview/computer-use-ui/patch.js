"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxComputerUseHostPlatformPatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginsPageAvailabilityPatch,
} = require("../../../../impl/computer-use.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-computer-use-ui-availability",
    phase: "webview-asset",
    order: 1100,
    ciPolicy: "required-upstream",
    enabled: (context) => context.enableComputerUseUi,
    pattern: /^computer-use-settings-[^.]+\.js$/,
    missingDescription: "Computer Use availability bundle",
    skipDescription: "Linux Computer Use UI availability patch",
    apply: applyLinuxComputerUseRendererAvailabilityPatch,
  }),
  webviewAssetPatch({
    id: "linux-computer-use-plugins-page-availability",
    phase: "webview-asset",
    order: 1101,
    ciPolicy: "required-upstream",
    enabled: (context) => context.enableComputerUseUi,
    pattern: /^plugins-page-[^.]+\.js$/,
    missingDescription: "global Plugins page bundle",
    skipDescription: "Linux Computer Use global Plugins availability patch",
    apply: applyLinuxComputerUsePluginsPageAvailabilityPatch,
  }),
  webviewAssetPatch({
    id: "linux-computer-use-host-platform",
    phase: "webview-asset",
    order: 1105,
    ciPolicy: "opt-in",
    enabled: (context) => context.enableComputerUseUi,
    pattern: /^app-initial~artifact-tab-content\.electron~notebook-preview-panel~app-main~settings-command-~cajo70vh-[^.]+\.js$/,
    missingDescription: "current Computer Use host-platform bundle",
    skipDescription: "Linux Computer Use host-platform patch",
    apply: applyLinuxComputerUseHostPlatformPatch,
  }),
  webviewAssetPatch({
    id: "linux-computer-use-install-flow",
    phase: "webview-asset",
    order: 1110,
    ciPolicy: "required-upstream",
    enabled: (context) => context.enableComputerUseUi,
    pattern: /^app-initial~avatarOverlayCompositionSurface~artifact-tab-content\.electron~notebook-preview-~iaq4jiqv-[^.]+\.js$/,
    missingDescription: "current Computer Use install flow bundle",
    skipDescription: "Linux Computer Use install flow patch",
    apply: applyLinuxComputerUseInstallFlowPatch,
  }),
];
