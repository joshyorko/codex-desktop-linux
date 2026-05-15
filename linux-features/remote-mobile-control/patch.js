"use strict";

function requireName(source, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`([A-Za-z_$][\\w$]*)=require\\(\`${escaped}\`\\)`));
  return match?.[1] ?? null;
}

const DEVICE_KEY_CLIENT_MARKER = "codexLinuxRemoteControlDeviceKeyClient";
const DEVICE_KEY_GUARD =
  "if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);";
const DEVICE_KEY_GUARD_REPLACEMENT =
  "if(process.platform===`linux`)return codexLinuxRemoteControlDeviceKeyClient();if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);";
const REMOTE_CONTROL_VISIBILITY_NEEDLE =
  "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
const REMOTE_CONTROL_VISIBILITY_REPLACEMENT =
  "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){let n=typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`);return(n||t)&&(n||(e?.available??!0))&&e?.accessRequired!==!0}";
const REMOTE_CONTROL_VISIBILITY_OLD_REPLACEMENT =
  "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){let n=typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`);return t&&(n||(e?.available??!0))&&e?.accessRequired!==!0}";
const REMOTE_CONTROL_SETTINGS_UX_MARKER = "codexLinuxRemoteControlSettingsTabs";
const REMOTE_CONNECTIONS_REFRESH_MARKER = "codexLinuxRemoteConnectionsRefreshNow";
const REMOTE_MOBILE_CHROME_BRIDGE_MARKER = "codexLinuxRemoteMobileBrowserBackends";
const REMOTE_CONTROL_SELECTED_TAB_NEEDLE =
  "function rr({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}";
const REMOTE_CONTROL_SELECTED_TAB_REPLACEMENT =
  "function rr({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){let i=typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`);if(i){if(!n)return`ssh`;if(e===`access-other-devices`)return t?`control-this-mac`:`ssh`;if(e===`control-this-mac`&&!t)return`ssh`;if(e===`ssh`&&!r)return t?`control-this-mac`:`ssh`;return e}return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}";
const REMOTE_CONTROL_LINUX_LABEL_REPLACEMENTS = [
  ["Control this Mac from your phone or other device", "Control this computer from your phone or other device"],
  ["Add device to control this Mac remotely", "Add a device to control this computer remotely"],
  ["Devices that can control this Mac", "Devices that can control this computer"],
  ["Allow this Mac to be discovered and controlled", "Allow this computer to be discovered and controlled"],
  ["Control other devices from this Mac", "Control other devices from this computer"],
  ["Authorize this Mac to control other devices signed in to your ChatGPT account", "Authorize this computer to control other devices signed in to your ChatGPT account"],
  ["Devices you can control from this Mac", "Devices you can control from this computer"],
  ["Control this Mac", "Control this computer"],
  ["Keep Mac awake", "Keep computer awake"],
  ["this Mac", "this computer"],
  ["local Mac", "local computer"],
];

