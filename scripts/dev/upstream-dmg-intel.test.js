"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { buildDecision } = require("./upstream-dmg-intel.js");

const {
  buildIntelReports,
  compareProtectedSurfaces,
  createInventory,
  createNewCapabilityMap,
  createPlatformGateMap,
  createRuntimeRegressionDiagnostics,
  extractVersionMetadata,
  extractProtectedSurfaces,
  findPostPatchIntegrityFindings,
  mergeProvenance,
  prepareRequiredPatchPreflightApp,
  runRequiredPatchPreflight,
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

function writeAsar(filePath, fileContents) {
  const root = { files: {} };
  const payloads = [];
  let offset = 0;
  for (const [relativePath, content] of Object.entries(fileContents).sort(([left], [right]) => left.localeCompare(right))) {
    const payload = Buffer.from(content);
    const parts = relativePath.split("/");
    let files = root.files;
    for (const part of parts.slice(0, -1)) {
      files[part] ??= { files: {} };
      files = files[part].files;
    }
    files[parts.at(-1)] = { offset: String(offset), size: payload.length };
    payloads.push(payload);
    offset += payload.length;
  }

  const headerJson = Buffer.from(JSON.stringify(root));
  const picklePayloadSize = Math.ceil((4 + headerJson.length + 1) / 4) * 4;
  const headerSize = 4 + picklePayloadSize;
  const archive = Buffer.alloc(8 + headerSize + offset);
  archive.writeUInt32LE(4, 0);
  archive.writeUInt32LE(headerSize, 4);
  archive.writeUInt32LE(picklePayloadSize, 8);
  archive.writeUInt32LE(headerJson.length, 12);
  headerJson.copy(archive, 16);
  let payloadOffset = 8 + headerSize;
  for (const payload of payloads) {
    payload.copy(archive, payloadOffset);
    payloadOffset += payload.length;
  }
  writeFile(filePath, archive);
}

test("prepares raw app.asar contents for required patch preflight", () =>
  withTempDir((workspace) => {
    const appDir = path.join(workspace, "Codex.app");
    const resourcesDir = path.join(appDir, "Contents/Resources");
    const asarPath = path.join(resourcesDir, "app.asar");
    const targetDir = path.join(workspace, "preflight");
    const mainSource = "let marker=`current-main-bundle`;";
    writeAsar(asarPath, {
      ".vite/build/main-test.js": mainSource,
      "package.json": JSON.stringify({ name: "codex-desktop" }),
    });

    prepareRequiredPatchPreflightApp({ appDir, targetDir });

    assert.equal(
      fs.readFileSync(path.join(targetDir, ".vite/build/main-test.js"), "utf8"),
      mainSource,
    );
    assert.equal(fs.existsSync(path.join(resourcesDir, "app.asar.extracted")), false);
    assert.equal(fs.existsSync(asarPath), true);
  }));

test("rejects extracted-app symlinks without writing through them during patch preflight", () =>
  withTempDir((workspace) => {
    const appDir = path.join(workspace, "Codex.app");
    const extractedDir = path.join(appDir, "Contents/Resources/app.asar.extracted");
    const targetDir = path.join(workspace, "preflight");
    const victim = path.join(workspace, "outside-victim.js");
    writeFile(victim, "outside content");
    writeFile(path.join(extractedDir, ".vite/build/main.js"), "const safe = true;");
    fs.symlinkSync(victim, path.join(extractedDir, ".vite/build/escaped.js"));
    const originalVictim = fs.readFileSync(victim, "utf8");

    assert.throws(
      () => prepareRequiredPatchPreflightApp({ appDir, targetDir }),
      /symlink/i,
    );
    assert.equal(fs.readFileSync(victim, "utf8"), originalVictim);
  }));

test("keeps Linux parity gates blocked when required patches look applied but preflight failed", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    writeFile(
      path.join(candidateApp, "Contents/Resources/webview/assets/computer-use-current.js"),
      "function zN(e){let {enabled:n}=e,{platform:r}=pi(),a=n&&(r===`macOS`||r===`windows`);return {computerUsePlugin:w}}",
    );
    const patchFindings = [
      "linux-computer-use-ui-feature",
      "linux-computer-use-plugin-gate",
      "linux-computer-use-native-desktop-apps",
      "linux-computer-use-ui-availability",
      "linux-computer-use-install-flow",
    ].map((name) => ({ name, status: "applied" }));

    const platformGateMap = createPlatformGateMap({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
      patchFindings,
      requiredPatchPreflight: { status: "blocked", exitCode: 1 },
    });

    assert.ok(platformGateMap.gates.some((gate) =>
      gate.linuxSurfaceId === "computer_use_plugin" && gate.category === "linux-parity-drift"));
  }));

