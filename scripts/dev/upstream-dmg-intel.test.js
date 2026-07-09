"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  buildIntelReports,
  compareProtectedSurfaces,
  createInventory,
  createNewCapabilityMap,
  createPlatformGateMap,
  extractVersionMetadata,
  extractProtectedSurfaces,
  findPostPatchIntegrityFindings,
  mergeProvenance,
  renderActionPlanMarkdown,
  resolveBaselinePath,
} = require("../lib/upstream-dmg-intel.js");

const registry = {
  version: 1,
  surfaces: [
    {
      id: "sky_computer_use_client",
      title: "Sky Computer Use client",
      category: "native",
      pathPatterns: ["SkyComputerUseClient", "native/sky\\.node"],
      contentNeedles: ["SkyComputerUseClient", "event_stream", "recording_controls"],
      nativeStringNeedles: ["SkyComputerUseClient", "recording_controls"],
      linuxSubstrate: {
        requiredPaths: ["computer-use-linux/src/server.rs"],
      },
    },
    {
      id: "record_and_replay_event_stream",
      title: "Record & Replay event stream MCP",
      category: "plugin",
      pathPatterns: ["record-and-replay"],
      contentNeedles: ["event_stream_start", "browser_trace", "speech_context"],
      pluginIds: ["record-and-replay"],
      linuxSubstrate: {
        requiredPaths: ["record-replay-linux/src/main.rs"],
      },
    },
    {
      id: "chrome_native_messaging",
      title: "Chrome native messaging plugin",
      category: "plugin",
      pathPatterns: ["plugins/openai-bundled/plugins/chrome"],
      contentNeedles: ["nativeMessaging", "codex-chrome-extension-host"],
      pluginIds: ["chrome"],
      linuxSubstrate: {
        requiredPaths: ["computer-use-linux/src/bin/codex-chrome-extension-host.rs"],
      },
    },
    {
      id: "dictation_transcript_finalization",
      title: "Dictation transcript finalization",
      category: "webview",
      pathPatterns: ["composer"],
      contentNeedles: ["finalizeTranscript", "dictation", "transcript"],
      linuxSubstrate: {
        requiredPaths: ["linux-features/conversation-mode/patches.js"],
      },
    },
    {
      id: "chronicle_sidecar",
      title: "Chronicle sidecar",
      category: "native",
      pathPatterns: ["codex_chronicle"],
      contentNeedles: ["codex_chronicle", "session.json", "events.jsonl"],
      nativeStringNeedles: ["codex_chronicle", "events.jsonl"],
      linuxSubstrate: {
        requiredPaths: ["record-replay-linux/src/chronicle.rs"],
      },
    },
    {
      id: "chronicle_settings_toggles",
      title: "Chronicle settings toggle paths",
      category: "webview",
      pathPatterns: ["personalization-settings"],
      contentNeedles: [
        "chronicleSidecarPresent",
        "chronicleSidecarProcessState",
        "rememberConsentAccepted",
        "mutateAsync({enabled:!0})",
        "mutateAsync({enabled:!1})",
        "chronicleDisable",
        "memoryFeatureEnabled",
        "generateMemoriesEnabled",
        "useMemoriesEnabled",
      ],
      requiredEvidence: [
        {
          id: "dedicated-chronicle-preview-row",
          pathPatterns: ["personalization-settings"],
          contentNeedles: [
            "settings.general.experimentalFeatures.chronicle.name",
            "chronicleSidecarPresent",
            "chronicleSidecarProcessState",
            "rememberConsentAccepted",
            "mutateAsync({enabled:!0})",
            "mutateAsync({enabled:!1})",
          ],
        },
        {
          id: "memory-master-toggle-chronicle-disable",
          pathPatterns: ["personalization-settings"],
          contentNeedles: [
            "function un",
            "chronicleDisable",
            "Promise.allSettled",
            "memoryFeatureEnabled",
            "generateMemoriesEnabled",
            "useMemoriesEnabled",
          ],
        },
      ],
      linuxSubstrate: {
        requiredPaths: ["linux-features/record-and-replay"],
      },
    },
    {
      id: "future_skysight_bridge",
      title: "Future Skysight bridge",
      category: "bridge",
      pathPatterns: ["future-skysight"],
      contentNeedles: ["futureSkysightBridge", "sky_snapshot_v2"],
      linuxSubstrate: {
        requiredPaths: ["linux-features/future-skysight/patch.js"],
      },
    },
  ],
};

function withTempDir(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-intel-test-"));
  try {
    return fn(workspace);
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, mode == null ? undefined : { mode });
}

