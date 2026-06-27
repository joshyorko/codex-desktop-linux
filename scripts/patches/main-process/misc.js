"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  findCallBlock,
  requireName,
} = require("../shared.js");

function applyLinuxFileManagerPatch(currentSource) {
  const block = findCallBlock(currentSource, "id:`fileManager`");
  if (block == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  if (block.text.includes("linux:{")) {
    return currentSource;
  }

  const electronVar = requireName(currentSource, "electron");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (electronVar == null || fsVar == null || pathVar == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const insertionPoint = block.text.lastIndexOf("}});");
  if (insertionPoint === -1) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const linuxFileManager =
    `,linux:{label:\`File Manager\`,icon:\`apps/file-explorer.png\`,detect:()=>\`linux-file-manager\`,args:e=>[e],open:async({path:e})=>{let __codexResolved=e;for(;;){if((0,${fsVar}.existsSync)(__codexResolved))break;let __codexParent=(0,${pathVar}.dirname)(__codexResolved);if(__codexParent===__codexResolved){__codexResolved=null;break}__codexResolved=__codexParent}let __codexOpenTarget=__codexResolved??e;if((0,${fsVar}.existsSync)(__codexOpenTarget)&&(0,${fsVar}.statSync)(__codexOpenTarget).isFile())__codexOpenTarget=(0,${pathVar}.dirname)(__codexOpenTarget);let __codexError=await ${electronVar}.shell.openPath(__codexOpenTarget);if(__codexError)throw Error(__codexError)}}`;

  const patchedBlock =
    block.text.slice(0, insertionPoint + 1) +
    linuxFileManager +
    block.text.slice(insertionPoint + 1);
  const patchedSource =
    currentSource.slice(0, block.start) + patchedBlock + currentSource.slice(block.end);

  const patchedBlockCheck = patchedSource.slice(block.start, block.start + patchedBlock.length);
  if (
    !patchedBlockCheck.includes("linux:{label:`File Manager`") ||
    !patchedBlockCheck.includes("detect:()=>`linux-file-manager`") ||
    !patchedBlockCheck.includes(`${electronVar}.shell.openPath(__codexOpenTarget)`)
  ) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  return patchedSource;
}

function applyLinuxWorkerFileManagerPatch(currentSource) {
  const block = findCallBlock(currentSource, "id:`fileManager`");
  if (block == null) {
    console.warn("Failed to apply Linux Worker File Manager Patch");
    return applyLinuxWorkerOpenTargetFallbackPatch(currentSource);
  }

  if (block.text.includes("linux:{")) {
    return applyLinuxWorkerOpenTargetFallbackPatch(currentSource);
  }

  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (fsVar == null || pathVar == null) {
    console.warn("Failed to apply Linux Worker File Manager Patch");
    return currentSource;
  }

  const insertionPoint = block.text.lastIndexOf("}});");
  if (insertionPoint === -1) {
    console.warn("Failed to apply Linux Worker File Manager Patch");
    return currentSource;
  }

  const linuxFileManager =
    `,linux:{label:\`File Manager\`,icon:\`apps/file-explorer.png\`,detect:()=>\`linux-file-manager\`,args:e=>[e],open:async({path:e})=>{let t=e;for(;;){try{if(${fsVar}.existsSync(t))break}catch{}let e=${pathVar}.dirname(t);if(e===t)break;t=e}try{${fsVar}.existsSync(t)&&${fsVar}.statSync(t).isFile()&&(t=${pathVar}.dirname(t))}catch{}let i=await(await import(\`electron\`)).shell.openPath(t);if(i)throw Error(i)}}`;

  const patchedBlock =
    block.text.slice(0, insertionPoint + 1) +
    linuxFileManager +
    block.text.slice(insertionPoint + 1);
  const patchedSource =
    currentSource.slice(0, block.start) + patchedBlock + currentSource.slice(block.end);

  const patchedBlockCheck = patchedSource.slice(block.start, block.start + patchedBlock.length);
  if (
    !patchedBlockCheck.includes("linux:{label:`File Manager`") ||
    !patchedBlockCheck.includes("detect:()=>`linux-file-manager`") ||
    !patchedBlockCheck.includes("import(`electron`)).shell.openPath(t)")
  ) {
    console.warn("Failed to apply Linux Worker File Manager Patch");
    return currentSource;
  }

  return applyLinuxWorkerOpenTargetFallbackPatch(patchedSource);
}

function applyLinuxWorkerOpenTargetFallbackPatch(currentSource) {
  if (currentSource.includes("function codexLinuxWorkerOpenTargetFallback(")) {
    return currentSource;
  }

  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (fsVar == null || pathVar == null) {
    return currentSource;
  }

  const registryLookupPattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.get\(\2\);if\(\3==null\)throw Error\(`Unknown open target "\$\{\2\}"`\);return \3\}/;
  const match = currentSource.match(registryLookupPattern);
  if (match == null) {
    return currentSource;
  }

  const [, lookupFn, targetVar, targetConfigVar, registryVar] = match;
  const helper =
    `function codexLinuxWorkerOpenTargetDirs(){if(process.platform!==\`linux\`)return[];let e=process.env.HOME||\`/nonexistent\`,t=[];for(let e of [process.env.HOMEBREW_PREFIX,process.env.LINUXBREW_PREFIX])e&&${pathVar}.isAbsolute(e)&&t.push(${pathVar}.join(e,\`bin\`));for(let e of (process.env.PATH||\`\`).split(\`:\`))e&&${pathVar}.isAbsolute(e)&&t.push(e);t.push(${pathVar}.join(e,\`.local/bin\`),${pathVar}.join(e,\`bin\`),${pathVar}.join(e,\`.linuxbrew/bin\`),${pathVar}.join(e,\`.local/share/JetBrains/Toolbox/scripts\`),${pathVar}.join(e,\`.local/share/flatpak/exports/bin\`),\`/home/linuxbrew/.linuxbrew/bin\`,\`/var/home/linuxbrew/.linuxbrew/bin\`);let n=new Set;return t.filter(e=>e&&${pathVar}.isAbsolute(e)&&!n.has(e)&&(n.add(e),!0))}` +
    `function codexLinuxWorkerFindExecutable(e){if(process.platform!==\`linux\`||!e)return null;for(let t of codexLinuxWorkerOpenTargetDirs()){let n=${pathVar}.join(t,e);try{if(${fsVar}.existsSync(n)&&${fsVar}.statSync(n).isFile())try{${fsVar}.accessSync(n,${fsVar}.constants?.X_OK??1);return n}catch{}}catch{}}return null}` +
    `function codexLinuxWorkerFirstExecutable(e){for(let t of e){let e=codexLinuxWorkerFindExecutable(t);if(e)return e}return null}` +
    `function codexLinuxWorkerTerminalCommand(){return codexLinuxWorkerFirstExecutable([\`x-terminal-emulator\`,\`gnome-terminal\`,\`kgx\`,\`konsole\`,\`xfce4-terminal\`,\`mate-terminal\`,\`lxterminal\`,\`tilix\`,\`alacritty\`,\`kitty\`,\`ghostty\`,\`wezterm\`,\`foot\`,\`terminology\`,\`xterm\`])}` +
    `function codexLinuxWorkerOpenTargetFallback(e){if(process.platform!==\`linux\`||typeof e!==\`string\`)return null;let t={vscode:[\`VS Code\`,\`apps/vscode.png\`,\`editor\`,[\`code\`]],vscodeInsiders:[\`VS Code Insiders\`,\`apps/vscode-insiders.png\`,\`editor\`,[\`code-insiders\`]],zed:[\`Zed\`,\`apps/zed.png\`,\`editor\`,[\`zed\`]],antigravity:[\`Antigravity\`,\`apps/antigravity.png\`,\`editor\`,[\`antigravity\`]]}[e];if(t){let[n,r,i,a]=t;return{id:e,label:n,icon:r,kind:i,detect:()=>codexLinuxWorkerFirstExecutable(a),args:e=>[e],supportsSsh:!0}}if(e===\`terminal\`)return{id:e,label:\`Terminal\`,icon:\`apps/terminal.png\`,kind:\`terminal\`,detect:()=>codexLinuxWorkerTerminalCommand(),args:e=>[e]};if(e.startsWith(\`linux-desktop-\`))return{id:e,label:\`Linux desktop app\`,icon:\`apps/vscode.png\`,kind:\`editor\`,detect:()=>e,args:e=>[e]};return null}`;
  const replacement =
    `${helper}function ${lookupFn}(${targetVar}){let ${targetConfigVar}=${registryVar}.get(${targetVar})??codexLinuxWorkerOpenTargetFallback(${targetVar});if(${targetConfigVar}==null)throw Error(\`Unknown open target "\${${targetVar}}"\`);return ${targetConfigVar}}`;

  return currentSource.replace(registryLookupPattern, replacement);
}

function patchLinuxWorkerFileManagerTarget(extractedDir) {
  const workerPath = path.join(extractedDir, ".vite", "build", "worker.js");
  if (!fs.existsSync(workerPath)) {
    console.warn(
      `WARN: Could not find worker bundle at ${workerPath} — skipping Linux Worker File Manager Patch`,
    );
    return { matched: 0, changed: 0, reason: "worker bundle not found" };
  }

  const source = fs.readFileSync(workerPath, "utf8");
  const patchedSource = applyLinuxWorkerFileManagerPatch(source);
  if (patchedSource === source) {
    const hasTarget = source.includes("id:`fileManager`");
    const hasLinuxTarget = source.includes("linux:{label:`File Manager`");
    const hasPatchableBlock = findCallBlock(source, "id:`fileManager`") != null;
    return {
      matched: hasPatchableBlock ? 1 : 0,
      changed: 0,
      reason: !hasTarget
        ? "fileManager target not found"
        : hasLinuxTarget
          ? null
          : hasPatchableBlock
            ? "fileManager target found but Linux worker patch was not applied"
            : "fileManager target found but patchable block not found",
    };
  }
  fs.writeFileSync(workerPath, patchedSource, "utf8");
  return { matched: 1, changed: 1 };
}

function applyLinuxGitOriginsSourceFallbackPatch(currentSource) {
  const fallbackSource = "linux_git_origins_missing_source_fallback";
  if (currentSource.includes(`source:\`${fallbackSource}\`,requestKind:`)) {
    return currentSource;
  }

  const dynamicRegex =
    /if\(([A-Za-z_$][\w$]*)==null\)\{if\(([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\)throw Error\(`Missing git operation source for \$\{\4\}`\);return ([A-Za-z_$][\w$]*)\(\)\}return ([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\{source:\1,requestKind:\4\},\5\)/;
  const dynamicMatch = currentSource.match(dynamicRegex);
  if (dynamicMatch != null) {
    const [, sourceVar, gitGuardVar, guardFn, requestKindVar, callVar, operationContextVar, operationContextFn] = dynamicMatch;
    return currentSource.replace(
      dynamicRegex,
      `if(${sourceVar}==null){if(${gitGuardVar}.${guardFn}(${requestKindVar})){if(${requestKindVar}===\`git-origins\`)return ${operationContextVar}.${operationContextFn}({source:\`${fallbackSource}\`,requestKind:${requestKindVar}},${callVar});throw Error(\`Missing git operation source for \${${requestKindVar}}\`)}return ${callVar}()}return ${operationContextVar}.${operationContextFn}({source:${sourceVar},requestKind:${requestKindVar}},${callVar})`,
    );
  }

  if (
    currentSource.includes("Missing git operation source for") &&
    currentSource.includes("\"git-origins\":")
  ) {
    console.warn("WARN: Could not find git operation source guard — skipping git-origins fallback patch");
  }

  return currentSource;
}

function applyLinuxOwlFeatureBindingFallbackPatch(currentSource) {
  if (!currentSource.includes("electron_common_owl_features")) {
    return currentSource;
  }

  const alreadyPatchedRegex =
    /function [A-Za-z_$][\w$]*\(\)\{let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \1!=`function`\)return \{isOwlFeatureEnabled:\(\)=>!1\};try\{return [A-Za-z_$][\w$]*\.parse\(\1\.call\(process,`electron_common_owl_features`\)\)\}catch\(([A-Za-z_$][\w$]*)\)\{if\(String\(\2\?\.message\?\?\2\)\.includes\(`No such binding was linked`\)\)return \{isOwlFeatureEnabled:\(\)=>!1\};throw \2\}\}/u;
  if (alreadyPatchedRegex.test(currentSource)) {
    return currentSource;
  }

  const loaderRegex =
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \2!=`function`\)throw Error\(`Owl feature binding is unavailable`\);return ([A-Za-z_$][\w$]*)\.parse\(\2\.call\(process,`electron_common_owl_features`\)\)\}/u;
  const match = currentSource.match(loaderRegex);
  if (match == null) {
    // 26.623+ rewrote the loader to natively return null when the binding is
    // unavailable (`process._linkedBinding` missing) and to swallow the
    // "No such binding was linked" error — exactly the Linux fallback this
    // patch injected. When that native-safe shape is present there is nothing
    // to patch, so stand down silently instead of failing the required patch.
    const upstreamReturnsNullOnMissingBinding =
      /let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \1!=`function`\)return null;/u.test(
        currentSource,
      );
    if (
      upstreamReturnsNullOnMissingBinding &&
      currentSource.includes("No such binding was linked:")
    ) {
      return currentSource;
    }
    console.warn(
      "WARN: Could not find Owl feature binding loader - skipping Linux Owl feature fallback patch",
    );
    return currentSource;
  }

  const [, fnName, linkedBindingVar, schemaVar] = match;
  const fallback = "{isOwlFeatureEnabled:()=>!1}";
  return currentSource.replace(
    loaderRegex,
    `function ${fnName}(){let ${linkedBindingVar}=process._linkedBinding;if(typeof ${linkedBindingVar}!=\`function\`)return ${fallback};try{return ${schemaVar}.parse(${linkedBindingVar}.call(process,\`electron_common_owl_features\`))}catch(t){if(String(t?.message??t).includes(\`No such binding was linked\`))return ${fallback};throw t}}`,
  );
}

