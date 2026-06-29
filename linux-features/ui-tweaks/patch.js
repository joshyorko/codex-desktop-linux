"use strict";

const sidebarProjectName = require("./patches/sidebar-project-name.js");

function patchesFrom(...modules) {
  return modules.flatMap((moduleExports) =>
    Array.isArray(moduleExports?.patches) ? moduleExports.patches : [],
  );
}

module.exports = {
  patches: patchesFrom(sidebarProjectName),
};
