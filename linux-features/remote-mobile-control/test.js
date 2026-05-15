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
      "feature:remote-mobile-control:linux-remote-control-visibility",
      "feature:remote-mobile-control:linux-remote-control-settings-ux",
      "feature:remote-mobile-control:linux-remote-connections-refresh",
    ]);
    assert.deepEqual(descriptors.map((descriptor) => descriptor.phase), [
      "main-bundle",
      "main-bundle",
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

test("Linux remote-control visibility patch allows Linux when upstream marks availability false", () => {
  const source = syntheticVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /\(n\|\|t\)&&\(n\|\|\(e\?\.available\?\?!0\)\)&&e\?\.accessRequired!==!0/);
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
        const patchedSettingsFile = fs.readFileSync(
          path.join(assetsDir, "remote-connections-settings-test.js"),
          "utf8",
        );
        assert.match(patchedFile, /codexLinuxRemoteControlDeviceKeyClient/);
        assert.match(patchedFile, /n\.kind===`local`&&process\.platform!==`linux`/);
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
            patch.name === "feature:remote-mobile-control:linux-remote-control-preserve-config" &&
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