function createFixtureApp(root, variant = "baseline") {
  const appDir = path.join(root, `${variant}.app`);
  const resources = path.join(appDir, "Contents/Resources");
  const asarExtracted = path.join(resources, "app.asar.extracted");
  const recordPlugin = path.join(resources, "plugins/openai-bundled/plugins/record-and-replay");
  const chromePlugin = path.join(resources, "plugins/openai-bundled/plugins/chrome");

  writeJson(path.join(resources, "package.json"), {
    name: "codex-desktop",
    version: variant === "candidate" ? "2026.7.3" : "2026.7.2",
  });

  const skyPayload =
    "Mach-O SkyComputerUseClient event_stream recording_controls metadataPath eventsPath";
  const skyPath =
    variant === "candidate"
      ? path.join(resources, "native/sky/sky.node")
      : path.join(resources, "native/sky.node");
  writeFile(skyPath, skyPayload, 0o755);

  if (variant === "candidate") {
    writeFile(
      path.join(resources, "codex_chronicle"),
      "Mach-O codex_chronicle session.json events.jsonl skysight_trace",
      0o755,
    );
    writeFile(
      path.join(asarExtracted, "future-skysight-bridge.js"),
      "ipcMain.handle('futureSkysightBridge', () => sky_snapshot_v2())",
    );
  }

  if (variant !== "candidate") {
    writeFile(
      path.join(asarExtracted, "composer/transcript.js"),
      "function finalizeTranscript(dictation, transcript) { return transcript.final; }",
    );
  }

  writeFile(
    path.join(asarExtracted, "main/bridge.js"),
    "ipcMain.handle('event_stream_start', start); ipcMain.handle('browser_trace', trace);",
  );
  writeFile(
    path.join(asarExtracted, "main/minified-bridge.js"),
    "const a='linux-record-replay-skysight-start',b=`speech_context`,c=\"focused_window\",d='computer-use-plugin-icon.png';ipcMain.handle(x,y);",
  );

  const broadMemoryToggle =
    variant === "missing-memory-chronicle-disable"
      ? ""
      : "async function un({chronicleDisable,previousState,selectedEnabled,featureWrite,configWrite}){await Promise.allSettled([featureWrite(),configWrite(),chronicleDisable?.()??Promise.resolve()]);return {memoryFeatureEnabled:selectedEnabled,generateMemoriesEnabled:selectedEnabled,useMemoriesEnabled:selectedEnabled};}";
  writeFile(
    path.join(resources, "webview/assets/personalization-settings-fixture.js"),
    [
      "function fn(){",
      "const name='settings.general.experimentalFeatures.chronicle.name';",
      "const state={chronicleSidecarPresent:true,chronicleSidecarProcessState:'running'};",
      "const enable=async({rememberConsentAccepted})=>o.mutateAsync({enabled:!0});",
      "const disable=async()=>o.mutateAsync({enabled:!1});",
      "return {name,state,enable,disable};",
      "}",
      broadMemoryToggle,
    ].join(""),
  );

  writeJson(path.join(recordPlugin, ".codex-plugin/plugin.json"), {
    id: "record-and-replay",
    name: "record-and-replay",
    version: "1.0.0",
    mcpServers: {
      "event-stream": {
        command: "SkyComputerUseClient",
      },
    },
    skills: [{ name: "record-and-replay", path: "skills/record-and-replay/SKILL.md" }],
  });
  writeJson(path.join(recordPlugin, ".mcp.json"), {
    mcpServers: {
      "event-stream": {
        command: "SkyComputerUseClient",
        tools:
          variant === "candidate"
            ? ["event_stream_start", "browser_trace", "speech_context", "skysight_snapshot"]
            : ["event_stream_start", "browser_trace", "speech_context"],
      },
    },
  });
  writeFile(
    path.join(recordPlugin, "skills/record-and-replay/SKILL.md"),
    "Use event_stream_start, browser_trace, and speech_context to compile reusable skills.",
  );

  writeJson(path.join(chromePlugin, ".codex-plugin/plugin.json"), {
    id: "chrome",
    name: "chrome",
    version: "1.0.0",
  });
  writeFile(
    path.join(chromePlugin, "browser-client.mjs"),
    "const nativeMessaging = 'codex-chrome-extension-host';",
  );

  return appDir;
}

function addSitesPlugin(appDir) {
  const sitesPlugin = path.join(
    appDir,
    "Contents/Resources/plugins/openai-bundled/plugins/sites",
  );
  writeJson(path.join(sitesPlugin, ".app.json"), {
    apps: {
      sites: {
        id: "connector_20205bf7d4e99a89d7154bb849718324",
      },
    },
  });
  writeJson(path.join(sitesPlugin, ".codex-plugin/plugin.json"), {
    name: "sites",
    version: "0.1.21",
    description: "Build and deploy websites with Sites.",
    skills: "./skills/",
    apps: "./.app.json",
    interface: {
      displayName: "Sites",
      shortDescription: "Build and deploy websites with Sites",
      termsOfServiceURL: "https://openai.com/policies/chatgpt-sites-terms/",
      category: "Productivity",
    },
  });
  writeFile(
    path.join(sitesPlugin, "skills/sites-building/SKILL.md"),
    "Use Sites to build and deploy websites.",
  );
}

function writeBundledPlugin(appDir, pluginId, manifest = {}) {
  const pluginRoot = path.join(appDir, "Contents/Resources/plugins/openai-bundled/plugins", pluginId);
  writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), {
    id: pluginId,
    name: pluginId,
    version: "1.0.0",
    ...manifest,
  });
  return pluginRoot;
}

function findClassification(driftReport, surfaceId, classification) {
  return driftReport.surfaceDrift.find(
    (entry) => entry.surfaceId === surfaceId && entry.classification === classification,
  );
}

test("extracts protected surfaces, plugins, native binaries, and bridge calls from a fixture app", () =>
  withTempDir((workspace) => {
    const appDir = createFixtureApp(workspace, "baseline");

    const inventory = createInventory({ registry, sourcePath: appDir });
    const protectedSurfaces = extractProtectedSurfaces({
      inventory,
      registry,
      repoRoot: process.cwd(),
    });

    assert.equal(inventory.source.kind, "app");
    assert.ok(
      inventory.files.some((file) => file.relativePath.endsWith("plugins/openai-bundled/plugins/chrome/browser-client.mjs")),
    );
    assert.equal(protectedSurfaces.surfacesById.sky_computer_use_client.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.record_and_replay_event_stream.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.chrome_native_messaging.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.chronicle_settings_toggles.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.chronicle_sidecar.status, "MISSING");
    assert.ok(
      protectedSurfaces.surfacesById.chronicle_settings_toggles.satisfiedAnchors.some(
        (anchor) => anchor.id === "memory-master-toggle-chronicle-disable",
      ),
    );
    assert.ok(
      protectedSurfaces.surfacesById.chronicle_settings_toggles.requiredAnchors
        .flatMap((anchor) => anchor.matchedNeedles)
        .some((hit) => hit.needle === "chronicleDisable"),
    );
    assert.ok(
      protectedSurfaces.pluginMap.plugins.some((plugin) => plugin.id === "record-and-replay"),
    );
    assert.ok(
      protectedSurfaces.bridgeMap.handlers.some((handler) => handler.name === "event_stream_start"),
    );
    assert.ok(
      protectedSurfaces.bridgeMap.channelCandidates.some(
        (candidate) => candidate.name === "linux-record-replay-skysight-start",
      ),
    );
    assert.ok(
      protectedSurfaces.bridgeMap.channelCandidates.some(
        (candidate) => candidate.name === "speech_context",
      ),
    );
    assert.ok(
      protectedSurfaces.bridgeMap.channelCandidates.every(
        (candidate) => candidate.name !== "computer-use-plugin-icon.png",
      ),
    );
    assert.ok(
      protectedSurfaces.nativeBinaryMap.binaries.some((binary) =>
        binary.relativePath.endsWith("native/sky.node"),
      ),
    );
  }));

