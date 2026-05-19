#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
  patchExtractedApp,
  patchMainBundleSource,
} = require("../../scripts/patch-linux-window-ui.js");
const {
  applyLinuxRemoteControlDeviceKeyPatch,
  applyLinuxRemoteControlClientAccountCompatibilityPatch,
  applyLinuxRemoteControlClientRevocationRecoveryPatch,
  applyLinuxRemoteControlLoadGatePatch,
  applyLinuxRemoteMobileChromeBridgePatch,
  applyLinuxRemoteControlPreserveConfigPatch,
  applyLinuxRemoteConnectionsRefreshPatch,
  applyLinuxRemoteControlSettingsUxPatch,
  applyLinuxRemoteControlVisibilityPatch,
} = require("./patch.js");

function syntheticMainBundle() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`),s=require(`node:crypto`),b={createRequire:()=>()=>({})};",
    "function TV(e){return Buffer.from(JSON.stringify(e),`utf8`)}",
    "var bV=(0,b.createRequire)(__filename),xV=`remote-control-device-key.node`,SV=`codex-device-key-sign-payload/v1`;",
    "function wV({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=bV(i.join(e,`native`,xV)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=TV(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
    "async function mV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await hV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),pV))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
  ].join("");
}

function syntheticVisibilityBundle() {
  return "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}export{a as t};";
}

function syntheticCurrentMainBundle() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`),s=require(`node:crypto`),b={createRequire:()=>()=>({})};",
    "function mz(e){return Buffer.from(JSON.stringify({domain:`codex-device-key-sign-payload/v1`,payload:e}),`utf8`)}",
    "var lz=(0,b.createRequire)(__filename),uz=`remote-control-device-key.node`,dz=`codex-device-key-sign-payload/v1`;",
    "function pz({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=lz((0,i.join)(e,`native`,uz)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=mz(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
    "async function vV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await yV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),_V))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
  ].join("");
}

