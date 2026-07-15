"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxComputerUsePluginsPageAvailabilityPatch,
  applyLinuxComputerUseSharedPluginAvailabilityPatch,
} = require("../../../../impl/computer-use.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-computer-use-shared-plugin-availability",
    phase: "webview-asset",
    order: 1099,
    ciPolicy: "required-upstream",
    enabled: (context) => context.enableComputerUseUi,
    pattern: /^app-initial~app-main~new-thread-panel-page~onboarding-page~appgen-library-page~hotkey-windo~.*\.js$/,
    missingDescription: "shared plugin availability bundle",
    skipDescription: "Linux Computer Use composer availability patch",
    apply: applyLinuxComputerUseSharedPluginAvailabilityPatch,
  }),
  webviewAssetPatch({
    id: "linux-computer-use-ui-availability",
    phase: "webview-asset",
    order: 1100,
    ciPolicy: "required-upstream",
    enabled: (context) => context.enableComputerUseUi,
    pattern: /^computer-use-settings.*\.js$/,
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
    pattern: /^plugins-page.*\.js$/,
    missingDescription: "global Plugins page bundle",
    skipDescription: "Linux Computer Use global Plugins availability patch",
    apply: applyLinuxComputerUsePluginsPageAvailabilityPatch,
  }),
];