test("marks Chronicle settings toggle surface partial when the Memory master toggle path disappears", () =>
  withTempDir((workspace) => {
    const appDir = createFixtureApp(workspace, "missing-memory-chronicle-disable");
    const protectedSurfaces = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: appDir }),
      registry,
      repoRoot: process.cwd(),
    });
    const surface = protectedSurfaces.surfacesById.chronicle_settings_toggles;
    assert.equal(surface.status, "PARTIAL");
    assert.ok(
      surface.satisfiedAnchors.some((anchor) => anchor.id === "dedicated-chronicle-preview-row"),
    );
    assert.ok(
      surface.missingAnchors.some((anchor) => anchor.id === "memory-master-toggle-chronicle-disable"),
    );
    assert.ok(
      surface.missingAnchors
        .find((anchor) => anchor.id === "memory-master-toggle-chronicle-disable")
        .missingNeedles.includes("chronicleDisable"),
    );
  }));

test("classifies protected-surface drift from baseline to candidate", () =>
  withTempDir((workspace) => {
    const baselineApp = createFixtureApp(workspace, "baseline");
    const candidateApp = createFixtureApp(workspace, "candidate");
    const baseline = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: baselineApp }),
      registry,
      repoRoot: process.cwd(),
    });
    const candidate = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
      registry,
      repoRoot: process.cwd(),
    });

    const driftReport = compareProtectedSurfaces({
      baseline,
      candidate,
      patchReport: {
        patches: [
          {
            name: "record-and-replay bridge patch",
            status: "skipped-optional",
            reason: "upstream bridge marker moved",
            surfaceId: "record_and_replay_event_stream",
          },
        ],
      },
    });

    assert.ok(findClassification(driftReport, "sky_computer_use_client", "MOVED"));
    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PAYLOAD_CHANGED"));
    assert.ok(findClassification(driftReport, "chrome_native_messaging", "UNCHANGED"));
    assert.ok(findClassification(driftReport, "dictation_transcript_finalization", "REMOVED"));
    assert.ok(findClassification(driftReport, "chronicle_sidecar", "NEW_UPSTREAM_CAPABILITY"));
    assert.ok(findClassification(driftReport, "future_skysight_bridge", "LINUX_SUBSTRATE_GAP"));
    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PATCH_REVIEW"));
    assert.ok(!findClassification(driftReport, "record_and_replay_event_stream", "PATCH_BROKEN"));
  }));

test("classifies required patch-report failures as acceptance blockers", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const candidate = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
      registry,
      repoRoot: process.cwd(),
    });

    const driftReport = compareProtectedSurfaces({
      candidate,
      patchReport: {
        patches: [
          {
            name: "record-and-replay bridge patch",
            status: "failed-required",
            reason: "upstream bridge marker moved",
            surfaceId: "record_and_replay_event_stream",
          },
        ],
      },
    });

    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PATCH_BROKEN"));
    assert.ok(!findClassification(driftReport, "record_and_replay_event_stream", "PATCH_REVIEW"));
  }));

test("classifies unresolved Linux settings patch symbols as acceptance blockers", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const assetsDir = path.join(candidateApp, "Contents/Resources/webview/assets");
    writeFile(
      path.join(assetsDir, "settings-page-bad-linux-patch.js"),
      'var icons={"agent-workspaces":codexLinuxAgentWorkspaceSettingsIcon,worktrees:WorktreesIcon};',
    );
    writeFile(
      path.join(assetsDir, "settings-page-bare-assignment.js"),
      "codexLinuxReadAloudSettingsIcon=e=>null;var icons={read:codexLinuxReadAloudSettingsIcon};",
    );
    writeFile(
      path.join(assetsDir, "settings-page-comma-assignment.js"),
      "foo(),codexLinuxHooksSettingsIcon=e=>null;var icons={hooks:codexLinuxHooksSettingsIcon};",
    );
    writeFile(
      path.join(assetsDir, "settings-page-nested-assignment.js"),
      "var init=()=>{codexLinuxMcpSettingsIcon=e=>null};var icons={mcp:codexLinuxMcpSettingsIcon};",
    );
    writeFile(
      path.join(assetsDir, "settings-page-good-direct-declaration.js"),
      "var codexLinuxDeclaredSettingsIcon=e=>null;var icons={declared:codexLinuxDeclaredSettingsIcon};",
    );
    writeFile(
      path.join(assetsDir, "settings-page-good-comma-declaration.js"),
      "var existing=1,codexLinuxCommaDeclaredSettingsIcon=e=>null;var icons={declared:codexLinuxCommaDeclaredSettingsIcon};",
    );

    const candidate = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
      registry,
      repoRoot: process.cwd(),
    });
    const driftReport = compareProtectedSurfaces({ candidate });

    const finding = findClassification(driftReport, "linux_patch_integrity", "PATCH_INTEGRITY_BROKEN");
    assert.ok(finding);
    assert.equal(finding.category, "patch-integrity");
    const findingPaths = new Set(finding.findings.map((entry) => path.basename(entry.path)));
    assert.ok(findingPaths.has("settings-page-bad-linux-patch.js"));
    assert.ok(findingPaths.has("settings-page-bare-assignment.js"));
    assert.ok(findingPaths.has("settings-page-comma-assignment.js"));
    assert.ok(findingPaths.has("settings-page-nested-assignment.js"));
    assert.equal(findingPaths.has("settings-page-good-direct-declaration.js"), false);
    assert.equal(findingPaths.has("settings-page-good-comma-declaration.js"), false);
  }));

