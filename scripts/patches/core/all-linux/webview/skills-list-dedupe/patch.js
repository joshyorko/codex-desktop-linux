"use strict";

const {
  applyLinuxSkillsListDedupePatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-skills-list-dedupe",
    phase: "webview-asset",
    order: 1043,
    ciPolicy: "optional",
    pattern: /^(?:app-initial~app-main~|app-main-|index-).*\.js$/,
    missingDescription: "skills list webview bundle",
    skipDescription: "Linux skills list dedupe patch",
    apply: applyLinuxSkillsListDedupePatch,
  },
];