function linuxDeviceKeyProviderSource({ cryptoVar, fsVar, pathVar }) {
  return [
    "function codexLinuxRemoteControlDeviceKeyStorePath(){",
    `let e=process.env.XDG_CONFIG_HOME&&process.env.XDG_CONFIG_HOME.trim()?process.env.XDG_CONFIG_HOME.trim():process.env.HOME?${pathVar}.join(process.env.HOME,\`.config\`):null;`,
    "if(e==null)throw Error(`Linux remote control device keys require HOME or XDG_CONFIG_HOME`);",
    `${fsVar}.mkdirSync(${pathVar}.join(e,\`codex-desktop\`),{recursive:!0,mode:448});`,
    `return ${pathVar}.join(e,\`codex-desktop\`,\`remote-control-device-keys-v1.json\`)`,
    "}",
    "function codexLinuxRemoteControlPublicDeviceKey(e){",
    "return{algorithm:e.algorithm,keyId:e.keyId,protectionClass:e.protectionClass,publicKeySpkiDerBase64:e.publicKeySpkiDerBase64}",
    "}",
    "function codexLinuxReadRemoteControlDeviceKeyStore(){",
    "let e=codexLinuxRemoteControlDeviceKeyStorePath();",
    `if(!${fsVar}.existsSync(e))return{keys:{}};`,
    "try{",
    `let t=JSON.parse(${fsVar}.readFileSync(e,\`utf8\`));`,
    "return t&&typeof t==`object`&&!Array.isArray(t)&&t.keys&&typeof t.keys==`object`&&!Array.isArray(t.keys)?t:{keys:{}}",
    "}catch{return{keys:{}}}",
    "}",
    "function codexLinuxWriteRemoteControlDeviceKeyStore(e){",
    "let t=codexLinuxRemoteControlDeviceKeyStorePath(),n=`${t}.tmp-${process.pid}-${Date.now()}`;",
    `try{${fsVar}.writeFileSync(n,JSON.stringify(e,null,2)+\`\\n\`,{encoding:\`utf8\`,mode:384}),${fsVar}.chmodSync(n,384),${fsVar}.renameSync(n,t),${fsVar}.chmodSync(t,384)}catch(e){try{${fsVar}.rmSync(n,{force:!0})}catch{}throw e}`,
    "}",
    "function codexLinuxRemoteControlDeviceKeyClient(){return{",
    "createDeviceKey:async e=>{",
    "let t=codexLinuxReadRemoteControlDeviceKeyStore();",
    `let{publicKey:n,privateKey:r}=(0,${cryptoVar}.generateKeyPairSync)(\`ec\`,{namedCurve:\`P-256\`});`,
    `let i=(0,${cryptoVar}.randomUUID)(),a=n.export({type:\`spki\`,format:\`der\`}).toString(\`base64\`),o=r.export({type:\`pkcs8\`,format:\`pem\`});`,
    "let c={algorithm:`ecdsa_p256_sha256`,keyId:i,protectionClass:`os_protected_nonextractable`,publicKeySpkiDerBase64:a,privateKeyPkcs8Pem:o,createdAt:new Date().toISOString()};",
    "t.keys={...t.keys,[i]:c},codexLinuxWriteRemoteControlDeviceKeyStore(t);",
    "return codexLinuxRemoteControlPublicDeviceKey(c)",
    "},",
    "deleteDeviceKey:async e=>{let t=codexLinuxReadRemoteControlDeviceKeyStore();t.keys&&delete t.keys[e],codexLinuxWriteRemoteControlDeviceKeyStore(t)},",
    "getDeviceKeyPublic:async e=>{let t=codexLinuxReadRemoteControlDeviceKeyStore().keys?.[e];if(t==null)throw Error(`Linux remote control device key not found`);return codexLinuxRemoteControlPublicDeviceKey(t)},",
    `signDeviceKey:async(e,t)=>{let n=codexLinuxReadRemoteControlDeviceKeyStore().keys?.[e];if(n==null)throw Error(\`Linux remote control device key not found\`);let r=(0,${cryptoVar}.createPrivateKey)(n.privateKeyPkcs8Pem),i=(0,${cryptoVar}.sign)(\`sha256\`,t,r).toString(\`base64\`);return{algorithm:n.algorithm,signatureDerBase64:i}}`,
    "}}",
  ].join("");
}

function applyLinuxRemoteControlDeviceKeyPatch(source) {
  if (source.includes(DEVICE_KEY_CLIENT_MARKER)) {
    return source;
  }

  const cryptoVar = requireName(source, "node:crypto");
  const fsVar = requireName(source, "node:fs");
  const pathVar = requireName(source, "node:path");
  if (cryptoVar == null || fsVar == null || pathVar == null) {
    console.warn("WARN: Could not find Node module aliases - skipping Linux remote-control device-key patch");
    return source;
  }

  const insertionNeedle = "var bV=(0,b.createRequire)(__filename),xV=`remote-control-device-key.node`";
  if (!source.includes(insertionNeedle) || !source.includes(DEVICE_KEY_GUARD)) {
    console.warn("WARN: Could not find remote-control device-key bundle needles - skipping Linux remote-control device-key patch");
    return source;
  }

  const provider = linuxDeviceKeyProviderSource({ cryptoVar, fsVar, pathVar });
  return source
    .replace(insertionNeedle, `${provider}${insertionNeedle}`)
    .replace(DEVICE_KEY_GUARD, DEVICE_KEY_GUARD_REPLACEMENT);
}