function syntheticOldClientEnrollmentBundle() {
  return [
    "async function dd({appServerClient:e,desktopApiOptions:t,deviceKeyClient:n,globalState:r}){let i=Sd(await md({action:`check remote control authorization`,appServerClient:e,desktopApiOptions:t})).tokenAccountUserId;if(i==null)return{clientAuthorized:!1,clientId:null};let a=await Ld({deviceKeyClient:n,enrollmentKey:pd(fd(t),i),globalState:r});return{clientAuthorized:a!=null,clientId:a?.clientId??null}}",
    "function fd(e){return[e.desktopOriginator,e.devApiBaseUrl,e.prodApiBaseUrl].join(`\\n`)}",
    "function pd(e,t){return`${e}\\n${t}`}",
    "async function md({action:e=`connect remote control environments`,appServerClient:t,desktopApiOptions:n,headers:r}){return Ou({action:e,appServerClient:t,desktopOriginator:n.desktopOriginator,headers:r})}",
    "async function hd({appServerClient:e,deviceKeyClient:t,desktopApiOptions:n,enrollmentKey:r,globalState:i,headers:a,requestRemoteControlEnrollmentStepUpToken:o}){let s=Sd(a),c=s.tokenAccountUserId;if(c==null)throw Error(`Remote control enrollment requires the current ChatGPT account user id.`);let l=pd(r,c),u=await Ld({deviceKeyClient:t,enrollmentKey:l,globalState:i}),d=u,f;if(d==null){if(o==null)throw Error(`Remote control enrollment requires explicit authorization in settings.`);Qu().info(`remote_control_client_enrollment_start_request`,{...Cd({authIdentity:s,hasExistingEnrollment:!1})});let r=await jd({appServerClient:e,body:{},desktopApiOptions:n,headers:a});if(Qu().info(`remote_control_client_enrollment_start_response`,{...Cd({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:r.account_user_id,responseClientId:r.client_id,responseChallengeId:r.device_key_challenge.challenge_id})}),r.account_user_id!==c)throw Qu().warning(`remote_control_client_enrollment_start_account_mismatch`,{...Cd({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:r.account_user_id,responseClientId:r.client_id,responseChallengeId:r.device_key_challenge.challenge_id})}),Error(`Remote control enrollment start does not match current account.`);d=await Vd({accountUserId:c,clientId:r.client_id,deviceKeyClient:t});try{if(Qu().info(`remote_control_client_enrollment_key_created`,{safe:{algorithm:d.algorithm,protectionClass:d.protectionClass},sensitive:{accountUserId:d.accountUserId,clientId:d.clientId,keyId:d.keyId}}),o==null)throw Error(`Remote control enrollment requires a step-up authorization flow.`);Qu().info(`remote_control_client_enrollment_step_up_requested`,{...Cd({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:r.account_user_id,responseChallengeId:r.device_key_challenge.challenge_id,responseClientId:r.client_id})});let u=await o(),p=Td({accountUserId:c,stepUpToken:u}),m=Cd({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:r.account_user_id,responseChallengeId:r.device_key_challenge.challenge_id,responseClientId:r.client_id});Qu().info(`remote_control_client_enrollment_step_up_validated`,{safe:{...m.safe,stepUpTokenScopes:p.scopes},sensitive:{...m.sensitive,stepUpIssuedAt:p.issuedAt,stepUpPasswordAuthTime:p.passwordAuthTime,stepUpTokenAccountUserId:p.accountUserId}}),f=await Md({appServerClient:e,body:{client_id:d.clientId,step_up_token:u,device_identity:Ud(d),device_key_proof:await Gd({challenge:r.device_key_challenge,deviceKeyClient:t,desktopApiOptions:n,enrollment:d,expectedPath:`/codex/remote/control/client/enroll/finish`,requireDeviceIdentityHash:!1})},desktopApiOptions:n,headers:a}),Qu().info(`remote_control_client_enrollment_finish_response`,{...wd(f)}),_d(f,d),Rd(i,l,d)}catch(e){throw await Hd({deviceKeyClient:t,enrollment:d}),e}}else{Qu().info(`remote_control_client_refresh_start_request`,{...Cd({authIdentity:s,existingEnrollment:u,hasExistingEnrollment:!0})});let c;try{c=await Nd({appServerClient:e,body:{client_id:d.clientId},desktopApiOptions:n,headers:a})}catch(s){if(!Bd(s))throw s;return await Hd({deviceKeyClient:t,enrollment:d}),zd(i,l),hd({appServerClient:e,deviceKeyClient:t,desktopApiOptions:n,enrollmentKey:r,globalState:i,headers:a,requestRemoteControlEnrollmentStepUpToken:o})}if(Qu().info(`remote_control_client_refresh_start_response`,{...Cd({authIdentity:s,existingEnrollment:u,hasExistingEnrollment:!0,responseAccountUserId:c.account_user_id,responseClientId:c.client_id,responseChallengeId:c.device_key_challenge.challenge_id})}),c.client_id!==d.clientId||c.account_user_id!==d.accountUserId)throw Error(`Remote control refresh challenge does not match local enrollment.`);f=await Pd({appServerClient:e,body:{client_id:d.clientId,device_key_proof:await Gd({challenge:c.device_key_challenge,deviceKeyClient:t,desktopApiOptions:n,enrollment:d,expectedPath:`/codex/remote/control/client/refresh/finish`,requireDeviceIdentityHash:!0})},desktopApiOptions:n,headers:a})}let p=_d(f,d);return{clientId:f.client_id,headers:{\"x-codex-client-session-token\":`Bearer ${f.remote_control_token}`},tokenExpiresAt:p.tokenExpiresAt,scopes:p.scopes,requiresDeviceKeyProof:!0}}",
    "function Td({accountUserId:e,stepUpToken:t}){let n=Od(t);Dd({payload:n});let r=od.parse(n),i=r[`https://api.openai.com/auth`],a=i.chatgpt_account_user_id??i.account_user_id,o=Ed(r);if(a!==e)throw Error(`Remote control enrollment step-up token does not match current account.`);if(Math.floor(Date.now()/1e3)-r.iat>id)throw Error(`Remote control enrollment step-up token is not fresh.`);if(Date.now()-r.pwd_auth_time>id*1e3)throw Error(`Remote control enrollment step-up token does not have fresh password auth.`);if(o.length!==1||o[0]!==rd)throw Error(`Remote control enrollment step-up token is missing required authorization.`);return{accountUserId:a??null,issuedAt:r.iat,passwordAuthTime:r.pwd_auth_time,scopes:o}}",
  ].join("");
}

function syntheticRecoverableErrorPredicateBundle() {
  return "function Bd(e){return e instanceof Error?e.message.startsWith(`Remote control request failed (404):`)||e.message===`Remote control request failed (401): Remote-control client enrollment is incomplete`||e.message===`Remote control request failed (403): Remote-control client key material missing`:!1}";
}