test("folds patch-report post-patch integrity findings into candidate-only reports", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "post-patch-integrity-report");
    const patchReportPath = path.join(workspace, "patch-report.json");
    writeJson(patchReportPath, {
      patches: [],
      postPatchIntegrity: {
        sourcePath: path.join(workspace, "app-extracted"),
        findingCount: 1,
        findings: [
          {
            path: "webview/assets/settings-page-patched.js",
            reason: "Linux settings patch symbol is referenced without a local declaration",
            snippet: '"agent-workspaces":codexLinuxAgentWorkspaceSettingsIcon',
            symbol: "codexLinuxAgentWorkspaceSettingsIcon",
          },
        ],
      },
    });

    const reports = buildIntelReports({
      autoBaseline: false,
      candidatePath: candidateApp,
      outputDir,
      patchReportPath,
      registry,
      repoRoot: process.cwd(),
    });

    const finding = findClassification(reports.driftReport, "linux_patch_integrity", "PATCH_INTEGRITY_BROKEN");
    assert.ok(finding);
    assert.equal(finding.findingCount, 1);
    assert.equal(finding.findings[0].path, "webview/assets/settings-page-patched.js");
  }));

test("detects post-patch Computer Use gates left Darwin/Windows-only", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const assetsDir = path.join(candidateApp, "Contents/Resources/webview/assets");
    writeFile(
      path.join(assetsDir, "use-native-apps-current.js"),
      "function zN(e){let t=(0,BN.c)(9),{enabled:n}=e,{platform:r,isLoading:i}=pi(),a=n&&(r===`macOS`||r===`windows`),o;t[0]===Symbol.for(`react.memo_cache_sentinel`)?(o={order:`usage`},t[0]=o):o=t[0];let s;t[1]===a?s=t[2]:(s={params:o,queryConfig:{enabled:a,staleTime:m.FIVE_MINUTES,refetchOnWindowFocus:!1}},t[1]=a,t[2]=s);let c=Ne(`native-desktop-apps`,s),l;t[3]!==c||t[4]!==a?(l=a?c.data?.apps??[]:[],t[3]=c,t[4]=a,t[5]=l):l=t[5];let u=i||a&&c.isLoading,d;return t[6]!==l||t[7]!==u?(d={nativeApps:l,isLoading:u},t[6]=l,t[7]=u,t[8]=d):d=t[8],d}",
    );
    writeFile(
      path.join(assetsDir, "composer-computer-use-current.js"),
      "function z2e(){let T=s===`macOS`||s===`windows`,E=T?U2e(C):[],D=T&&l?C.filter(Tie):[],O=T&&l?C.filter(lae):[],N=D2e({chromeAppPlugins:E,computerUsePlugin:w,microsoftExcelAppPlugins:D,microsoftPowerPointAppPlugins:O,onPluginMentionInserted:M,pluginMentionLabels:x,query:r});return N}",
    );
    writeFile(
      path.join(assetsDir, "computer-use-settings-current.js"),
      "r===`linux`&&!v.availablePlugins.some(e=>e.plugin?.name===on||e.plugin?.id?.split(`@`)[0]===on)&&(v={...v,availablePlugins:[...v.availablePlugins,{marketplaceName:`openai-curated`,marketplacePath:y,logoPath:new URL(`computer-use-plugin-icon-linux.png`,import.meta.url).href,logoDarkPath:new URL(`computer-use-plugin-icon-linux.png`,import.meta.url).href,plugin:{id:on,name:on,installed:!0,enabled:!0}}]});",
    );
    writeFile(
      path.join(assetsDir, "computer-use-settings-card-current.js"),
      "function Rt(){let b=flag,r=platform,O=[getApp()],F=[];if(b&&(r===`macOS`||r===`windows`))for(let e of O){if(e.plugin==null)continue;let t=e.plugin;F.push({id:e.appControlId,label:e.toggleAriaLabel,installed:t.plugin.installed,enabled:t.plugin.enabled})}return F}",
    );
    writeFile(
      path.join(assetsDir, "computer-use-native-icon-current.js"),
      "function nI(e){let t=(0,rI.c)(10),{appPath:n}=e,{platform:r,isLoading:i}=pi(),a=(r===`macOS`||r===`windows`)&&n!=null&&n!==``,o=n??``;let u=Ne(`computer-use-native-desktop-app-icon`,l),d=a?u.data?.iconSmall??null:null;return d}",
    );

    const inventory = createInventory({ registry, sourcePath: candidateApp });

    assert.equal(
      findPostPatchIntegrityFindings(inventory).some((finding) =>
        finding.symbol.startsWith("computer-use-"),
      ),
      false,
    );
    const findings = findPostPatchIntegrityFindings(inventory, {
      includeComputerUsePlatformGates: true,
    });
    assert.deepEqual(
      findings.map((finding) => finding.symbol).filter((symbol) => symbol.startsWith("computer-use-")).sort(),
      [
        "computer-use-composer-native-app-mentions-linux-gate",
        "computer-use-native-app-icon-linux-gate",
        "computer-use-native-apps-linux-gate",
        "computer-use-settings-native-app-card-linux-gate",
        "computer-use-settings-synthetic-plugin-mask",
      ],
    );
  }));