test("requires production Computer Use inspection proof before marking a gate patched", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    writeFile(
      path.join(candidateApp, "Contents/Resources/webview/assets/computer-use-current.js"),
      "function zN(e){let {enabled:n}=e,{platform:r}=pi(),a=n&&(r===`macOS`||r===`windows`);return {computerUsePlugin:w}}",
    );
    const patchFindings = [
      "linux-computer-use-ui-feature",
      "linux-computer-use-plugin-gate",
      "linux-computer-use-native-desktop-apps",
      "linux-computer-use-ui-availability",
      "linux-computer-use-install-flow",
    ].map((name) => ({ name, status: "applied" }));
    const platformGateMap = createPlatformGateMap({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
      patchFindings,
      requiredPatchPreflight: { status: "pass", exitCode: 0 },
    });

    assert.ok(platformGateMap.gates.some((gate) =>
      gate.linuxSurfaceId === "computer_use_plugin" && gate.category === "linux-parity-drift"));
  }));

test("treats a nonzero required-patch child as an acceptance blocker even with applied findings", () => {
  const decision = buildDecision({
    driftReport: {
      surfaceDrift: [],
      platformGateSummary: { blockingCount: 0, reviewCount: 0 },
      newCapabilitySummary: { issueCandidateCount: 0 },
      requiredPatchPreflight: { status: "blocked", exitCode: 1, findings: [{ status: "applied" }] },
    },
    protectedSurfaces: { surfaces: [{ status: "PRESENT" }] },
  });

  assert.equal(decision.acceptance, "blocked");
  assert.equal(decision.requiredPatchPreflightBlocked, true);
  assert.equal(decision.requiredPatchPreflightExitCode, 1);
});