function syntheticRemoteConnectionVisibilityBundle() {
  return "function d(){return true}function f(){return c(`1042620455`)}function p(){return []}export{d as n,f as r,p as t};";
}

function syntheticCurrentVisibilityBundle() {
  return "function Et({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)}export{Et as t};";
}

function syntheticSettingsBundle() {
  return [
    "const o=`linux`,Q={jsx(){},jsxs(){}};",
    "tabs:[{key:`control-this-mac`,name:o===`windows`?(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.controlThisMac.windows`,defaultMessage:`Control this PC`,description:`Tab label for settings that let other devices control this Windows device`}):(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.controlThisMac`,defaultMessage:`Control this Mac`,description:`Tab label for settings that let other devices control this computer`})},{key:`access-other-devices`,name:(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.accessOtherDevices`,defaultMessage:`Control other devices`,description:`Tab label for settings that let this computer control other devices`})},{key:`ssh`,name:(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.ssh`,defaultMessage:`SSH`,description:`Tab label for SSH remote connections`})}],selectedKey:je,variant:`underline`,onSelect:se}",
    "tabs:[{key:`access-other-devices`,name:(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.accessOtherDevices`,defaultMessage:`Control other devices`,description:`Tab label for settings that let this computer control other devices`})},{key:`ssh`,name:(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.ssh`,defaultMessage:`SSH`,description:`Tab label for SSH remote connections`})}],selectedKey:je,variant:`underline`,onSelect:se}",
    "const a=`Control this Mac from your phone or other device`,b=`Add device to control this Mac remotely`,c=`Devices that can control this Mac`,d=`Keep Mac awake`,e=`Allow this Mac to be discovered and controlled`,f=`Control other devices from this Mac`,g=`Authorize this Mac to control other devices signed in to your ChatGPT account`,h=`Devices you can control from this Mac`;",
    "function nr(e,t){return e.displayName.localeCompare(t.displayName)}",
    "function rr({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}",
  ].join("");
}

function syntheticSettingsRefreshBundle() {
  return [
    "var Qn=15e3,Z=React;",
    "function tr(){let $=useEffectEvent(async e=>{await P(`refresh-remote-connections`,{signal:e})});",
    "(0,Z.useEffect)(()=>{let e=null,t=!1,n=async()=>{if(!t){t=!0,e=new AbortController;try{await $(e.signal)}finally{e=null,t=!1}}},r=window.setInterval(()=>{n()},Qn);return()=>{e?.abort(),window.clearInterval(r)}},[]);",
    "return null}",
  ].join("");
}

function syntheticChromeBrowserClientBundle() {
  return [
    "var tE=\"x-codex-browser-use-available-backends\",X6=[\"chrome\",\"iab\",\"cdp\"];",
    "function rE(t){return X6.some(e=>e===t)}",
    "function Cm(){let t=import.meta.__codexNativePipeUnavailableMessage;return typeof t==\"string\"&&t.length>0?t:\"privileged native pipe bridge is not available; browser-client is not trusted\"}",
    "function yC(){let t=globalThis.nodeRepl?.requestMeta?.[tE];return t==null?null:Array.isArray(t)?t.filter(rE):[]}",
  ].join("");
}

function syntheticSelectedTabBundle() {
  return [
    "function nr(e,t){return e.displayName.localeCompare(t.displayName)}",
    "function rr({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}",
  ].join("");
}

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-feature-test-"));
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(__dirname, path.join(root, "remote-mobile-control"), { recursive: true });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withFeatureRootEnv(root, fn) {
  const previous = process.env.CODEX_LINUX_FEATURES_ROOT;
  process.env.CODEX_LINUX_FEATURES_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = previous;
    }
  }
}

function captureWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("remote mobile control feature stays disabled until listed in features.json", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("remote mobile control feature exposes opt-in main-bundle and webview patches", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
      "feature:remote-mobile-control:linux-remote-control-device-key",
      "feature:remote-mobile-control:linux-remote-control-preserve-config",
      "feature:remote-mobile-control:linux-remote-control-client-account-compatibility",
      "feature:remote-mobile-control:linux-remote-control-client-revocation-recovery",
      "feature:remote-mobile-control:linux-remote-control-load-gate",
      "feature:remote-mobile-control:linux-remote-control-visibility",
      "feature:remote-mobile-control:linux-remote-control-settings-ux",
      "feature:remote-mobile-control:linux-remote-connections-refresh",
    ]);
    assert.deepEqual(descriptors.map((descriptor) => descriptor.phase), [
      "main-bundle",
      "main-bundle",
      "main-bundle",
      "main-bundle",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
    ]);
  });
});