test("categorizes platform gates for Linux parity, unsupported features, and review candidates", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const assetsDir = path.join(candidateApp, "Contents/Resources/webview/assets");
    writeFile(
      path.join(assetsDir, "computer-use-current.js"),
      "function zN(e){let {enabled:n}=e,{platform:r}=pi(),a=n&&(r===`macOS`||r===`windows`);let c=Ne(`native-desktop-apps`,{queryConfig:{enabled:a}});return {nativeApps:c.data?.apps??[],computerUsePlugin:w}}",
    );
    writeFile(
      path.join(assetsDir, "computer-use-settings-B1QCeMSP.js"),
      "function settings(){let b=flag,r=platform,O=[getApp()],F=[];if(b&&(r===`macOS`||r===`windows`))for(let e of O){if(e.plugin==null)continue;let t=e.plugin;F.push({id:e.appControlId,label:e.toggleAriaLabel,installed:t.plugin.installed,enabled:t.plugin.enabled})}return F}",
    );
    writeFile(
      path.join(assetsDir, "computer-use-native-icon-current.js"),
      "function nI(e){let t=(0,rI.c)(10),{appPath:n}=e,{platform:r,isLoading:i}=pi(),a=(r===`macOS`||r===`windows`)&&n!=null&&n!==``,o=n??``;let u=Ne(`computer-use-native-desktop-app-icon`,l),d=a?u.data?.iconSmall??null:null;return d}",
    );
    writeFile(
      path.join(assetsDir, "office-current.js"),
      "function z2e(){let T=s===`macOS`||s===`windows`;return D2e({microsoftExcelAppPlugins:D,microsoftPowerPointAppPlugins:O,onPluginMentionInserted:M})}",
    );
    writeFile(
      path.join(assetsDir, "hotkey-current.js"),
      "function hotkeys(){return process.platform===`darwin`||process.platform===`win32`?{setToggleHotkey:()=>true,syncCommandKeybindings:()=>true}:null}",
    );
    writeFile(
      path.join(assetsDir, "agi-skysight-supreme.js"),
      "function supreme(){let ok=p===`macOS`||p===`windows`;return ok?`AGI Intelligence 9000 Skysight Supreme native desktop sidecar`:null}",
    );
    writeFile(
      path.join(assetsDir, "titlebar-current.js"),
      "function titlebar(){return process.platform===`darwin`||process.platform===`win32`?{titleBarStyle:`hiddenInset`,trafficLightPosition:{x:12,y:12}}:{}}",
    );

    const platformGateMap = createPlatformGateMap({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
    });
    const byCategory = new Map(platformGateMap.gates.map((gate) => [gate.category, gate]));

    assert.ok(byCategory.get("linux-parity-drift"));
    assert.equal(byCategory.get("linux-parity-drift").linuxSurfaceId, "computer_use_plugin");
    assert.ok(
      platformGateMap.gates
        .filter((gate) => gate.path.includes("computer-use"))
        .every((gate) => gate.category === "linux-parity-drift"),
    );
    assert.ok(
      platformGateMap.gates.some(
        (gate) =>
          gate.feature === "Computer Use settings native app cards" &&
          gate.patchTarget === "scripts/patches/impl/computer-use.js",
      ),
    );
    assert.ok(
      platformGateMap.gates.some(
        (gate) =>
          gate.feature === "Computer Use native app icons" &&
          gate.patchTarget === "scripts/patches/impl/computer-use.js",
      ),
    );
    assert.ok(byCategory.get("platform-specific-unsupported"));
    assert.match(byCategory.get("platform-specific-unsupported").recommendation, /macOS\/Windows-only/);
    assert.ok(
      platformGateMap.gates.some(
        (gate) =>
          gate.category === "platform-specific-unsupported" &&
          gate.feature === "Global hotkey/keybinding integration",
      ),
    );
    assert.ok(byCategory.get("new-upstream-capability"));
    assert.match(byCategory.get("new-upstream-capability").feature, /Unmapped/);
    assert.ok(byCategory.get("expected-platform-native"));
    assert.equal(platformGateMap.blockingCount, 3);
  }));

test("does not treat generic Computer Use mentions as Linux parity drift without exact contracts", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const assetsDir = path.join(candidateApp, "Contents/Resources/webview/assets");
    writeFile(
      path.join(assetsDir, "computer-use-marketing-current.js"),
      "function teaser(){let allowed=p===`macOS`||p===`windows`;return allowed?`computer use desktop preview`:null}",
    );

    const platformGateMap = createPlatformGateMap({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
    });
    const gate = platformGateMap.gates.find((entry) =>
      entry.path.endsWith("computer-use-marketing-current.js"),
    );

    assert.ok(gate);
    assert.equal(gate.category, "needs-review");
  }));

test("maps Chronicle and Skysight platform gates to the record-and-replay Linux owners", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const assetsDir = path.join(candidateApp, "Contents/Resources/webview/assets");
    writeFile(
      path.join(assetsDir, "chronicle-settings-current.js"),
      "function chronicle(){let allowed=p===`macOS`||p===`windows`;return allowed&&chronicleSidecarPresent&&chronicleSidecarProcessState&&rememberConsentAccepted?o.mutateAsync({enabled:!0}):chronicleDisable?.()}",
    );
    writeFile(
      path.join(assetsDir, "skysight-controls-current.js"),
      "function skysight(){return process.platform===`darwin`||process.platform===`win32`?{status:`linux-record-replay-skysight-status`,snapshot:`skysight_snapshot`,tool:`event_stream_start`}:null}",
    );

    const platformGateMap = createPlatformGateMap({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
    });
    const chronicleGate = platformGateMap.gates.find((entry) =>
      entry.path.endsWith("chronicle-settings-current.js"),
    );
    const skysightGate = platformGateMap.gates.find((entry) =>
      entry.path.endsWith("skysight-controls-current.js"),
    );

    assert.ok(chronicleGate);
    assert.equal(chronicleGate.category, "linux-parity-drift");
    assert.equal(chronicleGate.feature, "Chronicle settings toggle paths");
    assert.equal(chronicleGate.patchTarget, "linux-features/record-and-replay/patch.js");

    assert.ok(skysightGate);
    assert.equal(skysightGate.category, "linux-parity-drift");
    assert.equal(skysightGate.feature, "Skysight controls and bridge");
    assert.equal(
      skysightGate.patchTarget,
      "linux-features/record-and-replay/patch.js and record-replay-linux/src/mcp.rs",
    );
  }));

test("keeps review-only platform gates out of new capability candidates", () => {
  const capabilityMap = createNewCapabilityMap({
    mapDrift: { mode: "baselineComparison" },
    platformGateMap: {
      gates: [
        {
          id: "review-gate",
          category: "needs-review",
          confidence: "low",
          feature: "Unclassified platform gate",
          issueCandidate: false,
          recommendation: "Review manually.",
          patchTarget: "manual review",
          path: "assets/review.js",
          gate: "p===`macOS`||p===`windows`",
        },
        {
          id: "new-gate",
          category: "new-upstream-capability",
          confidence: "medium",
          feature: "New native capability",
          issueCandidate: true,
          recommendation: "Create a Linux feature issue.",
          patchTarget: "linux-features/new-native-capability",
          path: "assets/new.js",
          gate: "p===`macOS`||p===`windows`",
        },
      ],
    },
  });

  assert.ok(capabilityMap.capabilities.some((capability) => capability.id === "platform-gate:new-gate"));
  assert.ok(!capabilityMap.capabilities.some((capability) => capability.id === "platform-gate:review-gate"));
});

