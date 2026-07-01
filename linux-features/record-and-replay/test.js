#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const {
  disabledLinuxFeatureCleanupHooks,
  enabledLinuxFeatureIds,
  loadEnabledLinuxFeatures,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  applyRecordReplayDictationTranscriptPatch,
  applyRecordReplayHudPatch,
  applyRecordReplayPluginGatePatch,
  applyRecordReplayMainBridgePatch,
  descriptors,
  recordReplayHelperSource,
} = require("./patch.js");

const featureDir = __dirname;

function repoRoot() {
  return path.resolve(featureDir, "../..");
}

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-and-replay-feature-test-"));
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(path.resolve(__dirname), path.join(root, "record-and-replay"), { recursive: true });
    return fn(root);
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withTempFeatureConfig(enabled, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-and-replay-config-test-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, JSON.stringify({ enabled }, null, 2));
    return fn(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("manifest keeps record-and-replay disabled by default", () => {
  const manifestPath = path.join(__dirname, "feature.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.id, "record-and-replay");
  assert.equal(manifest.defaultEnabled, false);
});

test("record-and-replay required files exist", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "feature.json")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "README.md")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "patch.js")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "stage.sh")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "cleanup.sh")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "test.js")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "plugin-template/.codex-plugin/plugin.json")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "plugin-template/.mcp.json")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "plugin-template/skills/record-and-replay/SKILL.md")), true);
});

test("record-and-replay is opt-in and disabled unless configured", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadEnabledLinuxFeatures({ featuresRoot: root }), []);
  });
});

test("record-and-replay enables when listed in features.json", () => {
  withTempFeatureRoot(["record-and-replay"], (root) => {
    const ids = enabledLinuxFeatureIds({ featuresRoot: root });
    assert.deepEqual(ids, ["record-and-replay"]);
    assert.deepEqual(loadEnabledLinuxFeatures({ featuresRoot: root }).map((feature) => feature.id), [
      "record-and-replay",
    ]);
  });
});

test("record-and-replay patch descriptor loads only when feature is enabled", () => {
  withTempFeatureConfig([], (root) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
  withTempFeatureConfig(["record-and-replay"], (root) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.deepEqual(loaded.map((descriptor) => descriptor.id), [
      "feature:record-and-replay:record-and-replay-plugin-gate",
      "feature:record-and-replay:linux-record-replay-main-bridge",
      "feature:record-and-replay:record-replay-hud",
      "feature:record-and-replay:record-replay-dictation-transcript",
    ]);
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  });
});