function patchLinuxOwlFeatureBindingFallbackAssets(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    return { matched: 0, changed: 0 };
  }

  const candidates = fs
    .readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(buildDir, name))
    .filter((candidate) => {
      try {
        return fs.readFileSync(candidate, "utf8").includes("electron_common_owl_features");
      } catch {
        return false;
      }
    });

  let changed = 0;
  const pendingWrites = [];
  for (const candidate of candidates) {
    const currentSource = fs.readFileSync(candidate, "utf8");
    const patchedSource = applyLinuxOwlFeatureBindingFallbackPatch(currentSource);
    if (patchedSource !== currentSource) {
      changed += 1;
      pendingWrites.push({ filePath: candidate, patchedSource });
    }
  }
  for (const { filePath, patchedSource } of pendingWrites) {
    fs.writeFileSync(filePath, patchedSource, "utf8");
  }

  return { matched: candidates.length, changed };
}

function applyLinuxRemoteControlConfigPreservationPatch(currentSource) {
  const removedLog = "Removed remote_control from config before app-server start";
  const failedLog = "Failed to remove remote_control before app-server start";
  const stripperGuardRegex =
    /async function [A-Za-z_$][\w$]*\(\{codexHome:[A-Za-z_$][\w$]*,hostConfig:([A-Za-z_$][\w$]*),logger:[A-Za-z_$][\w$]*=[^}]*\}\)\{if\(\1\.kind===`local`\)try\{/gu;
  const patchedSource = currentSource.replace(stripperGuardRegex, (needle, hostConfigVar) =>
    needle.replace(
      `if(${hostConfigVar}.kind===\`local\`)try{`,
      `if(${hostConfigVar}.kind===\`local\`&&process.platform!==\`linux\`)try{`,
    ),
  );
  if (patchedSource !== currentSource) {
    return patchedSource;
  }

  const alreadyPatchedRegex =
    /async function [A-Za-z_$][\w$]*\(\{codexHome:[A-Za-z_$][\w$]*,hostConfig:([A-Za-z_$][\w$]*),logger:[A-Za-z_$][\w$]*=[^}]*\}\)\{if\(\1\.kind===`local`&&process\.platform!==`linux`\)try\{/u;
  if (alreadyPatchedRegex.test(currentSource)) {
    return currentSource;
  }

  if (!currentSource.includes(removedLog) && !currentSource.includes(failedLog)) {
    return currentSource;
  }

  console.warn(
    "WARN: Could not find remote-control config stripper guard — skipping Linux remote-control config preservation patch",
  );
  return currentSource;
}

function applyLinuxXdgDocumentsDirPatch(currentSource) {
  if (currentSource.includes("codexLinuxXdgDocumentsDir")) {
    return currentSource;
  }

  const fsVar = requireName(currentSource, "node:fs");
  if (fsVar == null) {
    console.warn("WARN: Could not find fs require — skipping Linux XDG documents dir patch");
    return currentSource;
  }

  const documentsDirRegex =
    /function ([A-Za-z_$][\w$]*)\(\{desktopPaths:([A-Za-z_$][\w$]*),homeDir:([A-Za-z_$][\w$]*),platform:([A-Za-z_$][\w$]*)\}\)\{return ([A-Za-z_$][\w$]*)\(\3,\2\.getPath\(`home`\),\4\)\?\2\.getPath\(`documents`\):([A-Za-z_$][\w$]*)\(\4\)\.join\(\3,`Documents`\)\}/u;
  const match = currentSource.match(documentsDirRegex);
  if (match == null) {
    if (
      currentSource.includes("getPath(`documents`)") &&
      currentSource.includes(".join(") &&
      currentSource.includes("`Documents`")
    ) {
      console.warn(
        "WARN: Could not find documents directory resolver — skipping Linux XDG documents dir patch",
      );
    }
    return currentSource;
  }

  const [, fnName, desktopPathsVar, homeDirVar, platformVar, sameHomeFn, pathFactoryFn] = match;
  const helper = [
    "function codexLinuxXdgDocumentsDir({fs:e,homeDir:t,path:n}){try{",
    "let r=process.env.XDG_CONFIG_HOME?.trim(),i=r&&n.isAbsolute(r)?n.join(r,`user-dirs.dirs`):n.join(t,`.config`,`user-dirs.dirs`);",
    "if(!e.existsSync(i))return null;",
    "let a=e.readFileSync(i,`utf8`).match(/^XDG_DOCUMENTS_DIR=([\"'])(.*)\\1/m);",
    "if(a==null)return null;",
    "let o=a[2].replace(/\\\\(.)/g,`$1`);",
    "if(o===`$HOME`)return t;",
    "if(o.startsWith(`$HOME/`))return n.join(t,o.slice(6));",
    "if(o.startsWith(`~/`))return n.join(t,o.slice(2));",
    "return n.isAbsolute(o)?o:n.join(t,o)",
    "}catch{return null}}",
  ].join("");
  const patchedFn =
    `${helper}function ${fnName}({desktopPaths:${desktopPathsVar},homeDir:${homeDirVar},platform:${platformVar}}){` +
    `if(${platformVar}===\`linux\`){let __codexLinuxDocumentsDir=codexLinuxXdgDocumentsDir({fs:${fsVar},homeDir:${homeDirVar},path:${pathFactoryFn}(${platformVar})});` +
    "if(__codexLinuxDocumentsDir!=null)return __codexLinuxDocumentsDir}" +
    `return ${sameHomeFn}(${homeDirVar},${desktopPathsVar}.getPath(\`home\`),${platformVar})?${desktopPathsVar}.getPath(\`documents\`):${pathFactoryFn}(${platformVar}).join(${homeDirVar},\`Documents\`)}`;

  return currentSource.replace(documentsDirRegex, () => patchedFn);
}

function applyLinuxLocalAppServerFeatureEnablementHandlerPatch(currentSource) {
  const method = "set-local-app-server-feature-enablement";
  const handler =
    "async e=>{let t=e?.params??e??{},n={},r=(e,t)=>{typeof t===`boolean`&&(n[e]=t)};if(t.enablement&&typeof t.enablement===`object`)for(let[e,n]of Object.entries(t.enablement))r(e,n);let i=t.featureName??t.feature_name??t.name??t.feature??null,a=t.enabled;i!=null&&r(i,a);for(let e of[`remote_control`,`remote_plugin`,`memories`,`tool_suggest`,`tool_call_mcp_elicitation`,`plugins`,`apps`])r(e,t[e]);let o=this.sharedObjectRepository?.get?.(`local_app_server_feature_enablement`)??{};return this.sharedObjectRepository?.set?.(`local_app_server_feature_enablement`,{...o,...n}),Object.prototype.hasOwnProperty.call(n,`remote_control`)&&this.sharedObjectRepository?.set?.(`local_remote_control_enabled`,n.remote_control),{enabled:n}}";
  let patchedSource = currentSource;

  if (!patchedSource.includes(`methods:[\`${method}\`]`)) {
    const approvalHandlerRegex =
      /(registerInternalServerRequestHandler\(\{methods:\[`item\/commandExecution\/requestApproval`,`mcpServer\/elicitation\/request`\],handler:[^}]+?\}\),)([A-Za-z_$][\w$]*\.registerInternalServerRequestHandler\(\{methods:\[`attestation\/generate`\])/u;
    const match = patchedSource.match(approvalHandlerRegex);
    if (match == null) {
      if (
        patchedSource.includes("registerInternalServerRequestHandler") &&
        patchedSource.includes("item/commandExecution/requestApproval") &&
        patchedSource.includes("attestation/generate")
      ) {
        console.warn(
          "WARN: Could not find local app-server feature enablement internal handler insertion point — skipping Linux app-server feature enablement internal handler patch",
        );
      }
    } else {
      const [, approvalRegistration, nextRegistration] = match;
      const receiverVar = nextRegistration.slice(0, nextRegistration.indexOf("."));
      patchedSource = patchedSource.replace(
        approvalHandlerRegex,
        `${approvalRegistration}${receiverVar}.registerInternalServerRequestHandler({methods:[\`${method}\`],handler:${handler}}),${nextRegistration}`,
      );
    }
  }

  if (!patchedSource.includes(`"${method}":async`)) {
    const fetchHandlerRegex =
      /("set-vs-context":async\(\)=>\{throw new [A-Za-z_$][\w$]*\},)/u;
    if (fetchHandlerRegex.test(patchedSource)) {
      patchedSource = patchedSource.replace(
        fetchHandlerRegex,
        `$1"${method}":${handler},`,
      );
    } else if (
      patchedSource.includes("not implemented in the current Electron process") &&
      patchedSource.includes("handleVSCodeRequest") &&
      patchedSource.includes("handlers=")
    ) {
      console.warn(
        "WARN: Could not find local app-server feature enablement Electron handler insertion point — skipping Linux app-server feature enablement Electron handler patch",
      );
    }
  }

  return patchedSource;
}

module.exports = {
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxLocalAppServerFeatureEnablementHandlerPatch,
  applyLinuxOwlFeatureBindingFallbackPatch,
  applyLinuxWorkerFileManagerPatch,
  patchLinuxOwlFeatureBindingFallbackAssets,
  patchLinuxWorkerFileManagerTarget,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxXdgDocumentsDirPatch,
};
