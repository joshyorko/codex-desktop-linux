"use strict";

const PATCH_MARKER = "CODEX_LINUX_BUNDLED_SKILLS_ROOT";
const PATCH_SIGNATURE =
  `process.platform===\`linux\`&&process.env.${PATCH_MARKER}?.trim()?process.env.${PATCH_MARKER}.trim():`;
const PACKAGED_SKILLS_ROOT_PATTERN =
  /if\(([A-Za-z_$][\w$]*)\.app\.isPackaged\)return ([A-Za-z_$][\w$]*)\.join\(process\.resourcesPath,`skills`\);/gu;

function applyLinuxBundledSkillsRootPatch(currentSource) {
  if (currentSource.includes(PATCH_SIGNATURE)) {
    return currentSource;
  }

  const matches = [...currentSource.matchAll(PACKAGED_SKILLS_ROOT_PATTERN)];
  if (matches.length !== 1) {
    console.warn(
      "WARN: Could not find packaged bundled skills root insertion point — skipping Linux bundled skills root patch",
    );
    return currentSource;
  }

  return currentSource.replace(
    PACKAGED_SKILLS_ROOT_PATTERN,
    (_match, electronVar, pathVar) =>
      `if(${electronVar}.app.isPackaged)return process.platform===\`linux\`&&process.env.${PATCH_MARKER}?.trim()?process.env.${PATCH_MARKER}.trim():${pathVar}.join(process.resourcesPath,\`skills\`);`,
  );
}

module.exports = {
  applyLinuxBundledSkillsRootPatch,
};
