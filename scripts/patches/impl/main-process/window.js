"use strict";

const {
  escapeRegExp,
  findMatchingBrace,
} = require("../../lib/minified-js.js");

const LINUX_TITLEBAR_OVERLAY_HEIGHT = 30;
const LINUX_TITLEBAR_OVERLAY_HELPER = "codexLinuxTitleBarOverlay";

function linuxTitlebarOverlayHelperSource(
  electronAlias,
  lightBackgroundAlias,
  lightSymbolAlias,
  darkSymbolAlias,
) {
  return `function ${LINUX_TITLEBAR_OVERLAY_HELPER}(e=1){return{color:${electronAlias}.nativeTheme.shouldUseDarkColors?\`#111111\`:${lightBackgroundAlias},symbolColor:${electronAlias}.nativeTheme.shouldUseDarkColors?${lightSymbolAlias}:${darkSymbolAlias},height:Math.round(${LINUX_TITLEBAR_OVERLAY_HEIGHT}*e)}}`;
}

function ensureLinuxTitlebarOverlayHelper(source, anchorText, helperSource) {
  if (source.includes(`function ${LINUX_TITLEBAR_OVERLAY_HELPER}(`)) {
    return source;
  }

  const anchorIndex = source.indexOf(anchorText);
  if (anchorIndex === -1) {
    return null;
  }

  return (
    source.slice(0, anchorIndex + anchorText.length) +
    helperSource +
    source.slice(anchorIndex + anchorText.length)
  );
}