test("Linux remote-control patches update the device-key provider and preserve config", () => {
  const source = syntheticMainBundle();
  const patched = applyLinuxRemoteControlPreserveConfigPatch(
    applyLinuxRemoteControlDeviceKeyPatch(source),
  );

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
  assert.match(patched, /process\.platform===`linux`\)return codexLinuxRemoteControlDeviceKeyClient\(\)/);
  assert.match(patched, /n\.kind===`local`&&process\.platform!==`linux`/);
  assert.equal(
    applyLinuxRemoteControlPreserveConfigPatch(applyLinuxRemoteControlDeviceKeyPatch(patched)),
    patched,
  );
});

test("Linux remote-control device-key patch handles current minified aliases", () => {
  const source = syntheticCurrentMainBundle();
  const patched = applyLinuxRemoteControlPreserveConfigPatch(applyLinuxRemoteControlDeviceKeyPatch(source));

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
  assert.match(patched, /process\.platform===`linux`\)return codexLinuxRemoteControlDeviceKeyClient\(\)/);
  assert.match(patched, /n\.kind===`local`&&process\.platform!==`linux`/);
  assert.equal(applyLinuxRemoteControlPreserveConfigPatch(applyLinuxRemoteControlDeviceKeyPatch(patched)), patched);
});

test("Linux remote-control client enrollment accepts account-scoped and base user ids", () => {
  const source = syntheticOldClientEnrollmentBundle();
  const patched = applyLinuxRemoteControlClientAccountCompatibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlAccountMatches/);
  assert.match(patched, /codexLinuxRemoteControlLoadEnrollment/);
  assert.doesNotMatch(patched, /account_user_id!==c/);
  assert.match(patched, /accountUserId:r\.account_user_id/);
  assert.match(patched, /l=pd\(codexLinuxRemoteControlEnrollmentKey,d\.accountUserId\)/);
  assert.match(
    patched,
    /Td\(\{accountId:codexLinuxRemoteControlCurrentAccountId,accountUserId:d\.accountUserId,stepUpToken:u\}\)/,
  );
  assert.match(patched, /clientId:a\?\.enrollment\.clientId\?\?null/);
  assert.equal(applyLinuxRemoteControlClientAccountCompatibilityPatch(patched), patched);
});

test("Linux remote-control client revocation triggers local cleanup and re-enrollment", () => {
  const source = syntheticRecoverableErrorPredicateBundle();
  const patched = applyLinuxRemoteControlClientRevocationRecoveryPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /Remote-control client key material missing`\|\|e\.message===`Remote-control client has been revoked/);
  assert.match(patched, /Remote-control client has been revoked/);
  assert.equal(applyLinuxRemoteControlClientRevocationRecoveryPatch(patched), patched);
});

test("Linux remote-control client recovery handles bare missing key material errors", () => {
  const source = syntheticRecoverableErrorPredicateBundle();
  const patched = applyLinuxRemoteControlClientRevocationRecoveryPatch(source);

  assert.match(patched, /e\.message===`Remote-control client key material missing`/);
});

test("Linux remote-control load gate enables remote-control environment loading", () => {
  const source = syntheticRemoteConnectionVisibilityBundle();
  const patched = applyLinuxRemoteControlLoadGatePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlLoadGateEnabled/);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /return codexLinuxRemoteControlLoadGateEnabled\(\)\|\|c\(`1042620455`\)/);
  assert.equal(applyLinuxRemoteControlLoadGatePatch(patched), patched);
});

test("Linux remote-control visibility patch allows Linux when upstream marks availability false", () => {
  const source = syntheticVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /\(n\|\|t\)&&\(n\|\|\(e\?\.available\?\?!0\)\)&&e\?\.accessRequired!==!0/);
  assert.equal(applyLinuxRemoteControlVisibilityPatch(patched), patched);
});

test("Linux remote-control visibility patch handles current settings bundle shape", () => {
  const source = syntheticCurrentVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /return\(n\|\|t\)&&\(n\|\|\(e\?\.available\?\?!0\)\)/);
  assert.equal(applyLinuxRemoteControlVisibilityPatch(patched), patched);
});