test("keeps framework, app-shell, plugin, and dependency binaries out of feature candidates", () => {
  const capabilityMap = createNewCapabilityMap({
    mapDrift: {
      mode: "baselineComparison",
      nativeBinaryDrift: {
        added: [
          "Contents/Frameworks/Codex Framework.framework/Versions/150.0.7871.101/Helpers/browser_crashpad_handler",
          "Contents/MacOS/Codex",
          "Contents/Resources/plugins/openai-bundled/plugins/chrome/extension-host/macos/arm64/ChatGPT for Chrome",
          "Contents/Resources/app.asar.unpacked/node_modules/example/build/Release/example.node",
          "Contents/Resources/codex-code-mode-host",
        ],
      },
    },
    platformGateMap: { gates: [] },
  });

  assert.deepEqual(
    capabilityMap.capabilities.filter((capability) => capability.type === "native-binary").map((capability) => capability.path),
    ["Contents/Resources/codex-code-mode-host"],
  );
});

test("reports Sites as a cross-platform entitlement-gated capability with a staging recommendation", () =>
  withTempDir((workspace) => {
    const baselineApp = createFixtureApp(workspace, "baseline");
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "sites-report");
    addSitesPlugin(candidateApp);

    const reports = buildIntelReports({
      baselinePath: baselineApp,
      candidatePath: candidateApp,
      outputDir,
      registry,
      repoRoot: process.cwd(),
    });
    const sitesCapability = reports.newCapabilityMap.capabilities.find(
      (capability) => capability.name === "Sites",
    );
    const driftMarkdown = fs.readFileSync(path.join(outputDir, "drift-report.md"), "utf8");

    assert.ok(sitesCapability);
    assert.equal(sitesCapability.category, "cross-platform-entitlement-gated");
    assert.equal(sitesCapability.version, "0.1.21");
    assert.equal(sitesCapability.platformLabel, "cross-platform");
    assert.match(
      sitesCapability.entitlementLabel,
      /connector_20205bf7d4e99a89d7154bb849718324/,
    );
    assert.equal(sitesCapability.patchTarget, "scripts/lib/bundled-plugins.sh");
    assert.match(sitesCapability.recommendation, /staging issue/i);
    assert.match(driftMarkdown, /\| Sites \| 0\.1\.21 \| plugin \| cross-platform-entitlement-gated \|/);
    assert.match(
      driftMarkdown,
      /connector_20205bf7d4e99a89d7154bb849718324/,
    );
    assert.doesNotMatch(driftMarkdown, /\[object Object\]/);
    assert.match(driftMarkdown, /\| --- \| --- \| --- \| --- \|/);
  }));

test("emits app, Electron, CLI, and bundled-plugin version deltas", () => {
  const metadata = extractVersionMetadata([
    {
      relativePath: "Contents/Resources/vendor/Info.plist",
      text: "CFBundleShortVersionString 3.2.1 CFBundleVersion 99",
    },
    {
      relativePath: "Contents/Resources/node_modules/canvas/package.json",
      text: '{"version":"3.2.1","dependencies":{"electron":"40.0.0"}}',
    },
    {
      relativePath: "Contents/Resources/codex",
      nativeStrings: ["unrelated protocol version 2.0"],
    },
    {
      relativePath: "Contents/Info.plist",
      text: "CFBundleShortVersionString 1.2.3 CFBundleVersion 456",
    },
    {
      relativePath: "package.json",
      source: "asar",
      text: '{"name":"openai-codex-electron","version":"26.623.141536","devDependencies":{"electron":"42.1.0"}}',
    },
    {
      relativePath: "Contents/Resources/codex",
      nativeStrings: ["codex-cli version 0.99.1"],
    },
    {
      relativePath: "Contents/Resources/plugins/openai-bundled/plugins/sites/.codex-plugin/plugin.json",
      text: '{"version":"0.1.21"}',
    },
  ]);

  assert.equal(metadata.cfBundleShortVersionString, "1.2.3");
  assert.equal(metadata.cfBundleVersion, "456");
  assert.equal(metadata.appPackageVersion, "26.623.141536");
  assert.equal(metadata.electronVersion, "42.1.0");
  assert.equal(metadata.codexCliVersion, "0.99.1");
  assert.equal(metadata.bundledPluginVersions.sites, "0.1.21");
});

test("candidate URL augments detected DMG provenance without dropping hashes", () => {
  assert.deepEqual(
    mergeProvenance(
      {
        candidate: { bytes: 123, sha256: "candidate-sha", etag: "etag", lastModified: "today", url: null },
        baseline: { bytes: 100, sha256: "baseline-sha", etag: null, lastModified: null, url: null },
      },
      { candidate: { url: "https://example.test/Codex.dmg" } },
    ),
    {
      candidate: {
        bytes: 123,
        sha256: "candidate-sha",
        etag: "etag",
        lastModified: "today",
        url: "https://example.test/Codex.dmg",
      },
      baseline: { bytes: 100, sha256: "baseline-sha", etag: null, lastModified: null, url: null },
    },
  );
});

test("production registry protects Sites and exact remote-mobile contracts", () => {
  const productionRegistry = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "scripts/dev/upstream-dmg-protected-surfaces.json"), "utf8"),
  );
  const sites = productionRegistry.surfaces.find((surface) => surface.id === "sites_plugin");
  const remoteMobile = productionRegistry.surfaces.find((surface) => surface.id === "remote_mobile_control");

  assert.ok(sites);
  assert.deepEqual(sites.pluginIds, ["sites"]);
  assert.ok(sites.linuxSubstrate.requiredPaths.includes("scripts/lib/bundled-plugins.sh"));
  assert.ok(remoteMobile);
  assert.ok(remoteMobile.contentNeedles.includes("set-remote-control-connections-enabled"));
  assert.ok(remoteMobile.contentNeedles.includes("remote_control_connections"));
  assert.ok(!remoteMobile.contentNeedles.includes("mobile"));
  assert.ok(!remoteMobile.contentNeedles.includes("control"));
});

