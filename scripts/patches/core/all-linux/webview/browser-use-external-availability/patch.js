"use strict";

const {
  applyLinuxBrowserUseExternalAvailabilityPatch,
} = require("../../../../webview-assets.js");

module.exports = {
  id: "linux-browser-use-external-availability",
  phase: "webview-asset",
  order: 1092,
  ciPolicy: "optional",
  pattern: /^use-is-plugins-enabled-.*\.js$/,
  missingDescription: "external Browser Use availability bundle",
  skipDescription: "Linux external Browser Use availability patch",
  apply: applyLinuxBrowserUseExternalAvailabilityPatch,
};