test("Linux remote-control settings UX patch hides unsupported outbound tab and removes Mac copy", () => {
  const source = syntheticSettingsBundle();
  const patched = applyLinuxRemoteControlSettingsUxPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlSettingsTabs/);
  assert.match(patched, /e\.filter\(e=>e\.key!==`access-other-devices`\)/);
  assert.match(patched, /if\(e===`access-other-devices`\)return t\?`control-this-mac`:`ssh`/);
  assert.match(patched, /Control this computer/);
  assert.match(patched, /Control this computer from your phone or other device/);
  assert.match(patched, /Add a device to control this computer remotely/);
  assert.match(patched, /Devices that can control this computer/);
  assert.match(patched, /Keep computer awake/);
  assert.match(patched, /Allow this computer to be discovered and controlled/);
  assert.doesNotMatch(patched, /Control this Mac/);
  assert.doesNotMatch(patched, /this Mac/);
  assert.equal(applyLinuxRemoteControlSettingsUxPatch(patched), patched);
});

test("Linux remote-control selected-tab fallback avoids outbound control on Linux", () => {
  const patched = applyLinuxRemoteControlSettingsUxPatch(syntheticSelectedTabBundle());
  const context = {
    navigator: { userAgent: "Linux x86_64" },
    module: { exports: {} },
  };
  vm.runInNewContext(`${patched};module.exports=rr;`, context);
  const resolveTab = context.module.exports;

  assert.equal(
    resolveTab({
      selectedConnectionsTab: "access-other-devices",
      showControlThisMacTab: true,
      showRemoteControlConnectionsSection: true,
      showTabbedSshPage: true,
    }),
    "control-this-mac",
  );
  assert.equal(
    resolveTab({
      selectedConnectionsTab: "access-other-devices",
      showControlThisMacTab: false,
      showRemoteControlConnectionsSection: true,
      showTabbedSshPage: true,
    }),
    "ssh",
  );
});

test("Linux remote-connections refresh patch shortens polling and refreshes on resume signals", () => {
  const source = syntheticSettingsRefreshBundle();
  const patched = applyLinuxRemoteConnectionsRefreshPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /Qn=5e3/);
  assert.doesNotMatch(patched, /Qn=15e3/);
  assert.match(patched, /codexLinuxRemoteConnectionsRefreshNow/);
  assert.match(patched, /document\.addEventListener\(`visibilitychange`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.addEventListener\(`focus`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.addEventListener\(`online`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.addEventListener\(`resume`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /document\.removeEventListener\(`visibilitychange`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.removeEventListener\(`resume`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.equal(applyLinuxRemoteConnectionsRefreshPatch(patched), patched);
});

test("Linux remote-connections refresh patch warns when upstream refresh needles drift", () => {
  const source = "const marker=`refresh-remote-connections`;window.setInterval(()=>marker,15e3);";
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteConnectionsRefreshPatch(source));

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("refresh interval constant")));
  assert.ok(warnings.some((warning) => warning.includes("auto-refresh effect")));
});

test("Linux remote mobile Chrome bridge patch preserves Chrome when request metadata narrows browser backends", () => {
  const source = syntheticChromeBrowserClientBundle();
  const patched = applyLinuxRemoteMobileChromeBridgePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileBrowserBackends/);
  assert.match(patched, /codexLinuxRemoteMobileBrowserBridgeDiagnostic/);
  assert.match(patched, /Chrome bridge was not exposed to this remote\/mobile session/);
  assert.equal(applyLinuxRemoteMobileChromeBridgePatch(patched), patched);

  const context = {
    globalThis: {
      nodeRepl: {
        requestMeta: {
          "x-codex-browser-use-available-backends": ["iab"],
        },
      },
    },
    module: { exports: {} },
    process: { platform: "linux" },
  };
  context.globalThis.globalThis = context.globalThis;
  const nativePipeIndex = patched.indexOf("function codexLinuxRemoteMobileBrowserBridgeDiagnostic");
  const browserBackendsOnly = patched.slice(0, nativePipeIndex) + patched.slice(patched.indexOf("function yC"));
  vm.runInNewContext(`${browserBackendsOnly};module.exports=yC;`, context);
  assert.deepEqual([...context.module.exports()], ["chrome", "iab"]);
});

test("Linux remote mobile Chrome bridge patch warns when browser-client needles drift", () => {
  const source = "var tE=\"x-codex-browser-use-available-backends\";function yC(){return null}";
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteMobileChromeBridgePatch(source));

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("backend allowlist needles")));
});