test("keeps drift report evidence compact and marks hashed asset churn", () => {
  const baseline = {
    source: { path: "baseline.app" },
    surfacesById: {
      vite_chunk_bridge: {
        id: "vite_chunk_bridge",
        title: "Vite chunk bridge",
        category: "bridge",
        status: "PRESENT",
        evidence: [
          {
            path: ".vite/build/main-CNod9zFW.js",
            sha256: "baseline-hash",
            size: 100,
            source: "asar",
            type: "text",
          },
        ],
      },
    },
  };
  const candidate = {
    source: { path: "candidate.app" },
    surfacesById: {
      vite_chunk_bridge: {
        id: "vite_chunk_bridge",
        title: "Vite chunk bridge",
        category: "bridge",
        status: "PRESENT",
        evidence: [
          {
            path: ".vite/build/main-z6HVz-xR.js",
            sha256: "candidate-hash",
            size: 100,
            source: "asar",
            type: "text",
          },
        ],
      },
    },
  };

  const driftReport = compareProtectedSurfaces({ baseline, candidate });
  const drift = findClassification(driftReport, "vite_chunk_bridge", "MOVED");
  assert.ok(drift);
  assert.equal(drift.baselineEvidence, undefined);
  assert.equal(drift.candidateEvidence, undefined);
  assert.equal(drift.evidenceSummary.baseline.evidenceCount, 1);
  assert.equal(drift.evidenceSummary.candidate.evidenceCount, 1);
  assert.equal(drift.evidenceDrift.pathMovementKind, "hashed_asset_churn");
  assert.equal(drift.evidenceDrift.addedEvidence, undefined);
  assert.equal(drift.evidenceDrift.removedEvidence, undefined);

  const actionPlan = renderActionPlanMarkdown(
    {
      ...driftReport,
      structuralDriftSummary: {
        bridgeHandlers: { addedCount: 0, removedCount: 0 },
        plugins: { addedCount: 0, removedCount: 0 },
        mcpTools: { addedCount: 0, removedCount: 0 },
        nativeBinaries: { addedCount: 0, removedCount: 0, changedCount: 0 },
        hasStructuralAddRemove: false,
      },
    },
    { source: { path: "candidate.app" } },
  );
  assert.match(actionPlan, /review candidate evidence paths before changing Linux substrate/);
  assert.match(actionPlan, /Treat this as a navigation signal/);
  assert.doesNotMatch(
    actionPlan,
    /update patch descriptors, staging paths, and Linux mirror code to the candidate evidence paths/,
  );
});

test("does not collapse multi-hyphen hashed asset stems", () => {
  const baseline = {
    source: { path: "baseline.app" },
    surfacesById: {
      record_asset_bridge: {
        id: "record_asset_bridge",
        title: "Record asset bridge",
        category: "bridge",
        status: "PRESENT",
        evidence: [
          {
            path: ".vite/build/record-and-replay-CNod9zFW.js",
            sha256: "baseline-hash",
            size: 100,
            source: "asar",
            type: "text",
          },
        ],
      },
    },
  };
  const candidate = {
    source: { path: "candidate.app" },
    surfacesById: {
      record_asset_bridge: {
        id: "record_asset_bridge",
        title: "Record asset bridge",
        category: "bridge",
        status: "PRESENT",
        evidence: [
          {
            path: ".vite/build/record-settings-NsW8qoL2.js",
            sha256: "candidate-hash",
            size: 100,
            source: "asar",
            type: "text",
          },
        ],
      },
    },
  };

  const driftReport = compareProtectedSurfaces({ baseline, candidate });
  const drift = findClassification(driftReport, "record_asset_bridge", "MOVED");
  assert.ok(drift);
  assert.equal(drift.evidenceDrift.pathMovementKind, "mixed_hashed_asset_churn");
});

test("writes the expected report bundle for candidate-only and comparison runs", () =>
  withTempDir((workspace) => {
    const baselineApp = createFixtureApp(workspace, "baseline");
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "reports");
    const fakeBin = path.join(workspace, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    for (const tool of ["llvm-nm", "nm"]) {
      writeFile(
        path.join(fakeBin, tool),
        `#!/usr/bin/env bash
set -euo pipefail
test -f "$2"
printf '00000000 T _SkyComputerUseClient\\n'
`,
        0o755,
      );
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;

    let reports;
    try {
      reports = buildIntelReports({
        baselinePath: baselineApp,
        candidatePath: candidateApp,
        outputDir,
        registry,
        repoRoot: process.cwd(),
        timestamp: "2026-07-03T12-00-00Z",
      });
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }

    for (const reportName of [
      "inventory.json",
      "protected-surfaces.json",
      "bridge-map.json",
      "plugin-map.json",
      "native-binary-map.json",
      "platform-gates.json",
      "new-capabilities.json",
      "map-drift.json",
      "drift-report.json",
      "drift-report.md",
      "substrate-action-plan.md",
      "baseline/inventory.json",
      "baseline/plugin-map.json",
      "candidate/inventory.json",
      "candidate/plugin-map.json",
    ]) {
      assert.ok(fs.existsSync(path.join(reports.outputDir, reportName)), reportName);
    }

    const driftReport = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "drift-report.json"), "utf8"),
    );
    const inventory = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "inventory.json"), "utf8"),
    );
    const nativeBinaryMap = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "native-binary-map.json"), "utf8"),
    );
    const platformGateMap = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "platform-gates.json"), "utf8"),
    );
    const newCapabilityMap = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "new-capabilities.json"), "utf8"),
    );
    const mapDrift = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "map-drift.json"), "utf8"),
    );
    const driftMarkdown = fs.readFileSync(path.join(reports.outputDir, "drift-report.md"), "utf8");
    const actionPlan = fs.readFileSync(path.join(reports.outputDir, "substrate-action-plan.md"), "utf8");
    const skyDrift = findClassification(driftReport, "sky_computer_use_client", "MOVED");
    assert.ok(findClassification(driftReport, "chronicle_sidecar", "NEW_UPSTREAM_CAPABILITY"));
    assert.equal(skyDrift.baselineEvidence, undefined);
    assert.equal(skyDrift.candidateEvidence, undefined);
    assert.ok(skyDrift.evidenceSummary.baseline.evidenceCount > 0);
    assert.ok(skyDrift.evidenceDrift.addedPathSamples.length > 0);
    assert.equal(skyDrift.evidenceDrift.addedEvidence, undefined);
    assert.ok(inventory.files.every((file) => file.text == null && file.nativeStrings == null));
    assert.ok(Array.isArray(platformGateMap.gates));
    assert.ok(newCapabilityMap.capabilities.some((capability) => capability.type === "mcp-tool"));
    assert.match(driftMarkdown, /## New Capability Candidates/);
    assert.match(driftMarkdown, /## Linux Parity Drift/);
    assert.ok(
      nativeBinaryMap.binaries.some((binary) =>
        binary.protectedStringHits.some((hit) => hit.needle === "recording_controls"),
      ),
    );
    assert.ok(
      nativeBinaryMap.binaries.some(
        (binary) =>
          binary.symbols?.tool === "llvm-nm -g" &&
          binary.symbols.symbols.includes("00000000 T _SkyComputerUseClient"),
      ),
    );
    assert.equal(mapDrift.mode, "baselineComparison");
    assert.ok(mapDrift.mcpDrift.added.includes("record-and-replay:event-stream:skysight_snapshot"));
    assert.match(actionPlan, /review candidate evidence paths/);
    assert.doesNotMatch(
      actionPlan,
      /update patch descriptors, staging paths, and Linux mirror code to the candidate evidence paths/,
    );
  }));

