"use strict";

const PATCH_NAME = "Linux open target native selection patch";

function warn(message) {
  console.warn(`WARN: ${PATCH_NAME}: ${message}`);
}

function applyLinuxOpenTargetSelectionNativeModePatch(currentSource) {
  const patchedNeedle =
    "let a=new Set(t);if(r===`native`)return e.filter(e=>e.target===`systemDefault`||e.target===`fileManager`||a.has(e.target)&&(n||!e.hidden));return e.filter(e=>a.has(e.target)&&(n||!e.hidden))";
  const currentNeedle =
    "if(r===`native`)return e.filter(e=>e.target===`systemDefault`||e.target===`fileManager`);let a=new Set(t);return e.filter(e=>a.has(e.target)&&(n||!e.hidden))";
  let nextSource = currentSource;
  let patchedNativeMode = nextSource.includes(patchedNeedle);
  if (!nextSource.includes(patchedNeedle) && nextSource.includes(currentNeedle)) {
    nextSource = nextSource.split(currentNeedle).join(patchedNeedle);
    patchedNativeMode = true;
  }

  const nativeFilterPattern =
    /if\(([A-Za-z_$][\w$]*)===`native`\)return ([A-Za-z_$][\w$]*)\.filter\(([A-Za-z_$][\w$]*)=>\3\.target===`systemDefault`\|\|\3\.target===`fileManager`\);let ([A-Za-z_$][\w$]*)=new Set\(([A-Za-z_$][\w$]*)\);return \2\.filter\(\3=>\4\.has\(\3\.target\)&&\(([A-Za-z_$][\w$]*)\|\|!\3\.hidden\)\)/;
  if (!nextSource.includes(patchedNeedle)) {
    nextSource = nextSource.replace(
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
        patchedNativeMode = true;
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
  }

  const patchedAppPathNeedle =
    "let i=e.filter(e=>e.appPath!=null),a=new Set(t);if(i.length>0)return e.filter(e=>e.appPath==null&&e.kind===`editor`&&a.has(e.target)&&(n||!e.hidden)).concat(i);if(r===`native`)return e.filter(e=>e.target===`systemDefault`||e.target===`fileManager`||a.has(e.target)&&(n||!e.hidden));return e.filter(e=>a.has(e.target)&&(n||!e.hidden))";
  let patchedAppPathShortcut = nextSource.includes(patchedAppPathNeedle);
  const appPathShortcutPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.filter\(([A-Za-z_$][\w$]*)=>\3\.appPath!=null\);if\(\1\.length>0\)return \1;let ([A-Za-z_$][\w$]*)=new Set\(([A-Za-z_$][\w$]*)\);if\(([A-Za-z_$][\w$]*)===`native`\)return \2\.filter\(\3=>\3\.target===`systemDefault`\|\|\3\.target===`fileManager`\|\|\4\.has\(\3\.target\)&&\(([A-Za-z_$][\w$]*)\|\|!\3\.hidden\)\);/;
  if (!patchedAppPathShortcut) {
    nextSource = nextSource.replace(
      appPathShortcutPattern,
      (
        match,
        appTargetsVar,
        targetsVar,
        targetVar,
        availableSetVar,
        availableTargetsVar,
        modeVar,
        includeHiddenTargetsVar,
      ) => {
        patchedAppPathShortcut = true;
        return (
          `let ${appTargetsVar}=${targetsVar}.filter(${targetVar}=>${targetVar}.appPath!=null),` +
          `${availableSetVar}=new Set(${availableTargetsVar});` +
          `if(${appTargetsVar}.length>0)return ${targetsVar}.filter(${targetVar}=>` +
          `${targetVar}.appPath==null&&${targetVar}.kind===\`editor\`&&` +
          `${availableSetVar}.has(${targetVar}.target)&&(${includeHiddenTargetsVar}||!${targetVar}.hidden))` +
          `.concat(${appTargetsVar});` +
          `if(${modeVar}===\`native\`)return ${targetsVar}.filter(${targetVar}=>` +
          `${targetVar}.target===\`systemDefault\`||${targetVar}.target===\`fileManager\`||` +
          `${availableSetVar}.has(${targetVar}.target)&&(${includeHiddenTargetsVar}||!${targetVar}.hidden));`
        );
      },
    );
  }

  const hasOpenTargetSelectorShape =
    /function [A-Za-z_$][\w$]*\(\{targets:[A-Za-z_$][\w$]*,availableTargets:[A-Za-z_$][\w$]*,includeHiddenTargets:[A-Za-z_$][\w$]*=!1,mode:[A-Za-z_$][\w$]*=`editor`\}\)/.test(
      currentSource,
    );
  if (!patchedNativeMode && !patchedAppPathShortcut && hasOpenTargetSelectorShape) {
    warn("Could not find native Open In target selector — skipping native selection patch");
  }
  if (
    !patchedAppPathShortcut &&
    hasOpenTargetSelectorShape &&
    currentSource.includes("appPath!=null")
  ) {
    warn("Could not find native Open In appPath shortcut — skipping appPath selection patch");
  }
  return nextSource;
}

module.exports = {
  id: "linux-open-target-selection-native-mode",
  phase: "webview-asset",
  order: 1120,
  ciPolicy: "optional",
  pattern: /^(?:open-target-selection-.*|app-initial~app-main~.*)\.js$/,
  missingDescription: "Open In target selection bundle",
  skipDescription: "Linux Open In native target selection patch",
  apply: applyLinuxOpenTargetSelectionNativeModePatch,
  applyLinuxOpenTargetSelectionNativeModePatch,
};
