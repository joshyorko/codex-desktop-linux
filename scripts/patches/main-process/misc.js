"use strict";

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
  applyLinuxRemoteControlConfigPreservationPatch,
};