// Main-process patches adapt Electron shell behavior: windows, tray, menu,
// single-instance handling, file manager integration, and packaged runtime glue.
function applyLinuxWindowOptionsPatch(currentSource, iconAsset) {
  let patchedSource = currentSource;

  if (iconAsset != null) {
    const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
    const iconPathNeedle = `icon:${iconPathExpression}`;
    const setIconNeedle = `setIcon(${iconPathExpression})`;
    const readyToShowSetIconInsertionPattern = /[A-Za-z_$][\w$]*\.once\(`ready-to-show`,\(\)=>\{/;

    const currentLinuxAutoHideMenuBarNeedle =
      "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},";
    const windowOptionsReplacement =
      `...process.platform===\`win32\`?{autoHideMenuBar:!0}:process.platform===\`linux\`?{${iconPathNeedle}}:{},`;

    if (patchedSource.includes(currentLinuxAutoHideMenuBarNeedle)) {
      patchedSource = patchedSource.split(currentLinuxAutoHideMenuBarNeedle).join(windowOptionsReplacement);
    } else if (
      !patchedSource.includes(iconPathNeedle) &&
      !patchedSource.includes(setIconNeedle) &&
      !readyToShowSetIconInsertionPattern.test(patchedSource)
    ) {
      console.warn("WARN: Could not find BrowserWindow autoHideMenuBar snippet — skipping window options patch");
    }
  }

  patchedSource = applyDefinedBrowserWindowOptionsPatch(patchedSource);
  patchedSource = applyLinuxPrimaryFocusablePatch(patchedSource);
  return patchedSource;
}

function applyDefinedBrowserWindowOptionsPatch(currentSource) {
  const browserWindowOptionsRegex =
    /show:([A-Za-z_$][\w$]*),parent:([A-Za-z_$][\w$]*),\.\.\.([A-Za-z_$][\w$]*)===void 0\?\{\}:\{focusable:\3\},(\.\.\.process\.platform===`win32`(?:\|\|process\.platform===`linux`)?\?\{autoHideMenuBar:!0\}(?::process\.platform===`linux`\?\{icon:process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\/[^`]+`\})?:\{\},)backgroundMaterial:([A-Za-z_$][\w$]*)\?\?void 0,\.\.\.([A-Za-z_$][\w$]*),minWidth:([A-Za-z_$][\w$]*)\?\.width,minHeight:\7\?\.height,webPreferences:([A-Za-z_$][\w$]*)/g;

  return currentSource.replace(
    browserWindowOptionsRegex,
    (
      _match,
      showAlias,
      parentAlias,
      focusableAlias,
      platformOptions,
      backgroundMaterialAlias,
      appearanceOptionsAlias,
      minimumSizeAlias,
      webPreferencesAlias,
    ) =>
      `show:${showAlias},...${parentAlias}===void 0?{}:{parent:${parentAlias}},...${focusableAlias}===void 0?{}:{focusable:${focusableAlias}},${platformOptions}...${backgroundMaterialAlias}==null?{}:{backgroundMaterial:${backgroundMaterialAlias}},...${appearanceOptionsAlias},...${minimumSizeAlias}==null?{}:{minWidth:${minimumSizeAlias}.width,minHeight:${minimumSizeAlias}.height},webPreferences:${webPreferencesAlias}`,
  );
}

function findCreateWindowAppearanceAlias(currentSource, matchIndex) {
  const prefix = currentSource.slice(Math.max(0, matchIndex - 3000), matchIndex);
  const createWindowRegex =
    /createWindow\([^)]*\)\{let\{[^}]*appearance:([A-Za-z_$][\w$]*)(?:=[^,}]+)?/g;
  let match;
  let appearanceAlias = null;
  while ((match = createWindowRegex.exec(prefix)) != null) {
    appearanceAlias = match[1];
  }
  return appearanceAlias;
}

function hasPrimaryBrowserWindowFocusableCandidate(currentSource) {
  return /createWindow\([^)]*\)\{let\{[^}]*appearance:[A-Za-z_$][\w$]*(?:=`primary`)?[^}]*\}=[\s\S]{0,3500}?new\s+[A-Za-z_$][\w$]*\.BrowserWindow\(\{[\s\S]{0,2000}?focusable:/.test(
    currentSource,
  );
}

function applyLinuxPrimaryFocusablePatch(currentSource) {
  if (
    currentSource.includes("===`primary`?{focusable:!0}")
  ) {
    return currentSource;
  }

  let patchedAny = false;
  let matchedAny = false;
  const focusableSpreadRegex =
    /\.\.\.([A-Za-z_$][\w$]*)===void 0\?\{\}:\{focusable:\1\},(\.\.\.process\.platform===`win32`(?:\|\|process\.platform===`linux`)?\?)/g;
  const patchedSource = currentSource.replace(
    focusableSpreadRegex,
    (match, focusableAlias, platformOptions, offset) => {
      matchedAny = true;
      const appearanceAlias = findCreateWindowAppearanceAlias(currentSource, offset);
      if (appearanceAlias == null) {
        return match;
      }
      patchedAny = true;
      return (
        `...process.platform===\`linux\`&&${appearanceAlias}===\`primary\`?{focusable:!0}:` +
        `${focusableAlias}===void 0?{}:{focusable:${focusableAlias}},${platformOptions}`
      );
    },
  );

  if (!patchedAny && matchedAny && hasPrimaryBrowserWindowFocusableCandidate(currentSource)) {
    throw new Error("Could not derive primary BrowserWindow appearance alias for Linux focusable patch");
  }

  if (!patchedAny && hasPrimaryBrowserWindowFocusableCandidate(currentSource)) {
    throw new Error("Could not patch primary BrowserWindow focusable option for Linux");
  }

  return patchedSource;
}

function findMinifiedMethod(source, signatureRegex) {
  const match = source.match(signatureRegex);
  if (match == null) {
    return null;
  }
  const openIndex = match.index + match[0].length - 1;
  const closeIndex = findMatchingBrace(source, openIndex);
  if (closeIndex === -1) {
    return null;
  }
  return {
    match,
    start: match.index,
    end: closeIndex + 1,
    text: source.slice(match.index, closeIndex + 1),
  };
}

function applyLinuxNativeTitlebarPatch(currentSource) {
  const helperFunctionRegex = new RegExp(
    'function ' +
      escapeRegExp(LINUX_TITLEBAR_OVERLAY_HELPER) +
      '\\([^)]*\\)\\{return\\{color:([A-Za-z_$][\\w$]*)\\.nativeTheme\\.shouldUseDarkColors\\?`#111111`:([A-Za-z_$][\\w$]*),symbolColor:\\1\\.nativeTheme\\.shouldUseDarkColors\\?([A-Za-z_$][\\w$]*):([A-Za-z_$][\\w$]*),height:Math\\.round\\(' +
      LINUX_TITLEBAR_OVERLAY_HEIGHT +
      '\\*[A-Za-z_$][\\w$]*\\)\\}\\}',
  );
  const primaryTitlebarRegex =
    /(case`quickChat`:case`primary`:return [^;]{0,2000}?([A-Za-z_$][\w$]*)===`win32`\|\|\2===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay:)([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/;
  const patchedPrimaryTitlebarRegex = new RegExp(
    `(case\`quickChat\`:case\`primary\`:return [^;]{0,2000}?titleBarOverlay:)([A-Za-z_$][\\w$]*)===\`linux\`\\?${escapeRegExp(LINUX_TITLEBAR_OVERLAY_HELPER)}\\(([A-Za-z_$][\\w$]*)\\):([A-Za-z_$][\\w$]*)\\(\\3\\)`,
  );
  const primaryTitlebarMatch = currentSource.match(primaryTitlebarRegex);
  const patchedPrimaryTitlebarMatch = currentSource.match(patchedPrimaryTitlebarRegex);
  if (primaryTitlebarMatch == null && patchedPrimaryTitlebarMatch == null) {
    console.warn("WARN: Could not find primary BrowserWindow titlebar snippet — skipping Linux native titlebar patch");
    return currentSource;
  }

  let patchedSource = currentSource;
  let electronAlias;
  if (primaryTitlebarMatch != null) {
    const [, titlebarPrefix, platformAlias, overlayHelperAlias, zoomAlias] = primaryTitlebarMatch;
    const overlayHelperRegex = new RegExp(
      `function ${escapeRegExp(overlayHelperAlias)}\\([^)]*\\)\\{return\\{color:[A-Za-z_$][\\w$]*,symbolColor:([A-Za-z_$][\\w$]*)\\.nativeTheme\\.shouldUseDarkColors\\?([A-Za-z_$][\\w$]*):([A-Za-z_$][\\w$]*),height:Math\\.round\\(([A-Za-z_$][\\w$]*)\\*[^)]*\\)\\}\\}`,
    );
    const overlayHelperMatch = currentSource.match(overlayHelperRegex);
    const linuxBackgroundMatch = currentSource.match(
      /===`linux`&&!([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\?\{backgroundColor:([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),backgroundMaterial:null\}/,
    );
    if (overlayHelperMatch == null || linuxBackgroundMatch == null) {
      console.warn("WARN: Could not derive titleBarOverlay aliases — skipping Linux native titlebar patch");
      return currentSource;
    }

    const [, currentElectronAlias, lightSymbolAlias, darkSymbolAlias] = overlayHelperMatch;
    const lightBackgroundAlias = linuxBackgroundMatch[4];
    electronAlias = currentElectronAlias;
    patchedSource = patchedSource.replace(
      primaryTitlebarRegex,
      `${titlebarPrefix}${platformAlias}===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(${zoomAlias}):${overlayHelperAlias}(${zoomAlias})`,
    );
    patchedSource = ensureLinuxTitlebarOverlayHelper(
      patchedSource,
      overlayHelperMatch[0],
      linuxTitlebarOverlayHelperSource(
        electronAlias,
        lightBackgroundAlias,
        lightSymbolAlias,
        darkSymbolAlias,
      ),
    );
    if (patchedSource == null) {
      console.warn("WARN: Could not insert Linux titleBarOverlay helper — skipping Linux native titlebar patch");
      return currentSource;
    }
  } else {
    const helperFunctionMatch = currentSource.match(helperFunctionRegex);
    if (helperFunctionMatch == null) {
      console.warn("WARN: Could not derive Linux titleBarOverlay helper aliases — skipping Linux native titlebar patch");
      return currentSource;
    }
    electronAlias = helperFunctionMatch[1];
  }

  const zoomOverlayRegex =
    /\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\1\.setTitleBarOverlay\(([A-Za-z_$][\w$]*)\(\2\)\)\)/g;
  patchedSource = patchedSource.replace(
    zoomOverlayRegex,
    (_match, windowAlias, zoomAlias, overlayHelperAlias) =>
      `(process.platform===\`win32\`||process.platform===\`linux\`)&&(this.windowZooms.set(${windowAlias}.id,${zoomAlias}),${windowAlias}.setTitleBarOverlay(process.platform===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(${zoomAlias}):${overlayHelperAlias}(${zoomAlias})))`,
  );

  const overlaySyncMethod = findMinifiedMethod(
    patchedSource,
    /install[A-Za-z_$][\w$]*TitleBarOverlaySync\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{/,
  );
  if (overlaySyncMethod == null) {
    return patchedSource;
  }
  if (overlaySyncMethod.text.includes(`setTitleBarOverlay(process.platform===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(`)) {
    return patchedSource;
  }

  const windowAlias = overlaySyncMethod.match[1];
  const overlayCallRegex = new RegExp(
    `${escapeRegExp(windowAlias)}\\.setTitleBarOverlay\\(([A-Za-z_$][\\w$]*)\\(this\\.windowZooms\\.get\\(${escapeRegExp(windowAlias)}\\.id\\)\\)\\)`,
  );
  const overlayCallMatch = overlaySyncMethod.text.match(overlayCallRegex);
  if (overlayCallMatch == null) {
    console.warn("WARN: Could not patch titleBarOverlay nativeTheme sync for Linux");
    return patchedSource;
  }

  const windowsOverlayHelperAlias = overlayCallMatch[1];
  const patchedMethod = overlaySyncMethod.text.replace(
    overlayCallRegex,
    `${windowAlias}.setTitleBarOverlay(process.platform===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(this.windowZooms.get(${windowAlias}.id)):${windowsOverlayHelperAlias}(this.windowZooms.get(${windowAlias}.id)))`,
  );
  return (
    patchedSource.slice(0, overlaySyncMethod.start) +
    patchedMethod +
    patchedSource.slice(overlaySyncMethod.end)
  );
}

function applyLinuxMenuPatch(currentSource) {
  const menuRegex = /process\.platform===`win32`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),/g;
  let patchedSource = currentSource
    .replace(
      /process\.platform===`linux`&&\(([A-Za-z_$][\w$]*)\.setMenuBarVisibility\(!1\),\1\.removeMenu\?\.\(\)\),process\.platform===`win32`&&\1\.removeMenu\(\),/g,
      (_match, windowVar) => `process.platform===\`linux\`&&${windowVar}.removeMenu(),process.platform===\`win32\`&&${windowVar}.removeMenu(),`,
    )
    .replace(
      /process\.platform===`linux`&&([A-Za-z_$][\w$]*)\.setMenuBarVisibility\(!1\),process\.platform===`win32`&&\1\.removeMenu\(\),/g,
      (_match, windowVar) => `process.platform===\`linux\`&&${windowVar}.removeMenu(),process.platform===\`win32\`&&${windowVar}.removeMenu(),`,
    );
  let patchedAny = patchedSource !== currentSource;
  patchedSource = patchedSource.replace(menuRegex, (match, windowVar, offset, source) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.removeMenu(),`;
    if (source.slice(Math.max(0, offset - linuxPatch.length), offset) === linuxPatch) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  const hasWindowsRemoveMenu = /process\.platform===`win32`&&[A-Za-z_$][\w$]*\.removeMenu\(\),/.test(patchedSource);
  const hasLinuxRemoveMenu = /process\.platform===`linux`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),process\.platform===`win32`&&\1\.removeMenu\(\),/.test(patchedSource);
  if (!patchedAny && hasWindowsRemoveMenu && !hasLinuxRemoveMenu) {
    console.warn("WARN: Could not find window menu visibility snippet — skipping menu patch");
  }

  return patchedSource;
}

function applyLinuxApplicationMenuPatch(currentSource) {
  return currentSource.replace(
    /([A-Za-z_$][\w$]*)\.Menu\.setApplicationMenu\(process\.platform===`linux`\?null:([A-Za-z_$][\w$]*)\)/g,
    (_match, electronAlias, menuAlias) => `${electronAlias}.Menu.setApplicationMenu(${menuAlias})`,
  );
}

function applyLinuxSetIconPatch(currentSource, iconAsset) {
  if (iconAsset == null) {
    return currentSource;
  }

  const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
  const readyRegex = /([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(readyRegex, (match, windowVar, offset) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.setIcon(${iconPathExpression}),`;
    const prefix = currentSource.slice(Math.max(0, offset - Math.max(400, linuxPatch.length * 2)), offset);
    if (prefix.includes(linuxPatch)) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  if (patchedAny) {
    return patchedSource;
  }

  if (currentSource.includes(`setIcon(${iconPathExpression})`)) {
    return currentSource;
  }

  console.warn("WARN: Could not find window setIcon insertion point — skipping setIcon patch");
  return currentSource;
}

function applyLinuxReadyToShowWindowStatePatch(currentSource) {
  const alreadyPatchedRegex =
    /[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\.once\(`ready-to-show`,\(\)=>\{[A-Za-z_$][\w$]*\.isDestroyed\(\)\|\|[A-Za-z_$][\w$]*\.maximize\(\)\}\)/;
  if (alreadyPatchedRegex.test(currentSource)) {
    return currentSource;
  }

  const readyToShowMaximizeRegex =
    /([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{\1\.isDestroyed\(\)\|\|\1\.maximize\(\)\}\)/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(readyToShowMaximizeRegex, (_match, windowVar, offset, source) => {
    const prefix = source.slice(Math.max(0, offset - 120), offset);
    const maximizedStateMatch = prefix.match(/([A-Za-z_$][\w$]*)&&process\.platform===`linux`&&[A-Za-z_$][\w$]*\.setIcon\(/);
    const maximizedStateVar = maximizedStateMatch?.[1] ?? "false";
    patchedAny = true;
    return `${maximizedStateVar}&&${windowVar}.once(\`ready-to-show\`,()=>{${windowVar}.isDestroyed()||${windowVar}.maximize()})`;
  });

  if (patchedAny) {
    return patchedSource;
  }

  if (currentSource.includes("ready-to-show") && currentSource.includes(".maximize()")) {
    console.warn("WARN: Could not find ready-to-show maximize hook — skipping Linux window-state patch");
  }

  return currentSource;
}

function applyLinuxResizeRepaintPatch(currentSource) {
  const helperName = "codexLinuxInstallResizeRepaintHook";
  const helper =
    "function codexLinuxInstallResizeRepaintHook(e){if(!(process.platform===`linux`)||e.__codexLinuxResizeRepaintHookInstalled)return;e.__codexLinuxResizeRepaintHookInstalled=!0;let __codexResizeRepaintScheduled=!1,__codexResizeRepaint=()=>{__codexResizeRepaintScheduled||(__codexResizeRepaintScheduled=!0,setTimeout(()=>{if(__codexResizeRepaintScheduled=!1,e.isDestroyed())return;let __codexWebContents=e.webContents;__codexWebContents==null||__codexWebContents.isDestroyed?.()||typeof __codexWebContents.invalidate==`function`&&__codexWebContents.invalidate()},16))};e.on(`resize`,__codexResizeRepaint),e.on(`resized`,__codexResizeRepaint)}";
  const readyToShowRegex =
    /(^|[^A-Za-z0-9_$])((?:[A-Za-z_$][\w$]*&&)?)([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(
    readyToShowRegex,
    (match, leading, guardPrefix, windowVar, offset, source) => {
      const linuxPatch = `process.platform===\`linux\`&&${helperName}(${windowVar}),`;
      const insertionPoint = offset + leading.length;
      const prefix = source.slice(Math.max(0, insertionPoint - Math.max(400, linuxPatch.length * 2)), insertionPoint);
      if (prefix.includes(linuxPatch)) {
        return match;
      }
      patchedAny = true;
      return `${leading}${linuxPatch}${guardPrefix}${windowVar}.once(\`ready-to-show\`,()=>{`;
    },
  );

  if (!patchedAny) {
    if (currentSource.includes(`${helperName}(`)) {
      return currentSource;
    }
    if (currentSource.includes("ready-to-show")) {
      console.warn("WARN: Could not find ready-to-show hook — skipping Linux resize repaint patch");
    }
    return currentSource;
  }

  if (patchedSource.includes(`function ${helperName}(`)) {
    return patchedSource;
  }

  for (const prefix of ['"use strict";', "'use strict';"]) {
    if (patchedSource.startsWith(prefix)) {
      return `${prefix}${helper}${patchedSource.slice(prefix.length)}`;
    }
  }

  return `${helper}${patchedSource}`;
}

function applyLinuxOpaqueBackgroundPatch(currentSource) {
  let patchedSource = currentSource;
  const shouldAlwaysOpaqueSurfaceRegex =
    /shouldAlwaysUseOpaqueWindowSurface\(([A-Za-z_$][\w$]*)\)\{return\s*([A-Za-z_$][\w$]*)\(\{appearance:\1,opaqueWindowsEnabled:this\.isOpaqueWindowsEnabled\(\),platform:process\.platform\}\)\|\|!([A-Za-z_$][\w$]*)\(\)&&!([A-Za-z_$][\w$]*)\(\1\)\}/u;
  const shouldAlwaysOpaqueSurfaceMatch = patchedSource.match(shouldAlwaysOpaqueSurfaceRegex);
  if (shouldAlwaysOpaqueSurfaceMatch != null) {
    const [
      match,
      appearanceParam,
      opaqueSurfaceHelper,
      nativeSurfaceCapabilityHelper,
      transparentAppearancePredicate,
    ] = shouldAlwaysOpaqueSurfaceMatch;
    const replacement =
      `shouldAlwaysUseOpaqueWindowSurface(${appearanceParam}){return process.platform===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})||${opaqueSurfaceHelper}({appearance:${appearanceParam},opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!${nativeSurfaceCapabilityHelper}()&&!${transparentAppearancePredicate}(${appearanceParam})}`;
    patchedSource = patchedSource.replace(match, replacement);
  } else if (
    /shouldAlwaysUseOpaqueWindowSurface\([A-Za-z_$][\w$]*\)\{return\s*process\.platform===`linux`&&!/.test(patchedSource)
  ) {
    // Already patched.
  } else if (patchedSource.includes("shouldAlwaysUseOpaqueWindowSurface(")) {
    console.warn("WARN: Could not find opaque surface mode predicate — skipping Linux opaque surface patch");
  }

  if (
    patchedSource.includes("===`linux`&&!OM(") ||
    /===`linux`&&![A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\?\{backgroundColor:[^{}]+,backgroundMaterial:null\}/.test(patchedSource)
  ) {
    return patchedSource;
  }

  const colorConstRegex =
    /([A-Za-z_$][\w$]*)=`#00000000`,([A-Za-z_$][\w$]*)=`#000000`,([A-Za-z_$][\w$]*)=`#f9f9f9`/;
  const colorMatch = patchedSource.match(colorConstRegex);

  if (!colorMatch) {
    console.warn(
      "WARN: Could not find color constants (#00000000, #000000, #f9f9f9) — skipping background patch",
    );
    return patchedSource;
  }

  const [, transparentVar, darkVar, lightVar] = colorMatch;

  const currentFuncParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowsEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\3&&!([A-Za-z_$][\w$]*)\(\2\)&&\(\1===`darwin`\|\|\1===`win32`\)\?/;
  const currentFuncMatch = patchedSource.match(currentFuncParamRegex);
  if (currentFuncMatch != null) {
    const [, platformParam, appearanceParam, , darkColorsParam, transparentAppearancePredicate] =
      currentFuncMatch;
    const win32Needle =
      `:${platformParam}===\`win32\`&&!${transparentAppearancePredicate}(${appearanceParam})?`;
    const linuxBgPrefix =
      `:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:`;

    if (patchedSource.includes(linuxBgPrefix)) {
      return patchedSource;
    }
    if (patchedSource.includes(win32Needle)) {
      return patchedSource.replace(win32Needle, `${linuxBgPrefix}${win32Needle.slice(1)}`);
    }

    console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
    return patchedSource;
  }

  const currentSurfaceFuncParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowSurfaceEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\3\?\{backgroundColor:\4\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),backgroundMaterial:\1===`win32`\?`none`:null\}:\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)\?/;
  const currentSurfaceFuncMatch = patchedSource.match(currentSurfaceFuncParamRegex);
  if (currentSurfaceFuncMatch != null) {
    const [, platformParam, appearanceParam, , darkColorsParam, darkVarFromReturn, lightVarFromReturn, transparentAppearancePredicate] =
      currentSurfaceFuncMatch;
    const win32Needle =
      `:${platformParam}===\`win32\`&&!${transparentAppearancePredicate}(${appearanceParam})?`;
    const linuxBgPrefix =
      `:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVarFromReturn}:${lightVarFromReturn},backgroundMaterial:null}:`;

    if (patchedSource.includes(linuxBgPrefix)) {
      return patchedSource;
    }
    if (patchedSource.includes(win32Needle)) {
      return patchedSource.replace(win32Needle, `${linuxBgPrefix}${win32Needle.slice(1)}`);
    }

    console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
    return patchedSource;
  }

  const funcParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowsEnabled:[A-Za-z_$][\w$]*,prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)/;
  const funcMatch = patchedSource.match(funcParamRegex);

  if (funcMatch == null) {
    console.warn("WARN: Could not find BrowserWindow background function signature — skipping background patch");
    return patchedSource;
  }

  const [, platformParam, appearanceParam, darkColorsParam, transparentAppearancePredicate] =
    funcMatch;
  const bgNeedle =
    `backgroundMaterial:\`mica\`}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const oldLinuxBgPatch =
    `backgroundMaterial:\`mica\`}:process.platform===\`linux\`?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const bgReplacement =
    `backgroundMaterial:\`mica\`}:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;

  if (patchedSource.includes(bgNeedle)) {
    return patchedSource.replace(bgNeedle, bgReplacement);
  }
  if (patchedSource.includes(oldLinuxBgPatch)) {
    return patchedSource.replace(oldLinuxBgPatch, bgReplacement);
  }

  console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
  return patchedSource;
}

function applyLinuxAboutDialogPatch(currentSource, iconPathExpression) {
  if (!currentSource.includes("codex.aboutDialog.title")) {
    return currentSource;
  }

  const alreadyUsesBundledIcon =
    iconPathExpression != null &&
    currentSource.includes(`nativeImage.createFromPath(${iconPathExpression})`);
  const aboutHtmlIconNullSafeRegex =
    /[A-Za-z_$][\w$]*==null\|\|([A-Za-z_$][\w$]*)\.isEmpty\(\)\?null:\1\.resize\(/;
  const aboutWindowIconNullSafeRegex =
    /\.\.\.([A-Za-z_$][\w$]*)\.windowIcon==null\|\|\1\.windowIcon\.isEmpty\(\)\?\{\}:\{icon:\1\.windowIcon\}/;
  const alreadyNullSafe =
    aboutWindowIconNullSafeRegex.test(currentSource) &&
    aboutHtmlIconNullSafeRegex.test(currentSource) &&
    /windowIcon:[A-Za-z_$][\w$]*\?\?null\}/.test(currentSource);
  if (alreadyUsesBundledIcon && alreadyNullSafe) {
    return currentSource;
  }

  let patchedSource = currentSource;
  if (iconPathExpression != null) {
    const aboutIconPromiseRegex =
      /\[([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*)\(([^()]+)\):null,([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:process\.platform===`win32`\?`large`:`normal`\}\)\]/;
    patchedSource = patchedSource.replace(
      aboutIconPromiseRegex,
      `[
process.platform===\`linux\`?null:$1?$2($3):null,
process.platform===\`linux\`?Promise.resolve((()=>{let __codexLinuxAboutIcon=$4.nativeImage.createFromPath(${iconPathExpression});return __codexLinuxAboutIcon.isEmpty()?null:__codexLinuxAboutIcon})()):$4.app.getFileIcon($5,{size:process.platform===\`win32\`?\`large\`:\`normal\`}).catch(()=>null)
]`,
    );
    if (patchedSource === currentSource) {
      // 26.623 reshaped the about icon promise array: the non-win32 size
      // ternary collapsed to {size:`normal`} and a win32 nativeImage branch was
      // added — [t?k_(i):null,n?a.nativeImage.createFromPath(i):a.app.getFileIcon(i,{size:`normal`})].
      // Without this branch the Linux-safe icon (and the .catch on getFileIcon)
      // never apply, so a getFileIcon rejection on Linux makes the About window
      // builder throw before its try/catch and the dialog never opens.
      const aboutIconPromiseRegex26623 =
        /\[([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*)\(([^()]+)\):null,([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*)\.nativeImage\.createFromPath\(([^()]+)\):([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:`normal`\}\)\]/;
      patchedSource = patchedSource.replace(
        aboutIconPromiseRegex26623,
        `[
process.platform===\`linux\`?null:$1?$2($3):null,
process.platform===\`linux\`?Promise.resolve((()=>{let __codexLinuxAboutIcon=$5.nativeImage.createFromPath(${iconPathExpression});return __codexLinuxAboutIcon.isEmpty()?null:__codexLinuxAboutIcon})()):$4?$5.nativeImage.createFromPath($6):$7.app.getFileIcon($8,{size:\`normal\`}).catch(()=>null)
]`,
      );
    }
  } else {
    const patchedGetFileIconRegex =
      /([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:process\.platform===`win32`\?`large`:`normal`\}\)\.catch\(\(\)=>null\)/;
    if (!patchedGetFileIconRegex.test(patchedSource)) {
      const getFileIconRegex =
        /([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:process\.platform===`win32`\?`large`:`normal`\}\)/;
      patchedSource = patchedSource.replace(
        getFileIconRegex,
        "$1.app.getFileIcon($2,{size:process.platform===`win32`?`large`:`normal`}).catch(()=>null)",
      );
    }
    if (patchedSource === currentSource) {
      // 26.623 fallback (no bundled icon): just make the reshaped getFileIcon
      // call rejection-proof so the About window builder cannot throw on Linux.
      const patchedGetFileIconRegex26623 =
        /([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:`normal`\}\)\.catch\(\(\)=>null\)/;
      if (!patchedGetFileIconRegex26623.test(patchedSource)) {
        const getFileIconRegex26623 =
          /([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:`normal`\}\)/;
        patchedSource = patchedSource.replace(
          getFileIconRegex26623,
          "$1.app.getFileIcon($2,{size:`normal`}).catch(()=>null)",
        );
      }
    }
  }

  patchedSource = patchedSource
    .replace(
      /([A-Za-z_$][\w$]*)\.isEmpty\(\)\?null:\1\.resize\(/g,
      "$1==null||$1.isEmpty()?null:$1.resize(",
    )
    .replace(/windowIcon:([A-Za-z_$][\w$]*)\}/g, "windowIcon:$1??null}")
    .replace(
      /\.\.\.([A-Za-z_$][\w$]*)\.windowIcon\.isEmpty\(\)\?\{\}:\{icon:\1\.windowIcon\}/g,
      "...$1.windowIcon==null||$1.windowIcon.isEmpty()?{}:{icon:$1.windowIcon}",
    );

  if (patchedSource !== currentSource) {
    return patchedSource;
  }

  console.warn("WARN: Could not patch About dialog icon fallback for Linux");
  return currentSource;
}

module.exports = {
  applyLinuxAboutDialogPatch,
  applyLinuxApplicationMenuPatch,
  applyLinuxMenuPatch,
  applyLinuxNativeTitlebarPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxResizeRepaintPatch,
  applyLinuxSetIconPatch,
  applyLinuxWindowOptionsPatch,
};
