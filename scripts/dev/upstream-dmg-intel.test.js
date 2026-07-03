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
  extractProtectedSurfaces,
  renderActionPlanMarkdown,
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
    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PATCH_BROKEN"));
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

test("writes the expected report bundle for candidate-only and comparison runs", () =>
  withTempDir((workspace) => {
    const baselineApp = createFixtureApp(workspace, "baseline");
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "reports");

    const reports = buildIntelReports({
      baselinePath: baselineApp,
      candidatePath: candidateApp,
      outputDir,
      registry,
      repoRoot: process.cwd(),
      timestamp: "2026-07-03T12-00-00Z",
    });

    for (const reportName of [
      "inventory.json",
      "protected-surfaces.json",
      "bridge-map.json",
      "plugin-map.json",
      "native-binary-map.json",
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
    const mapDrift = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "map-drift.json"), "utf8"),
    );
    const actionPlan = fs.readFileSync(path.join(reports.outputDir, "substrate-action-plan.md"), "utf8");
    const skyDrift = findClassification(driftReport, "sky_computer_use_client", "MOVED");
    assert.ok(findClassification(driftReport, "chronicle_sidecar", "NEW_UPSTREAM_CAPABILITY"));
    assert.equal(skyDrift.baselineEvidence, undefined);
    assert.equal(skyDrift.candidateEvidence, undefined);
    assert.ok(skyDrift.evidenceSummary.baseline.evidenceCount > 0);
    assert.ok(skyDrift.evidenceDrift.addedPathSamples.length > 0);
    assert.equal(skyDrift.evidenceDrift.addedEvidence, undefined);
    assert.ok(inventory.files.every((file) => file.text == null && file.nativeStrings == null));
    assert.ok(
      nativeBinaryMap.binaries.some((binary) =>
        binary.protectedStringHits.some((hit) => hit.needle === "recording_controls"),
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