test("surfaces an unselected required patch failure from the preflight child", () =>
  withTempDir((workspace) => {
    const appDir = path.join(workspace, "Codex.app");
    writeFile(path.join(appDir, ".vite/build/main.js"), "const candidate = true;");
    const repoRoot = path.join(workspace, "repo");
    const scriptPath = path.join(repoRoot, "scripts/patch-linux-window-ui.js");
    const requiredNames = [
      "linux-window-options", "linux-native-titlebar", "linux-avatar-overlay-mouse-passthrough",
      "linux-tray", "main-process-ui", "linux-computer-use-ui-feature",
      "linux-computer-use-plugin-gate", "linux-computer-use-native-desktop-apps",
      "linux-computer-use-ui-availability", "linux-computer-use-install-flow",
      "feature:read-aloud:main-handler", "feature:read-aloud:assistant-runtime",
      "feature:read-aloud:settings-toggle", "feature:read-aloud-mcp:linux-read-aloud-plugin-gate",
    ];
    writeFile(scriptPath, [
      "const fs=require('node:fs');",
      "const reportPath=process.argv[process.argv.indexOf('--report-json')+1];",
      `fs.writeFileSync(reportPath,JSON.stringify({patches:[...${JSON.stringify(requiredNames)}.map(name=>({name,status:'applied'})),{name:'unexpected-required-patch',status:'failed-required',ciPolicy:'required-upstream',reason:'drift'},{name:'unscoped-failed-required',status:'failed-required',reason:'drift'}]}));`,
    ].join(""));

    const result = runRequiredPatchPreflight({
      inventory: { source: { appDir } },
      repoRoot,
      workDir: path.join(workspace, "work"),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.findings.some((finding) => finding.name === "unexpected-required-patch"));
    assert.ok(result.findings.some((finding) => finding.name === "unscoped-failed-required"));
  }));

test("reports runtime regressions as evidence-bound diagnostics without inventing fixes", () => {
  const diagnostics = createRuntimeRegressionDiagnostics({
    runtimeSnapshot: {
      release: "26.707.31428",
      provenance: { source: "Luna fixture", capturedAt: "2026-07-10T00:00:00Z" },
      computerUse: { pluginId: "computer-use@openai-bundled", installed: true, enabled: true, mentionAvailable: false, rollout: "unknown", entitlement: "unproven" },
      browser: { registryInstalled: true, registryEnabled: true, settingsAvailable: false, initiallyOmitted: true, queueReconciled: true },
      dictation: { supported: false },
      chronicle: { enabled: true, backendState: "stopped", uiState: "Paused" },
      linuxFeatures: { settingsRouteAvailable: false },
      reaper: { resumeSucceeded: false },
    },
  });

  assert.deepEqual(diagnostics.map((entry) => entry.id), [
    "computer-use-mention", "browser-settings-reconciliation", "dictation-availability",
    "chronicle-runtime-state", "linux-features-settings-route", "reaper-cli-resume",
  ]);
  assert.ok(diagnostics.every((entry) => entry.status === "runtime-regression"));
  assert.ok(diagnostics.every((entry) => entry.ownerPath && entry.hypothesis && entry.evidenceGap && entry.observedEvidence));
  assert.ok(createRuntimeRegressionDiagnostics({ runtimeSnapshot: { computerUse: { mentionAvailable: false } } })
    .every((entry) => entry.status === "evidence-required"));
  assert.ok(createRuntimeRegressionDiagnostics({ runtimeSnapshot: {
    release: "26.707.31428", provenance: {},
    computerUse: { pluginId: "computer-use@openai-bundled", installed: true, enabled: true, mentionAvailable: false, rollout: "unknown", entitlement: "unproven" },
  } }).every((entry) => entry.status === "evidence-required"));
  const partial = createRuntimeRegressionDiagnostics({ runtimeSnapshot: {
    release: "26.707.31428", provenance: { source: "partial fixture", capturedAt: "2026-07-10T00:00:00Z" },
    computerUse: { pluginId: "computer-use@openai-bundled", installed: true, enabled: true, mentionAvailable: true, rollout: "unknown", entitlement: "unproven" },
  } });
  assert.equal(partial.find((entry) => entry.id === "computer-use-mention").status, "observed");
  assert.equal(partial.find((entry) => entry.id === "browser-settings-reconciliation").status, "evidence-required");
  const observed = createRuntimeRegressionDiagnostics({ runtimeSnapshot: {
    release: "26.707.31428", provenance: { source: "control fixture", capturedAt: "2026-07-10T00:00:00Z" },
    computerUse: { pluginId: "computer-use@openai-bundled", installed: true, enabled: true, mentionAvailable: true, rollout: "unknown", entitlement: "unproven" },
    browser: { registryInstalled: true, registryEnabled: true, settingsAvailable: true, initiallyOmitted: false, queueReconciled: false },
    dictation: { supported: true }, chronicle: { enabled: true, backendState: "stopped", uiState: "Stopped" },
    linuxFeatures: { settingsRouteAvailable: true }, reaper: { resumeSucceeded: true },
  } });
  assert.ok(observed.every((entry) => entry.status === "observed"));
});

test("inventories raw app.asar entries with normalized archive paths", () =>
  withTempDir((workspace) => {
    const appDir = path.join(workspace, "Codex.app");
    writeAsar(path.join(appDir, "Contents/Resources/app.asar"), {
      ".vite/build/main-test.js": "let marker=`current-main-bundle`;",
    });

    const inventory = createInventory({ sourcePath: appDir });

    assert.ok(
      inventory.files.some(
        (file) => file.relativePath === "Contents/Resources/app.asar/.vite/build/main-test.js",
      ),
    );
    assert.equal(
      inventory.files.some((file) => file.relativePath.includes(".vite/build/.vite/build")),
      false,
    );
  }));

test("default Read Aloud surface protects the current assistant render contract", () =>
  withTempDir((workspace) => {
    const appDir = path.join(workspace, "Codex.app");
    const assetPath = path.join(
      appDir,
      "Contents/Resources/app.asar.extracted/webview/assets",
      "app-initial~app-main~onboarding-page-zcfEkMl-.js",
    );
    writeFile(
      assetPath,
      "return (0,Z.jsx)(Xa,{item:a,assistantCopyText:i,conversationId:l,renderCodeBlocksAsWritingBlocks:ge})",
    );
    const defaultRegistry = JSON.parse(
      fs.readFileSync(path.join(__dirname, "upstream-dmg-protected-surfaces.json"), "utf8"),
    );
    const inventory = createInventory({ registry: defaultRegistry, sourcePath: appDir });

    const protectedSurfaces = extractProtectedSurfaces({
      inventory,
      registry: defaultRegistry,
      repoRoot: path.resolve(__dirname, "../.."),
    });
    const readAloud = protectedSurfaces.surfaces.find(
      (surface) => surface.id === "read_aloud_capability",
    );

    assert.equal(readAloud.status, "PRESENT");
    assert.deepEqual(readAloud.missingAnchors, []);
  }));

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

test("CLI writes release-bound runtime diagnostics and action-plan evidence", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "runtime-report");
    const snapshotPath = path.join(workspace, "runtime-snapshot.json");
    writeJson(snapshotPath, {
      release: "26.707.31428",
      provenance: { source: "focused fixture", capturedAt: "2026-07-10T00:00:00Z" },
      computerUse: { pluginId: "computer-use@openai-bundled", installed: true, enabled: true, mentionAvailable: false, rollout: "unknown", entitlement: "unproven" },
      browser: { registryInstalled: true, registryEnabled: true, settingsAvailable: false, initiallyOmitted: true, queueReconciled: true },
      dictation: { supported: false },
      chronicle: { enabled: true, backendState: "not-started", uiState: "Paused" },
      linuxFeatures: { settingsRouteAvailable: false },
      reaper: { resumeSucceeded: false },
    });
    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), "scripts/dev/upstream-dmg-intel.js"), "--candidate", candidateApp,
      "--output-dir", outputDir, "--runtime-snapshot", snapshotPath,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.decision.acceptance, "blocked");
    assert.equal(summary.decision.runtimeRegressionCount, 6);
    const diagnostics = JSON.parse(fs.readFileSync(path.join(outputDir, "runtime-diagnostics.json"), "utf8"));
    assert.equal(diagnostics.length, 6);
    assert.ok(diagnostics.every((entry) => entry.release === "26.707.31428" && entry.status === "runtime-regression"));
    assert.match(fs.readFileSync(path.join(outputDir, "substrate-action-plan.md"), "utf8"), /Runtime diagnostics \(release 26\.707\.31428\)/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, "drift-report.json"), "utf8")).runtimeHealth.mcpHelperReaper.status, "REGRESSION");
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
