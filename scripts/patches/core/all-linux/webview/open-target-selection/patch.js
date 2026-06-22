"use strict";

const PATCH_NAME = "Linux open target native selection patch";

function warn(message) {
  console.warn(`WARN: ${PATCH_NAME}: ${message}`);
}

function applyLinuxOpenTargetSelectionNativeModePatch(currentSource) {
  const patchedNeedle =
    "let a=new Set(t);if(r===`native`)return e.filter(e=>e.target===`systemDefault`||e.target===`fileManager`||a.has(e.target)&&(n||!e.hidden));return e.filter(e=>a.has(e.target)&&(n||!e.hidden))";
  if (currentSource.includes(patchedNeedle)) {
    return currentSource;
  }

  const currentNeedle =
    "if(r===`native`)return e.filter(e=>e.target===`systemDefault`||e.target===`fileManager`);let a=new Set(t);return e.filter(e=>a.has(e.target)&&(n||!e.hidden))";
  if (currentSource.includes(currentNeedle)) {
    return currentSource.split(currentNeedle).join(patchedNeedle);
  }

  const nativeFilterPattern =
    /if\(([A-Za-z_$][\w$]*)===`native`\)return ([A-Za-z_$][\w$]*)\.filter\(([A-Za-z_$][\w$]*)=>\3\.target===`systemDefault`\|\|\3\.target===`fileManager`\);let ([A-Za-z_$][\w$]*)=new Set\(([A-Za-z_$][\w$]*)\);return \2\.filter\(\3=>\4\.has\(\3\.target\)&&\(([A-Za-z_$][\w$]*)\|\|!\3\.hidden\)\)/;
  let patched = false;
  const nextSource = currentSource.replace(
    nativeFilterPattern,
    (
      match,
      modeVar,
      targetsVar,
      targetVar,
      availableSetVar,
      availableTargetsVar,
      includeHiddenTargetsVar,
    ) => {
      patched = true;
      return (
        `let ${availableSetVar}=new Set(${availableTargetsVar});` +
        `if(${modeVar}===\`native\`)return ${targetsVar}.filter(${targetVar}=>` +
        `${targetVar}.target===\`systemDefault\`||${targetVar}.target===\`fileManager\`||` +
        `${availableSetVar}.has(${targetVar}.target)&&(${includeHiddenTargetsVar}||!${targetVar}.hidden));` +
        `return ${targetsVar}.filter(${targetVar}=>${availableSetVar}.has(${targetVar}.target)&&` +
        `(${includeHiddenTargetsVar}||!${targetVar}.hidden))`
      );
    },
  );

  if (!patched && currentSource.includes("mode:") && currentSource.includes("fileManager")) {
    warn("Could not find native Open In target selector — skipping native selection patch");
  }
  return nextSource;
}

module.exports = {
  id: "linux-open-target-selection-native-mode",
  phase: "webview-asset",
  order: 1120,
  ciPolicy: "optional",
  pattern: /^open-target-selection-.*\.js$/,
  missingDescription: "Open In target selection bundle",
  skipDescription: "Linux Open In native target selection patch",
  apply: applyLinuxOpenTargetSelectionNativeModePatch,
  applyLinuxOpenTargetSelectionNativeModePatch,
};
