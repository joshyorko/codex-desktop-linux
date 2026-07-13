"use strict";

const {
  CI_POLICY_REQUIRED_UPSTREAM,
  mainBundlePatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxBundledSkillsRootPatch,
} = require("../../../../impl/main-process/bundled-skills.js");

module.exports = mainBundlePatch({
  id: "linux-bundled-skills-root",
  order: 225,
  ciPolicy: CI_POLICY_REQUIRED_UPSTREAM,
  apply: applyLinuxBundledSkillsRootPatch,
});