function applyLinuxRemoteControlPreserveConfigPatch(source) {
  const patchedNeedle =
    "async function mV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`&&process.platform!==`linux`)try{";
  if (source.includes(patchedNeedle)) {
    return source;
  }

  const needle = "async function mV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{";
  if (!source.includes(needle)) {
    console.warn("WARN: Could not find remote-control config stripping needle - skipping Linux remote-control config patch");
    return source;
  }

  return source.replace(needle, patchedNeedle);
}

function applyLinuxRemoteControlVisibilityPatch(source) {
  if (source.includes(REMOTE_CONTROL_VISIBILITY_REPLACEMENT)) {
    return source;
  }
  if (source.includes(REMOTE_CONTROL_VISIBILITY_OLD_REPLACEMENT)) {
    return source.replace(REMOTE_CONTROL_VISIBILITY_OLD_REPLACEMENT, REMOTE_CONTROL_VISIBILITY_REPLACEMENT);
  }
  if (!source.includes(REMOTE_CONTROL_VISIBILITY_NEEDLE)) {
    console.warn("WARN: Could not find remote-control visibility gate - skipping Linux remote-control visibility patch");
    return source;
  }
  return source.replace(REMOTE_CONTROL_VISIBILITY_NEEDLE, REMOTE_CONTROL_VISIBILITY_REPLACEMENT);
}

function wrapRemoteControlTabs(source, firstKey) {
  const key = firstKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `tabs:(\\[\\{key:\`${key}\`[\\s\\S]*?\\}\\]),selectedKey:([A-Za-z_$][\\w$]*),variant:\`underline\`,onSelect:([A-Za-z_$][\\w$]*)\\}`,
    "g",
  );
  return source.replace(
    pattern,
    "tabs:codexLinuxRemoteControlSettingsTabs($1),selectedKey:$2,variant:`underline`,onSelect:$3}",
  );
}

function applyLinuxRemoteControlSettingsUxPatch(source) {
  let patched = source;
  for (const [from, to] of REMOTE_CONTROL_LINUX_LABEL_REPLACEMENTS) {
    patched = patched.replaceAll(from, to);
  }

  if (!patched.includes(REMOTE_CONTROL_SETTINGS_UX_MARKER)) {
    const helperNeedle = "function nr(e,t){return e.displayName.localeCompare(t.displayName)}";
    if (!patched.includes(helperNeedle)) {
      console.warn("WARN: Could not find remote-control settings helper needle - skipping Linux remote-control settings UX patch");
      return patched;
    }
    const helper =
      "function codexLinuxRemoteControlSettingsTabs(e){return typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`)?e.filter(e=>e.key!==`access-other-devices`):e}";
    patched = patched.replace(helperNeedle, `${helper}${helperNeedle}`);
  }

  patched = wrapRemoteControlTabs(patched, "control-this-mac");
  patched = wrapRemoteControlTabs(patched, "access-other-devices");

  if (patched.includes(REMOTE_CONTROL_SELECTED_TAB_REPLACEMENT)) {
    return patched;
  }
  if (!patched.includes(REMOTE_CONTROL_SELECTED_TAB_NEEDLE)) {
    console.warn("WARN: Could not find remote-control selected-tab needle - skipping Linux remote-control selected-tab patch");
    return patched;
  }
  return patched.replace(REMOTE_CONTROL_SELECTED_TAB_NEEDLE, REMOTE_CONTROL_SELECTED_TAB_REPLACEMENT);
}

