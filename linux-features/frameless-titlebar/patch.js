"use strict";

const WEBVIEW_MARKER = "/*codexLinuxFramelessTitlebarWebviewV1*/";

function applyFramelessTitlebarWebviewTransforms(source) {
  let patched = source.replace(
    /applicationMenu:Object\.freeze\(\{left:0,right:\d+\}\)/g,
    "applicationMenu:Object.freeze({left:0,right:0})",
  );
  patched = patched.replace(
    /codexLinuxUseWindowControlsSafeArea:![A-Za-z_$][\w$]*,side:`end`/g,
    "codexLinuxUseWindowControlsSafeArea:!1,side:`end`",
  );
  patched = patched.split("case`win32`:case`linux`:return`application-menu`")
    .join("case`win32`:return`application-menu`;case`linux`:return`native`");
  patched = patched.replace(
    /([A-Za-z_$][\w$]*)\.includes\(`win`\)\|\|([A-Za-z_$][\w$]*)\.includes\(`windows`\)\|\|\1\.includes\(`linux`\)\?([A-Za-z_$][\w$]*)\?\?([A-Za-z_$][\w$]*)\.applicationMenu:\4\.default/g,
    (_match, platform, ua, fallback, layout) =>
      `${platform}.includes(\`win\`)||${ua}.includes(\`windows\`)?${fallback}??${layout}.applicationMenu:${layout}.default`,
  );
  return patched;
}

function applyFramelessTitlebarWebviewPatch(source) {
  if (source.includes(WEBVIEW_MARKER)) return source;
  const patched = applyFramelessTitlebarWebviewTransforms(source);
  if (patched === source) {
    console.warn("WARN: Could not identify official frameless-titlebar webview surface");
    return source;
  }
  return `${WEBVIEW_MARKER}${patched}`;
}

module.exports = {
  descriptors: [
    {
      id: "webview-window-controls-layout",
      phase: "webview-asset",
      order: 20_730,
      ciPolicy: "optional",
      pattern: /^app-initial-[^.]+\.js$/,
      missingDescription: "main app chrome bundle",
      skipDescription: "frameless titlebar webview layout patch",
      apply: applyFramelessTitlebarWebviewPatch,
    },
  ],
  applyFramelessTitlebarWebviewPatch,
  applyFramelessTitlebarWebviewTransforms,
};