test("record-and-replay bridge patch is idempotent and uses execFile", () => {
  assert.equal(descriptors.length, 4);
  const source = [
    "const cp=require(\"node:child_process\"),fs=require(\"node:fs\"),path=require(\"node:path\");",
    "var bridge={\"get-global-state\":async({key:e})=>null};",
  ].join("");

  const patched = applyRecordReplayMainBridgePatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayMainBridgePatch(patched), patched);
  assert.match(patched, /"linux-record-replay-doctor":async/);
  assert.match(patched, /"linux-record-replay-status":async/);
  assert.match(patched, /"linux-record-replay-start":async/);
  assert.match(patched, /"--no-audio"/);
  assert.match(patched, /"linux-record-replay-skysight-start":async/);
  assert.match(patched, /"linux-record-replay-skysight-status":async/);
  assert.match(patched, /"linux-record-replay-skysight-pause":async/);
  assert.match(patched, /"linux-record-replay-skysight-resume":async/);
  assert.match(patched, /"linux-record-replay-skysight-update-exclusion":async/);
  assert.match(patched, /"linux-record-replay-speech-context":async/);
  assert.match(patched, /"linux-record-replay-browser-trace":async/);
  assert.match(patched, /"linux-record-replay-desktop-snapshot":async/);
  assert.match(patched, /"desktop-snapshot"/);
  assert.match(patched, /"linux-record-replay-stop-active":async/);
  assert.match(patched, /"linux-record-replay-cancel":async/);
  assert.match(patched, /"linux-record-replay-cancel-active":async/);
  assert.match(patched, /"linux-record-replay-draft-skill":async/);
  assert.match(patched, /"linux-record-replay-import-skill":async/);
  assert.match(patched, /\.execFile\(n,e,\{encoding:"utf8",timeout:t,maxBuffer:16777216\}/);
  assert.match(patched, /codexLinuxRecordReplayWriteTempJson/);
  assert.match(patched, /"browser-trace"/);
  assert.match(patched, /"--trace-file"/);
  assert.doesNotMatch(patched, /exec\(/);
  assert.doesNotMatch(patched, /shell:true/);
  assert.match(patched, /"--no-screenshot"/);
  assert.match(patched, /"--allow-unsupported"/);
  assert.doesNotMatch(patched, /"--target"/);
  assert.doesNotMatch(patched, /"--target-dir"/);
  assert.doesNotMatch(patched, /"--mode"/);
});

test("record-and-replay docs mention pause resume and Chronicle-compatible resources", () => {
  const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
  assert.match(readme, /linux-record-replay-skysight-pause/);
  assert.match(readme, /linux-record-replay-skysight-resume/);
  assert.match(readme, /Chronicle-compatible resources/);
  assert.match(readme, /memories_extensions\/chronicle\/resources/);

  const skill = fs.readFileSync(path.join(__dirname, "plugin-template/skills/record-and-replay/SKILL.md"), "utf8");
  assert.match(skill, /pause/);
  assert.match(skill, /resume/);
  assert.match(skill, /Chronicle-compatible resources/);
});

test("record-and-replay bridge temp trace files are private", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-bridge-temp-"));
  try {
    const tempRoot = path.join(workspace, "tmp");
    fs.mkdirSync(tempRoot, { mode: 0o777 });
    const helperSource = recordReplayHelperSource({
      childProcessVar: "childProcess",
      fsVar: "fs",
      pathVar: "path",
    });
    const tracePath = vm.runInNewContext(
      `${helperSource};codexLinuxRecordReplayWriteTempJson("{\\"ok\\":true}")`,
      {
        childProcess: {},
        fs,
        path,
        process: { env: { TMPDIR: tempRoot }, pid: 4242 },
        Date,
        Math,
        String,
      },
    );
    const traceDir = path.dirname(tracePath);
    assert.equal(fs.statSync(traceDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(tracePath).mode & 0o777, 0o600);
    assert.equal(path.relative(tempRoot, traceDir).startsWith(".."), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("record-and-replay HUD patch is idempotent and appends runtime UI", () => {
  const source = "console.log('webview');\n//# sourceMappingURL=index.js.map";
  const patched = applyRecordReplayHudPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayHudPatch(patched), patched);
  assert.match(patched, /sourceMappingURL=index\.js\.map\n;\(\(\)=>/);
  assert.match(patched, /codexLinuxRecordReplayHudVersion/);
  assert.match(patched, /codex-linux-record-replay-hud/);
  assert.match(patched, /linux-record-replay-status/);
  assert.match(patched, /linux-record-replay-stop-active/);
  assert.match(patched, /linux-record-replay-cancel-active/);
  assert.match(patched, /codexLinuxRecordReplayCaptureTranscript/);
  assert.match(patched, /linux-record-replay-speech-context/);
  assert.match(patched, /codex-dictation-/);
  assert.match(patched, /linux-record-replay-desktop-snapshot/);
  assert.match(patched, /record-replay-hud/);
  assert.match(patched, /captureDesktopSnapshot/);
  assert.match(patched, /I'm done recording\./);
  assert.match(patched, /submitDoneMessage/);
  assert.match(patched, /finishRecording/);
  assert.match(patched, /discardRecording/);
  assert.match(patched, /Discard this Record & Replay recording/);
  assert.doesNotMatch(patched, /codexLinuxRecordReplayVoiceControls/);
  assert.doesNotMatch(patched, /startDictation/);
  assert.doesNotMatch(patched, /stopDictation/);
  assert.doesNotMatch(patched, /finalizeVoiceCapture/);
});

test("record-and-replay mirrors finalized dictation transcripts into active bundle", () => {
  const source =
    "function send(e,n){let i=`Create an image of a neon cabin`;i.length>0&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))}";
  const patched = applyRecordReplayDictationTranscriptPatch(source);

  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayDictationTranscriptPatch(patched), patched);
  assert.match(patched, /codexLinuxRecordReplayCaptureTranscript\?\.\(i,e\)/);
  assert.match(patched, /global-dictation-record-history-item/);
  assert.match(patched, /e===`send`\?n\.onTranscriptSend\(i\):n\.onTranscriptInsert\(i\)/);
});

test("record-and-replay transcript hook composes after conversation mode transcript gate", () => {
  const source =
    "function send(e,n){let i=`Create an image of a neon cabin`;i.length>0&&e!==`discard`&&globalThis.codexLinuxConversationShouldSendTranscript?.(i,e)!==!1&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))}";
  const patched = applyRecordReplayDictationTranscriptPatch(source);

  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayDictationTranscriptPatch(patched), patched);
  assert.match(
    patched,
    /codexLinuxConversationShouldSendTranscript\?\.\(i,e\)!==!1&&\(globalThis\.codexLinuxRecordReplayCaptureTranscript\?\.\(i,e\),/,
  );
  assert.match(patched, /global-dictation-record-history-item/);
});

test("record-and-replay plugin gate is idempotent and linux-only", () => {
  const source = [
    "var lt=`browser-use`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{name:pt,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyRecordReplayPluginGatePatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayPluginGatePatch(patched), patched);
  assert.match(patched, /installWhenMissing:!0,name:`record-and-replay`,isAvailable:\(\{platform:e\}\)=>e===`linux`/);
  assert.match(patched, /name:ft,isAvailable:\(\{features:e,platform:t\}\)=>t===`darwin`&&e\.computerUse/);
});

test("record-and-replay plugin template matches upstream-shaped plugin UX", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(featureDir, "plugin-template/.codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(fs.readFileSync(path.join(featureDir, "plugin-template/.mcp.json"), "utf8"));
  const skill = fs.readFileSync(path.join(featureDir, "plugin-template/skills/record-and-replay/SKILL.md"), "utf8");

  assert.equal(plugin.name, "record-and-replay");
  assert.equal(plugin.interface.displayName, "Record & Replay");
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(plugin.skills, "./skills");
  assert.equal(plugin.interface.composerIcon, "./assets/app-icon.svg");
  assert.deepEqual(mcp.mcpServers["event-stream"], {
    command: "./bin/SkyLinuxComputerUseClient",
    args: ["event-stream", "mcp"],
    cwd: ".",
  });
  assert.match(skill, /^name: record-and-replay$/m);
  assert.match(skill, /same bundled\s+Record & Replay product shell/);
  assert.match(skill, /SkyLinuxComputerUseClient event-stream mcp/);
  assert.match(skill, /event_stream_start/);
  assert.match(skill, /event_stream_status/);
  assert.match(skill, /event_stream_stop/);
  assert.match(skill, /browser_trace/);
  assert.match(skill, /status/);
  assert.match(skill, /I'm done recording\./);
  assert.match(skill, /speech_context/);
  assert.match(skill, /not a raw pointer or keyboard macro recorder/);
});

test("record-and-replay stage hook records marketplace entry and stages plugin", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-stage-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const marketplace = path.join(installDir, "resources/plugins/openai-bundled/.agents/plugins/marketplace.json");
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [{ name: "computer-use", source: { path: "./plugins/computer-use" } }] }));
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
        CODEX_RECORD_REPLAY_LINUX_SOURCE: fakeBinary,
      },
      stdio: "pipe",
    });

    const nativeBinary = path.join(installDir, "resources/native/codex-record-replay-linux");
    const pluginDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    assert.equal(fs.existsSync(nativeBinary), true);
    assert.equal(fs.statSync(nativeBinary).mode & 0o111 ? true : false, true);
    assert.equal(fs.existsSync(path.join(pluginDir, ".codex-plugin/plugin.json")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, ".mcp.json")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "assets/app-icon.svg")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "skills/record-and-replay/SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-record-replay-linux")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/SkyLinuxComputerUseClient")), true);
    assert.equal(fs.statSync(path.join(pluginDir, "bin/codex-record-replay-linux")).mode & 0o111 ? true : false, true);
    assert.equal(fs.statSync(path.join(pluginDir, "bin/SkyLinuxComputerUseClient")).mode & 0o111 ? true : false, true);

    const stagedPlugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin/plugin.json"), "utf8"));
    const stagedMcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    assert.equal(stagedPlugin.interface.displayName, "Record & Replay");
    assert.equal(stagedPlugin.interface.logo, "./assets/app-icon.svg");
    assert.equal(stagedPlugin.interface.composerIcon, "./assets/app-icon.svg");
    assert.equal(Object.keys(stagedMcp.mcpServers)[0], "event-stream");
    assert.deepEqual(stagedMcp.mcpServers["event-stream"], {
      command: "./bin/SkyLinuxComputerUseClient",
      args: ["event-stream", "mcp"],
      cwd: ".",
    });

    const parsedMarketplace = JSON.parse(fs.readFileSync(marketplace, "utf8"));
    assert.equal(parsedMarketplace.plugins.some((plugin) => plugin.name === "record-and-replay" && plugin.source?.path === "./plugins/record-and-replay"), true);
    assert.equal(parsedMarketplace.plugins.some((plugin) => plugin.name === "computer-use"), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("record-and-replay disabled rebuild exposes cleanup hook for staged payload", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-cleanup-"));
  const originalRoot = process.env.CODEX_LINUX_FEATURES_ROOT;
  try {
    const featuresRoot = path.join(workspace, "features");
    const installDir = path.join(workspace, "install");
    fs.mkdirSync(featuresRoot, { recursive: true });
    fs.writeFileSync(path.join(featuresRoot, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.cpSync(featureDir, path.join(featuresRoot, "record-and-replay"), { recursive: true });

    const staleNative = path.join(installDir, "resources/native/codex-record-replay-linux");
    const stalePlugin = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    const marketplace = path.join(installDir, "resources/plugins/openai-bundled/.agents/plugins/marketplace.json");
    fs.mkdirSync(stalePlugin, { recursive: true });
    fs.mkdirSync(path.dirname(staleNative), { recursive: true });
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(staleNative, "stale");
    fs.writeFileSync(path.join(stalePlugin, "stale.txt"), "stale");
    fs.writeFileSync(
      marketplace,
      JSON.stringify({ plugins: [{ name: "record-and-replay" }, { name: "computer-use" }] }),
    );

    process.env.CODEX_LINUX_FEATURES_ROOT = featuresRoot;
    const cleanupHooks = disabledLinuxFeatureCleanupHooks({ featuresRoot });
    assert.deepEqual(cleanupHooks.map((hook) => hook.id), ["record-and-replay"]);
    execFileSync("bash", [cleanupHooks[0].path], {
      cwd: workspace,
      env: { ...process.env, SCRIPT_DIR: repoRoot(), INSTALL_DIR: installDir },
      stdio: "pipe",
    });
    stageEnabledLinuxFeatureInstall(installDir, { featuresRoot });

    assert.equal(fs.existsSync(staleNative), false);
    assert.equal(fs.existsSync(stalePlugin), false);
    const parsedMarketplace = JSON.parse(fs.readFileSync(marketplace, "utf8"));
    assert.deepEqual(parsedMarketplace.plugins.map((plugin) => plugin.name), ["computer-use"]);
  } finally {
    if (originalRoot == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = originalRoot;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("launcher rejects unsafe bundled plugin version path components", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-version-"));
  try {
    const launcher = fs.readFileSync(path.join(repoRoot(), "launcher/start.sh.template"), "utf8");
    const segment = launcher.slice(
      launcher.indexOf("bundled_plugin_version() {"),
      launcher.indexOf("bundled_plugin_name() {"),
    );
    assert.notEqual(segment.length, 0);

    const run = (version) => {
      const pluginDir = path.join(workspace, `plugin-${String(version).replace(/[^A-Za-z0-9._-]/g, "_")}`);
      fs.mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
      const pluginJson = path.join(pluginDir, ".codex-plugin/plugin.json");
      fs.writeFileSync(pluginJson, JSON.stringify({ name: "record-and-replay", version }));
      return execFileSync("bash", ["-c", `${segment}\nbundled_plugin_version "$1"`, "probe", pluginJson], {
        encoding: "utf8",
      }).trim();
    };

    assert.equal(run("1.2.3-linux.1"), "1.2.3-linux.1");
    assert.throws(() => run("."));
    assert.throws(() => run(".."));
    assert.throws(() => run("../escape"));
    assert.throws(() => run("1/2"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("record-and-replay stage hook uses upstream plugin shell when present", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-stage-upstream-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const upstreamPlugin = path.join(
      workspace,
      "upstream/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/record-and-replay",
    );
    const marketplace = path.join(installDir, "resources/plugins/openai-bundled/.agents/plugins/marketplace.json");
    fs.mkdirSync(path.join(upstreamPlugin, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(upstreamPlugin, "assets"), { recursive: true });
    fs.mkdirSync(path.join(upstreamPlugin, "skills/record-and-replay"), { recursive: true });
    fs.mkdirSync(path.join(upstreamPlugin, "Codex Computer Use.app/Contents/MacOS"), { recursive: true });
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(
      path.join(upstreamPlugin, ".codex-plugin/plugin.json"),
      JSON.stringify({
        name: "record-and-replay",
        version: "1.0.857",
        description: "Record what I'm doing on my Mac",
        author: { name: "OpenAI" },
        mcpServers: "./.mcp.json",
        skills: "./skills/",
        interface: {
          displayName: "Record & Replay",
          shortDescription: "Record what I'm doing on my Mac and turn it into a Skill",
          logo: "./assets/app-icon.png",
          brandColor: "#0F172A",
        },
        keywords: ["record-and-replay", "macos", "recording"],
      }),
    );
    fs.writeFileSync(
      path.join(upstreamPlugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "event-stream": {
            command: "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
            args: ["event-stream", "mcp"],
            cwd: ".",
          },
        },
      }),
    );
    fs.writeFileSync(path.join(upstreamPlugin, "assets/app-icon.png"), "official-png");
    fs.writeFileSync(path.join(upstreamPlugin, "skills/record-and-replay/SKILL.md"), "official mac skill");
    fs.writeFileSync(path.join(upstreamPlugin, "Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"), "mach-o");
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [] }));
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
        CODEX_UPSTREAM_APP_DIR: path.join(workspace, "upstream/Codex.app"),
        CODEX_RECORD_REPLAY_LINUX_SOURCE: fakeBinary,
      },
      stdio: "pipe",
    });

    const pluginDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    const stagedPlugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin/plugin.json"), "utf8"));
    const stagedMcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    const stagedSkill = fs.readFileSync(path.join(pluginDir, "skills/record-and-replay/SKILL.md"), "utf8");

    assert.equal(fs.existsSync(path.join(pluginDir, "Codex Computer Use.app")), false);
    assert.equal(fs.readFileSync(path.join(pluginDir, "assets/app-icon.png"), "utf8"), "official-png");
    assert.equal(stagedPlugin.version, "1.0.857");
    assert.equal(stagedPlugin.description, "Record what I'm doing on Linux");
    assert.equal(stagedPlugin.interface.shortDescription, "Record what I'm doing on Linux and turn it into a Skill");
    assert.equal(stagedPlugin.interface.logo, "./assets/record-and-replay-plugin-icon.png");
    assert.equal(stagedPlugin.interface.composerIcon, "./assets/record-and-replay-plugin-icon.png");
    assert.equal(stagedPlugin.keywords.includes("macos"), false);
    assert.equal(stagedPlugin.keywords.includes("linux"), true);
    assert.deepEqual(stagedMcp.mcpServers["event-stream"], {
      command: "./bin/SkyLinuxComputerUseClient",
      args: ["event-stream", "mcp"],
      cwd: ".",
    });
    assert.match(stagedSkill, /event_stream_start/);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-record-replay-linux")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/SkyLinuxComputerUseClient")), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("record-and-replay stage hook borrows upstream webview icon when present", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-stage-icon-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const assetsDir = path.join(installDir, "content/webview/assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "record-and-replay-plugin-icon-fixture.png"), "fake-png");
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
        CODEX_RECORD_REPLAY_LINUX_SOURCE: fakeBinary,
      },
      stdio: "pipe",
    });

    const pluginDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    const borrowedIcon = path.join(pluginDir, "assets/record-and-replay-plugin-icon.png");
    assert.equal(fs.readFileSync(borrowedIcon, "utf8"), "fake-png");

    const stagedPlugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin/plugin.json"), "utf8"));
    assert.equal(stagedPlugin.interface.logo, "./assets/record-and-replay-plugin-icon.png");
    assert.equal(stagedPlugin.interface.composerIcon, "./assets/record-and-replay-plugin-icon.png");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