function applyLinuxRemoteConnectionsRefreshPatch(source) {
  if (source.includes(REMOTE_CONNECTIONS_REFRESH_MARKER)) {
    return source;
  }

  let patched = source;
  if (patched.includes("Qn=15e3")) {
    patched = patched.replace("Qn=15e3", "Qn=5e3");
  } else if (patched.includes("15e3") && patched.includes("refresh-remote-connections")) {
    console.warn("WARN: Could not find remote-connections refresh interval constant - skipping interval patch");
  }

  const effectPattern =
    /\(0,([A-Za-z_$][\w$]*)\.useEffect\)\(\(\)=>\{let ([A-Za-z_$][\w$]*)=null,([A-Za-z_$][\w$]*)=!1,([A-Za-z_$][\w$]*)=async\(\)=>\{if\(![A-Za-z_$][\w$]*\)\{[A-Za-z_$][\w$]*=!0,[A-Za-z_$][\w$]*=new AbortController;try\{await ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.signal\)\}finally\{[A-Za-z_$][\w$]*=null,[A-Za-z_$][\w$]*=!1\}\}\},([A-Za-z_$][\w$]*)=window\.setInterval\(\(\)=>\{[A-Za-z_$][\w$]*\(\)\},([A-Za-z_$][\w$]*)\);return\(\)=>\{[A-Za-z_$][\w$]*\?\.abort\(\),window\.clearInterval\([A-Za-z_$][\w$]*\)\}\},\[\]\);/;
  const match = patched.match(effectPattern);
  if (match == null) {
    if (patched.includes("refresh-remote-connections") && patched.includes("setInterval")) {
      console.warn("WARN: Could not find remote-connections auto-refresh effect - skipping resume refresh patch");
    }
    return patched;
  }

  const [
    needle,
    reactVar,
    abortVar,
    pendingVar,
    refreshVar,
    refreshEventVar,
    intervalVar,
    intervalConstantVar,
  ] = match;
  const replacement =
    `(0,${reactVar}.useEffect)(()=>{let ${abortVar}=null,${pendingVar}=!1,${refreshVar}=async()=>{if(!${pendingVar}){${pendingVar}=!0,${abortVar}=new AbortController;try{await ${refreshEventVar}(${abortVar}.signal)}finally{${abortVar}=null,${pendingVar}=!1}}},` +
    `${REMOTE_CONNECTIONS_REFRESH_MARKER}=()=>{document.visibilityState!==\`hidden\`&&${refreshVar}()},` +
    `${intervalVar}=window.setInterval(()=>{${refreshVar}()},${intervalConstantVar});` +
    `document.addEventListener(\`visibilitychange\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`focus\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`online\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`resume\`,${REMOTE_CONNECTIONS_REFRESH_MARKER});` +
    `return()=>{${abortVar}?.abort(),window.clearInterval(${intervalVar}),` +
    `document.removeEventListener(\`visibilitychange\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`focus\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`online\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`resume\`,${REMOTE_CONNECTIONS_REFRESH_MARKER})}},[]);`;

  return patched.replace(needle, replacement);
}