test("patched Linux device-key provider can create, sign with, and delete a key", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-store-"));
  try {
    const patched = applyLinuxRemoteControlDeviceKeyPatch(syntheticMainBundle());
    const context = {
      Buffer,
      Date,
      Error,
      JSON,
      Promise,
      console,
      __filename: path.join(configHome, "main.js"),
      module: { exports: {} },
      process: {
        env: { XDG_CONFIG_HOME: configHome },
        pid: process.pid,
        platform: "linux",
      },
      require,
    };

    vm.runInNewContext(`${patched};module.exports=wV({resourcesPath:null});`, context);
    const client = context.module.exports;
    const created = await client.createDeviceKey("allow_os_protected_nonextractable");
    assert.equal(created.algorithm, "ecdsa_p256_sha256");
    assert.equal(created.protectionClass, "os_protected_nonextractable");
    assert.match(created.publicKeySpkiDerBase64, /^[A-Za-z0-9+/]+=*$/);

    const readBack = await client.getDeviceKeyPublic(created.keyId);
    assert.deepEqual(readBack, created);

    const signature = await client.signDeviceKey(created.keyId, {
      type: "remoteControlClientEnrollment",
      nonce: "test",
    });
    assert.equal(signature.algorithm, "ecdsa_p256_sha256");
    assert.match(signature.signatureDerBase64, /^[A-Za-z0-9+/]+=*$/);
    assert.match(signature.signedPayloadBase64, /^[A-Za-z0-9+/]+=*$/);

    const storePath = path.join(configHome, "codex-desktop", "remote-control-device-keys-v1.json");
    assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);

    await client.deleteDeviceKey(created.keyId);
    await assert.rejects(() => client.getDeviceKeyPublic(created.keyId), /not found/);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("remote mobile control feature participates in ASAR patching and reports", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    withFeatureRootEnv(root, () => {
      const source = syntheticMainBundle();
      const patched = patchMainBundleSource(source, null);
      assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
      assert.match(patched, /n\.kind===`local`&&process\.platform!==`linux`/);

      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), source);
        fs.writeFileSync(
          path.join(assetsDir, "remote-connection-visibility-test.js"),
          syntheticRemoteConnectionVisibilityBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "remote-control-connections-visibility-test.js"),
          syntheticVisibilityBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "remote-connections-settings-test.js"),
          syntheticSettingsBundle() + syntheticSettingsRefreshBundle(),
        );

        const report = createPatchReport();
        patchExtractedApp(tempApp, { report });

        const patchedFile = fs.readFileSync(path.join(buildDir, "main.js"), "utf8");
        const patchedVisibilityFile = fs.readFileSync(
          path.join(assetsDir, "remote-control-connections-visibility-test.js"),
          "utf8",
        );
        const patchedRemoteConnectionVisibilityFile = fs.readFileSync(
          path.join(assetsDir, "remote-connection-visibility-test.js"),
          "utf8",
        );
        const patchedSettingsFile = fs.readFileSync(
          path.join(assetsDir, "remote-connections-settings-test.js"),
          "utf8",
        );
        assert.match(patchedFile, /codexLinuxRemoteControlDeviceKeyClient/);
        assert.match(patchedFile, /n\.kind===`local`&&process\.platform!==`linux`/);
        assert.match(patchedRemoteConnectionVisibilityFile, /codexLinuxRemoteControlLoadGateEnabled/);
        assert.match(patchedVisibilityFile, /navigator\.userAgent\.includes\(`Linux`\)/);
        assert.match(patchedSettingsFile, /codexLinuxRemoteControlSettingsTabs/);
        assert.match(patchedSettingsFile, /codexLinuxRemoteConnectionsRefreshNow/);
        assert.match(patchedSettingsFile, /Qn=5e3/);
        assert.match(patchedSettingsFile, /Control this computer/);
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-device-key" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "linux-remote-control-config-preservation" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-preserve-config" &&
            patch.status === "already-applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-load-gate" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-visibility" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-settings-ux" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-connections-refresh" &&
            patch.status === "applied",
          ),
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});
