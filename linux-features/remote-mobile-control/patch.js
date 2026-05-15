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
];

module.exports.applyLinuxRemoteControlDeviceKeyPatch = applyLinuxRemoteControlDeviceKeyPatch;
module.exports.applyLinuxRemoteControlPreserveConfigPatch = applyLinuxRemoteControlPreserveConfigPatch;
module.exports.applyLinuxRemoteControlVisibilityPatch = applyLinuxRemoteControlVisibilityPatch;