test("auto-baseline uses repo Codex.dmg when candidate is different", () =>
  withTempDir((workspace) => {
    const repoRoot = path.join(workspace, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    const baselineApp = createFixtureApp(workspace, "baseline");
    const candidateApp = createFixtureApp(workspace, "candidate");
    const baselineCache = path.join(repoRoot, "Codex.dmg");
    fs.cpSync(baselineApp, baselineCache, { recursive: true });

    assert.equal(
      resolveBaselinePath({
        autoBaseline: true,
        candidatePath: candidateApp,
        repoRoot,
      }),
      baselineCache,
    );
    assert.equal(
      resolveBaselinePath({
        autoBaseline: true,
        candidatePath: baselineCache,
        repoRoot,
      }),
      null,
    );

    const outputDir = path.join(workspace, "auto-baseline-report");
    const reports = buildIntelReports({
      autoBaseline: true,
      candidatePath: candidateApp,
      outputDir,
      registry,
      repoRoot,
    });

    assert.equal(reports.mapDrift.mode, "baselineComparison");
    assert.ok(fs.existsSync(path.join(outputDir, "baseline/inventory.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "candidate/inventory.json")));
    assert.ok(findClassification(reports.driftReport, "chronicle_sidecar", "NEW_UPSTREAM_CAPABILITY"));
  }));

test("CLI loads the checked-in registry and writes the report bundle", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "cli-report");
    const cliPath = path.join(process.cwd(), "scripts/dev/upstream-dmg-intel.js");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "--candidate",
        candidateApp,
        "--output-dir",
        outputDir,
        "--timestamp",
        "2026-07-03T12-00-00Z",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.outputDir, outputDir);
    assert.equal(summary.decision.acceptance, "blocked");
    assert.ok(summary.decision.blockersCount > 0);
    assert.equal(summary.decision.allProtectedSurfacesPresent, false);
    assert.ok(fs.existsSync(path.join(outputDir, "inventory.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "protected-surfaces.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "substrate-action-plan.md")));
    const protectedSurfaces = JSON.parse(
      fs.readFileSync(path.join(outputDir, "protected-surfaces.json"), "utf8"),
    );
    assert.equal(protectedSurfaces.surfacesById.record_and_replay_plugin.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.codex_chronicle.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.chronicle_settings_toggles.status, "PRESENT");
  }));

test("CLI exits nonzero with --fail-on-blockers when acceptance blockers are present", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "cli-fail-report");
    const cliPath = path.join(process.cwd(), "scripts/dev/upstream-dmg-intel.js");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "--candidate",
        candidateApp,
        "--output-dir",
        outputDir,
        "--fail-on-blockers",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 2, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.decision.acceptance, "blocked");
    assert.ok(summary.decision.blockersCount > 0);
    assert.match(result.stderr, /Linux acceptance blocker/);
    assert.ok(fs.existsSync(path.join(outputDir, "drift-report.json")));
  }));

test("CLI keeps optional patch-report skips review-only under --fail-on-blockers", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "cli-optional-patch-report");
    const cliPath = path.join(process.cwd(), "scripts/dev/upstream-dmg-intel.js");
    const registryPath = path.join(workspace, "registry.json");
    const patchReportPath = path.join(workspace, "patch-report.json");

    writeJson(registryPath, {
      version: 1,
      surfaces: [
        {
          id: "record_and_replay_event_stream",
          title: "Record & Replay event stream MCP",
          category: "plugin",
          pathPatterns: ["record-and-replay"],
          contentNeedles: ["event_stream_start", "browser_trace", "speech_context"],
          pluginIds: ["record-and-replay"],
          linuxSubstrate: {
            requiredPaths: ["record-replay-linux/src/main.rs"],
          },
        },
      ],
    });
    writeJson(patchReportPath, {
      patches: [
        {
          name: "record-and-replay bridge patch",
          status: "skipped-optional",
          reason: "upstream bridge marker moved",
          surfaceId: "record_and_replay_event_stream",
        },
      ],
    });

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "--candidate",
        candidateApp,
        "--no-baseline",
        "--registry",
        registryPath,
        "--patch-report",
        patchReportPath,
        "--output-dir",
        outputDir,
        "--fail-on-blockers",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.decision.acceptance, "review");
    assert.equal(summary.decision.blockersCount, 0);
    assert.equal(summary.decision.reviewItemsCount, 1);
    const driftReport = JSON.parse(fs.readFileSync(path.join(outputDir, "drift-report.json"), "utf8"));
    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PATCH_REVIEW"));
    assert.ok(!findClassification(driftReport, "record_and_replay_event_stream", "PATCH_BROKEN"));
  }));