function applyLinuxRemoteMobileChromeBridgePatch(source) {
  if (source.includes(REMOTE_MOBILE_CHROME_BRIDGE_MARKER)) {
    return source;
  }

  const backendNeedle =
    "var tE=\"x-codex-browser-use-available-backends\",X6=[\"chrome\",\"iab\",\"cdp\"];function rE(t){return X6.some(e=>e===t)}";
  const backendReplacement =
    "var tE=\"x-codex-browser-use-available-backends\",X6=[\"chrome\",\"iab\",\"cdp\"];function rE(t){return X6.some(e=>e===t)}function codexLinuxRemoteMobileBrowserBackends(e){if(e==null)return null;if(!Array.isArray(e))return[];let t=e.filter(rE);return typeof process!=`undefined`&&process.platform===`linux`&&!t.includes(`chrome`)?[`chrome`,...t]:t}";
  const currentBackendNeedle =
    "function yC(){let t=globalThis.nodeRepl?.requestMeta?.[tE];return t==null?null:Array.isArray(t)?t.filter(rE):[]}";
  const currentBackendReplacement =
    "function yC(){let t=globalThis.nodeRepl?.requestMeta?.[tE];return codexLinuxRemoteMobileBrowserBackends(t)}";

  if (!source.includes(backendNeedle) || !source.includes(currentBackendNeedle)) {
    console.warn("WARN: Could not find Chrome browser-client backend allowlist needles - skipping remote-mobile Chrome bridge patch");
    return source;
  }

  let patched = source
    .replace(backendNeedle, backendReplacement)
    .replace(currentBackendNeedle, currentBackendReplacement);

  const nativePipeNeedle =
    "function Cm(){let t=import.meta.__codexNativePipeUnavailableMessage;return typeof t==\"string\"&&t.length>0?t:\"privileged native pipe bridge is not available; browser-client is not trusted\"}";
  const nativePipeReplacement =
    "function codexLinuxRemoteMobileBrowserBridgeDiagnostic(e){return typeof process!=`undefined`&&process.platform===`linux`?`${e}; Chrome bridge was not exposed to this remote/mobile session. Check that the Chrome plugin, native host manifest, and x-codex-browser-use-available-backends request metadata include chrome.`:e}function Cm(){let t=import.meta.__codexNativePipeUnavailableMessage,e=typeof t==\"string\"&&t.length>0?t:\"privileged native pipe bridge is not available; browser-client is not trusted\";return codexLinuxRemoteMobileBrowserBridgeDiagnostic(e)}";
  if (patched.includes(nativePipeNeedle)) {
    patched = patched.replace(nativePipeNeedle, nativePipeReplacement);
  } else {
    console.warn("WARN: Could not find Chrome browser-client native pipe diagnostic needle - leaving default bridge diagnostic unchanged");
  }

  return patched;
}

module.exports = [
  {
    id: "linux-remote-control-device-key",
    phase: "main-bundle",
    order: 20_100,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlDeviceKeyPatch,
  },
  {
    id: "linux-remote-control-preserve-config",
    phase: "main-bundle",
    order: 20_110,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlPreserveConfigPatch,
  },
  {
    id: "linux-remote-control-visibility",
    phase: "webview-asset",
    pattern: /^remote-control-connections-visibility-.*\.js$/,
    order: 20_120,
    ciPolicy: "optional",
    missingDescription: "remote-control connections visibility bundle",
    skipDescription: "Linux remote-control visibility patch",
    apply: applyLinuxRemoteControlVisibilityPatch,
  },
  {
    id: "linux-remote-control-settings-ux",
    phase: "webview-asset",
    pattern: /^remote-connections-settings-.*\.js$/,
    order: 20_130,
    ciPolicy: "optional",
    missingDescription: "remote connections settings bundle",
    skipDescription: "Linux remote-control settings UX patch",
    apply: applyLinuxRemoteControlSettingsUxPatch,
  },
  {
    id: "linux-remote-connections-refresh",
    phase: "webview-asset",
    pattern: /^remote-connections-settings-.*\.js$/,
    order: 20_140,
    ciPolicy: "optional",
    missingDescription: "remote connections settings bundle",
    skipDescription: "Linux remote-connections refresh patch",
    apply: applyLinuxRemoteConnectionsRefreshPatch,
  },
];

module.exports.applyLinuxRemoteControlDeviceKeyPatch = applyLinuxRemoteControlDeviceKeyPatch;
module.exports.applyLinuxRemoteMobileChromeBridgePatch = applyLinuxRemoteMobileChromeBridgePatch;
module.exports.applyLinuxRemoteControlPreserveConfigPatch = applyLinuxRemoteControlPreserveConfigPatch;
module.exports.applyLinuxRemoteConnectionsRefreshPatch = applyLinuxRemoteConnectionsRefreshPatch;
module.exports.applyLinuxRemoteControlVisibilityPatch = applyLinuxRemoteControlVisibilityPatch;
module.exports.applyLinuxRemoteControlSettingsUxPatch = applyLinuxRemoteControlSettingsUxPatch;
