"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEXT_FILE_PATTERN = /\.(cjs|css|html|js|json|mjs|md|plist|text|ts|tsx|txt|xml|yml|yaml)$/i;
const NATIVE_FILE_PATTERN = /(^|\/)(codex_chronicle|SkyComputerUseClient|sky\.node|node_repl|node|[^/]+\.(node|dylib))$/i;
const DEFAULT_MAX_TEXT_BYTES = 2_500_000;
const DEFAULT_MAX_INVENTORY_HASH_BYTES = 10_000_000;
const DRIFT_PATH_SAMPLE_LIMIT = 8;
const DRIFT_CHANGED_SAMPLE_LIMIT = 12;
const MARKDOWN_PATH_SAMPLE_LIMIT = 3;
const ACTION_PLAN_PATH_SAMPLE_LIMIT = 3;
const SUCCESSFUL_PATCH_STATUSES = new Set(["applied", "already-applied", "skipped-target", "skipped-disabled"]);
const BLOCKING_PATCH_STATUSES = new Set(["failed-required"]);
const ACTIONABLE_CLASSIFICATIONS = new Set([
  "MOVED",
  "RENAMED",
  "PAYLOAD_CHANGED",
  "REMOVED",
  "NEW_UPSTREAM_CAPABILITY",
  "PATCH_BROKEN",
  "PATCH_INTEGRITY_BROKEN",
  "PATCH_REVIEW",
  "LINUX_SUBSTRATE_GAP",
  "PROTECTED_SURFACE_PARTIAL",
  "PROTECTED_SURFACE_MISSING",
]);
const PLATFORM_GATE_BLOCKING_CATEGORIES = new Set(["linux-parity-drift"]);
const PLATFORM_GATE_REVIEW_CATEGORIES = new Set([
  "new-upstream-capability",
  "platform-specific-unsupported",
  "needs-review",
]);
const LINUX_PARITY_SURFACE_PATCHES = {
  computer_use_plugin: [
    "linux-computer-use-ui-feature",
    "linux-computer-use-plugin-gate",
    "linux-computer-use-native-desktop-apps",
    "linux-computer-use-ui-availability",
    "linux-computer-use-install-flow",
  ],
};
const PLATFORM_GATE_MARKDOWN_LIMIT = 20;
const NEW_CAPABILITY_MARKDOWN_LIMIT = 20;
const STRING_LITERAL_PATTERN = /`([^`\\]*(?:\\.[^`\\]*)*)`|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
const BRIDGE_CHANNEL_TERM_PATTERN =
  /browser[-_]trace|chrome|chronicle|computer[-_]use|desktop[-_]snapshot|dictation|event[-_]stream|focused[-_]window|global[-_]dictation|nativeMessaging|record[-_ ]?(?:and[-_ ]?)?replay|skysight|speech[-_]context|window[-_]metadata/i;
const LOWER_BRIDGE_CHANNEL_PATTERN = /^[a-z][a-z0-9_.:-]{2,119}$/;
const CAMEL_BRIDGE_CHANNEL_PATTERN = /^(?:browserTrace|computerUse|eventStream|focusedWindow|nativeMessaging|recordAndReplay|speechContext|windowMetadata)$/;
const ASSET_EXTENSION_PATTERN = /\.(?:css|dylib|exe|gif|ico|jpeg|jpg|js|json|md|node|png|svg|ts|tsx|txt|wasm|yml|yaml)$/i;
const commandPathCache = new Map();

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const REQUIRED_PATCH_PREFLIGHTS = new Set([
  "linux-window-options",
  "linux-native-titlebar",
  "linux-avatar-overlay-mouse-passthrough",
  "linux-tray",
  "main-process-ui",
]);
const LINUX_PARITY_PATCH_PREFLIGHTS = new Set([
  "linux-computer-use-ui-feature",
  "linux-computer-use-plugin-gate",
  "linux-computer-use-native-desktop-apps",
  "linux-computer-use-ui-availability",
  "linux-computer-use-install-flow",
  "feature:read-aloud:main-handler",
  "feature:read-aloud:assistant-runtime",
  "feature:read-aloud:settings-toggle",
  "feature:read-aloud-mcp:linux-read-aloud-plugin-gate",
]);
const PATCH_PREFLIGHTS = new Set([
  ...REQUIRED_PATCH_PREFLIGHTS,
  ...LINUX_PARITY_PATCH_PREFLIGHTS,
]);

function patchPreflightOwner(name) {
  if (name === "main-process-ui") {
    return "scripts/patches/runner.js";
  }
  if (name.startsWith("linux-computer-use")) {
    return "scripts/patches/impl/computer-use.js";
  }
  if (name.includes("read-aloud")) {
    return name.startsWith("feature:read-aloud-mcp")
      ? "linux-features/read-aloud-mcp/patches.js"
      : "linux-features/read-aloud/patch.js";
  }
  return "scripts/patches/core/all-linux/main-process/window-shell/patch.js";
}

function patchPreflightSurfaceId(name) {
  if (name.startsWith("linux-computer-use")) {
    return "computer_use_plugin";
  }
  if (name.includes("read-aloud")) {
    return "read_aloud_capability";
  }
  return null;
}

function runRequiredPatchPreflight({ inventory, repoRoot, workDir } = {}) {
  const result = {
    status: "not-run",
    evidenceType: "safe-extracted-candidate-patch-preflight",
    sourcePath: inventory?.source?.appDir ?? null,
    findings: [],
  };
  if (!inventory?.source?.appDir || !fs.existsSync(path.join(repoRoot, "scripts/patch-linux-window-ui.js"))) {
    result.status = "unknown";
    result.reason = "patch preflight entrypoint unavailable";
    return result;
  }
  const extractedCopy = path.join(workDir, "required-patch-preflight-app");
  try {
    prepareRequiredPatchPreflightApp({
      appDir: inventory.source.appDir,
      targetDir: extractedCopy,
    });
  } catch (error) {
    result.status = "blocked";
    result.reason = error.message;
    result.findings = [...PATCH_PREFLIGHTS].map((name) => ({
      name,
      status: "failed-required",
      severity: "blocker",
      ownerPath: patchPreflightOwner(name),
      surfaceId: patchPreflightSurfaceId(name),
      recommendation: "Restore candidate extraction before package build.",
      reason: error.message,
    }));
    return result;
  }
  const rawComputerUseGates = createPlatformGateMap({
    inventory: createInventory({ sourcePath: extractedCopy }),
  }).gates.filter((gate) => gate.linuxSurfaceId === "computer_use_plugin");
  const featuresConfigPath = path.join(workDir, "required-patch-preflight-features.json");
  writeJson(featuresConfigPath, { enabled: ["read-aloud", "read-aloud-mcp"] });
  const reportPath = path.join(workDir, "required-patch-preflight.json");
  const command = spawnSync(process.execPath, [
    path.join(repoRoot, "scripts/patch-linux-window-ui.js"),
    "--report-json", reportPath,
    "--enforce-critical",
    extractedCopy,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_LINUX_ENABLE_COMPUTER_USE_UI: "1",
      CODEX_LINUX_FEATURES_CONFIG: featuresConfigPath,
      CODEX_LINUX_FEATURES_ROOT: path.join(repoRoot, "linux-features"),
      HOME: path.join(workDir, "home"),
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  const report = fs.existsSync(reportPath) ? readJson(reportPath) : { patches: [] };
  const patches = (report.patches ?? []).filter((entry) => PATCH_PREFLIGHTS.has(entry.name));
  const reportedRequiredFailures = (report.patches ?? []).filter((entry) =>
    (entry.ciPolicy === "required-upstream" || entry.status === "failed-required") &&
    !["applied", "already-applied", "skipped-target", "skipped-disabled"].includes(entry.status),
  );
  const computerUseFindings = (report.postPatchIntegrity?.findings ?? [])
    .filter((finding) => String(finding.symbol ?? "").startsWith("computer-use-"));
  const remainingComputerUseGates = createPlatformGateMap({
    inventory: createInventory({ sourcePath: extractedCopy }),
  }).gates.filter((gate) => gate.linuxSurfaceId === "computer_use_plugin");
  result.computerUseInspection = {
    evidenceType: "production-post-patch-computer-use-inspection",
    sourcePath: extractedCopy,
    status: command.status === 0 && computerUseFindings.length === 0 ? "pass" : "blocked",
    findings: computerUseFindings,
    gateProofs: rawComputerUseGates.map((gate) => ({
      gateId: gate.id,
      path: gate.path,
      gate: gate.gate,
      status: command.status === 0 && computerUseFindings.length === 0 &&
        !remainingComputerUseGates.some((remaining) =>
          remaining.path === gate.path && remaining.gate === gate.gate)
        ? "verified"
        : "blocked",
    })),
  };
  result.status = command.status === 0 &&
    result.computerUseInspection.status === "pass" &&
    reportedRequiredFailures.length === 0 &&
    [...PATCH_PREFLIGHTS].every((name) =>
      patches.some((entry) => entry.name === name && ["applied", "already-applied"].includes(entry.status)))
    ? "pass"
    : "blocked";
  result.exitCode = command.status;
  result.findings = patches.map((entry) => ({
    name: entry.name,
    status: entry.status,
    severity: ["applied", "already-applied"].includes(entry.status) ? "none" : "blocker",
    ownerPath: patchPreflightOwner(entry.name),
    surfaceId: patchPreflightSurfaceId(entry.name),
    recommendation: ["applied", "already-applied"].includes(entry.status) ? "No action." : "Restore the exact current-bundle patch contract before package build.",
    reason: entry.reason ?? null,
  }));
  for (const entry of reportedRequiredFailures) {
    if (!result.findings.some((finding) => finding.name === entry.name)) {
      result.findings.push({
        name: entry.name,
        status: entry.status,
        severity: "blocker",
        ownerPath: entry.ownerPath ?? patchPreflightOwner(entry.name),
        surfaceId: patchPreflightSurfaceId(entry.name),
        recommendation: "Resolve this required patch failure before package build.",
        reason: entry.reason ?? null,
      });
    }
  }
  for (const name of PATCH_PREFLIGHTS) {
    if (!patches.some((entry) => entry.name === name)) {
      result.findings.push({
        name,
        status: "not-recorded",
        severity: "blocker",
        ownerPath: patchPreflightOwner(name),
        surfaceId: patchPreflightSurfaceId(name),
        recommendation: "Record and resolve this required patch before package build.",
      });
    }
  }
  return result;
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\/+/, "");
}

function toRegex(pattern) {
  return pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchAny(patterns, value) {
  return (patterns ?? []).some((pattern) => toRegex(pattern).test(value));
}

function textSnippet(text, needle) {
  const index = text.toLowerCase().indexOf(String(needle).toLowerCase());
  if (index < 0) {
    return null;
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + String(needle).length + 80);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function includesNeedle(value, needle) {
  const valueText = String(value);
  const needleText = String(needle);
  if (/^[A-Za-z0-9_]+$/.test(needleText) && needleText.length <= 4) {
    const escaped = needleText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i").test(valueText);
  }
  return valueText.toLowerCase().includes(needleText.toLowerCase());
}

function printableStrings(buffer, minLength = 4) {
  const strings = new Set();
  let current = "";
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) {
        strings.add(current);
      }
      current = "";
    }
  }
  if (current.length >= minLength) {
    strings.add(current);
  }
  return [...strings].sort();
}

function asarEntries(asarPath, prefix = "app.asar") {
  const archivePrefix = prefix;
  const archive = fs.readFileSync(asarPath);
  if (archive.length < 16) {
    throw new Error(`Invalid ASAR archive: ${asarPath}`);
  }

  const headerSize = archive.readUInt32LE(4);
  const jsonSize = archive.readUInt32LE(12);
  const header = JSON.parse(archive.subarray(16, 16 + jsonSize).toString("utf8"));
  const dataStart = 8 + headerSize;
  const entries = [];

  function walk(directory, files) {
    for (const [name, entry] of Object.entries(files ?? {})) {
      const fullPath = directory ? `${directory}/${name}` : name;
      if (entry.files) {
        walk(fullPath, entry.files);
      } else {
        const size = Number(entry.size ?? 0);
        const offset = Number(entry.offset ?? 0);
        const unpacked = Boolean(entry.unpacked);
        const buffer = unpacked ? null : archive.subarray(dataStart + offset, dataStart + offset + size);
        entries.push({
          archivePath: fullPath,
          buffer,
          executable: Boolean(entry.executable),
          link: entry.link ?? null,
          relativePath: normalizePath(path.posix.join(archivePrefix, fullPath)),
          size,
          source: "asar",
          unpacked,
        });
      }
    }
  }

  walk("", header.files);
  return entries;
}

function asarDestinationPath(targetDir, archivePath) {
  const normalized = normalizePath(archivePath);
  if (normalized.length === 0 || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe ASAR entry path: ${archivePath}`);
  }
  const targetRoot = path.resolve(targetDir);
  const destination = path.resolve(targetRoot, ...normalized.split("/"));
  if (destination !== targetRoot && !destination.startsWith(`${targetRoot}${path.sep}`)) {
    throw new Error(`Unsafe ASAR entry path: ${archivePath}`);
  }
  return destination;
}

function extractAsarToDirectory(asarPath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of asarEntries(asarPath, "")) {
    if (entry.link != null) {
      continue;
    }
    const destination = asarDestinationPath(targetDir, entry.archivePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (entry.unpacked) {
      const unpackedSource = path.join(`${asarPath}.unpacked`, ...entry.archivePath.split("/"));
      if (fs.existsSync(unpackedSource)) {
        fs.copyFileSync(unpackedSource, destination);
      }
    } else if (entry.buffer != null) {
      fs.writeFileSync(destination, entry.buffer, entry.executable ? { mode: 0o755 } : undefined);
    }
  }
}

function copyDirectoryContents(sourceDir, targetDir) {
  if (fs.lstatSync(sourceDir).isSymbolicLink()) {
    throw new Error(`Refusing symlinked patch-preflight source: ${sourceDir}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symlinked patch-preflight entry: ${sourcePath}`);
    }
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    } else {
      throw new Error(`Refusing non-file patch-preflight entry: ${sourcePath}`);
    }
  }
}

function prepareRequiredPatchPreflightApp({ appDir, targetDir } = {}) {
  if (appDir == null || targetDir == null) {
    throw new Error("appDir and targetDir are required for patch preflight");
  }
  fs.rmSync(targetDir, { force: true, recursive: true });
  const resourcesDir = fs.existsSync(path.join(appDir, "Contents/Resources"))
    ? path.join(appDir, "Contents/Resources")
    : appDir;
  const extractedAsarDir = path.join(resourcesDir, "app.asar.extracted");
  const asarPath = path.join(resourcesDir, "app.asar");
  if (fs.existsSync(extractedAsarDir)) {
    copyDirectoryContents(extractedAsarDir, targetDir);
    return targetDir;
  }
  if (fs.existsSync(asarPath)) {
    extractAsarToDirectory(asarPath, targetDir);
    return targetDir;
  }
  if (fs.existsSync(path.join(appDir, ".vite/build"))) {
    copyDirectoryContents(appDir, targetDir);
    return targetDir;
  }
  throw new Error(`Could not find app.asar or extracted app contents under ${appDir}`);
}

function walkFiles(rootDir, source = "filesystem", prefix = "") {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of entries) {
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(fullPath);
      } else if (dirent.isFile()) {
        const stat = fs.statSync(fullPath);
        const relativePath = normalizePath(path.join(prefix, path.relative(rootDir, fullPath)));
        files.push({
          absolutePath: fullPath,
          mode: stat.mode,
          relativePath,
          size: stat.size,
          source,
        });
      }
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function sourceKind(sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory() && /\.app$/i.test(path.basename(sourcePath))) {
    return "app";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (/\.dmg$/i.test(sourcePath)) {
    return "dmg";
  }
  throw new Error(`Unsupported upstream source: ${sourcePath}`);
}

function findAppDir(extractDir) {
  const stack = [extractDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of entries) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const fullPath = path.join(current, dirent.name);
      if (/\.app$/i.test(dirent.name)) {
        return fullPath;
      }
      stack.push(fullPath);
    }
  }
  return null;
}

function extractDmgToApp({ dmgPath, workDir }) {
  const extractDir = path.join(workDir, "dmg-extract");
  fs.mkdirSync(extractDir, { recursive: true });
  const sevenZipCommand = commandOnPath("7zz") ?? commandOnPath("7z");
  if (sevenZipCommand == null) {
    throw new Error("7zz or 7z is required to inspect DMG files");
  }
  const seven = spawnSync(sevenZipCommand, ["x", "-y", "-snl", dmgPath, `-o${extractDir}`], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const appDir = findAppDir(extractDir);
  if (seven.status !== 0 && appDir == null) {
    throw new Error(`7z failed to extract DMG: ${(seven.stderr || seven.stdout || "").trim()}`);
  }
  if (appDir == null) {
    throw new Error(`Could not find .app bundle in extracted DMG: ${dmgPath}`);
  }
  return appDir;
}

function commandOnPath(command) {
  const cacheKey = `${process.env.PATH ?? ""}\0${command}`;
  if (commandPathCache.has(cacheKey)) {
    return commandPathCache.get(cacheKey);
  }
  const resolved = resolveCommandOnPath(command);
  commandPathCache.set(cacheKey, resolved);
  return resolved;
}

function resolveCommandOnPath(command) {
  if (command.includes(path.sep)) {
    return executablePathOrNull(command);
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, command);
    const resolved = executablePathOrNull(candidate);
    if (resolved != null) {
      return resolved;
    }
  }
  return null;
}

function executablePathOrNull(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function collectInventoryFiles(appDir, options = {}) {
  const resourcesDir = path.join(appDir, "Contents/Resources");
  const hasAppBundleResources = fs.existsSync(resourcesDir);
  const root = hasAppBundleResources ? appDir : appDir;
  const resourcesPrefix = hasAppBundleResources ? "Contents/Resources" : "";
  const files = walkFiles(root).filter((file) => !file.relativePath.includes("app.asar.extracted/"));
  const asarPath = path.join(resourcesDir, "app.asar");
  const asarExtractedDir = path.join(resourcesDir, "app.asar.extracted");

  if (fs.existsSync(asarPath)) {
    try {
      files.push(...asarEntries(asarPath, normalizePath(path.join(resourcesPrefix, "app.asar"))));
    } catch (error) {
      files.push({
        relativePath: "app.asar",
        scanError: error.message,
        size: fs.statSync(asarPath).size,
        source: "asar",
      });
    }
  }

  if (fs.existsSync(asarExtractedDir)) {
    files.push(...walkFiles(asarExtractedDir, "asar-extracted", normalizePath(path.join(resourcesPrefix, "app.asar"))));
  }

  return files.map((file) => enrichInventoryFile(file, options));
}

function fileType(file) {
  if (file.relativePath.endsWith(".json")) {
    return "json";
  }
  if (TEXT_FILE_PATTERN.test(file.relativePath)) {
    return "text";
  }
  const executable = typeof file.mode === "number" && (file.mode & 0o111) !== 0;
  const extension = path.posix.extname(file.relativePath);
  if (NATIVE_FILE_PATTERN.test(file.relativePath) || (executable && extension === "")) {
    return "native";
  }
  return "binary";
}

function readFileBuffer(file) {
  if (file.buffer != null) {
    return file.buffer;
  }
  if (file.absolutePath != null) {
    return fs.readFileSync(file.absolutePath);
  }
  return null;
}

function runFileCommand(absolutePath) {
  if (absolutePath == null) {
    return null;
  }
  const result = spawnSync("file", ["-b", absolutePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function enrichInventoryFile(file, options = {}) {
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const maxHashBytes = options.maxHashBytes ?? DEFAULT_MAX_INVENTORY_HASH_BYTES;
  const type = fileType(file);
  const buffer = file.unpacked ? null : readFileBuffer(file);
  const enriched = {
    absolutePath: file.absolutePath,
    mode: file.mode == null ? null : `0${(file.mode & 0o777).toString(8)}`,
    relativePath: normalizePath(file.relativePath),
    size: file.size ?? buffer?.length ?? 0,
    source: file.source,
    type,
  };

  if (file.scanError != null) {
    enriched.scanError = file.scanError;
  }
  if (buffer != null && enriched.size <= maxHashBytes) {
    enriched.sha256 = sha256(buffer);
  }
  if (buffer != null && (type === "text" || type === "json") && enriched.size <= maxTextBytes) {
    enriched.text = buffer.toString("utf8");
  }
  if (buffer != null && type === "native") {
    enriched.nativeStrings = printableStrings(buffer).slice(0, 5000);
    enriched.fileCommand = runFileCommand(file.absolutePath);
  }

  return enriched;
}

function createInventory({ registry = null, sourcePath, workDir = null } = {}) {
  if (sourcePath == null) {
    throw new Error("sourcePath is required");
  }
  const resolvedSourcePath = path.resolve(sourcePath);
  const kind = sourceKind(resolvedSourcePath);
  let scratchDir = workDir;
  let cleanupScratch = false;
  if (kind === "dmg" && scratchDir == null) {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-intel-"));
    cleanupScratch = true;
  }

  try {
    const appDir = kind === "dmg" ? extractDmgToApp({ dmgPath: resolvedSourcePath, workDir: scratchDir }) : resolvedSourcePath;
    const files = collectInventoryFiles(appDir).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      generatedAt: new Date().toISOString(),
      registryVersion: registry?.version ?? null,
      source: {
        kind,
        path: resolvedSourcePath,
        appDir,
      },
      counts: {
        files: files.length,
        nativeFiles: files.filter((file) => file.type === "native").length,
        textFiles: files.filter((file) => file.type === "text" || file.type === "json").length,
      },
      files,
      versionMetadata: extractVersionMetadata(files),
    };
  } finally {
    if (cleanupScratch && scratchDir != null) {
      fs.rmSync(scratchDir, { force: true, recursive: true });
    }
  }
}

function firstVersion(value) {
  const match = String(value ?? "").match(/\b\d+\.\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0] ?? null;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalPlistVersions(file) {
  const values = {
    cfBundleShortVersionString: null,
    cfBundleVersion: null,
  };
  const text = file.text ?? "";
  for (const [field, key] of Object.entries({
    cfBundleShortVersionString: "CFBundleShortVersionString",
    cfBundleVersion: "CFBundleVersion",
  })) {
    values[field] =
      text.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>\\s*([^<]+)`, "i"))?.[1]?.trim() ??
      text.match(new RegExp(`${key}[^0-9]{0,20}([0-9][0-9A-Za-z.+-]*)`, "i"))?.[1] ??
      null;
  }
  if ((values.cfBundleShortVersionString != null && values.cfBundleVersion != null) || file.absolutePath == null) {
    return values;
  }
  const script = [
    "import json, plistlib, sys",
    "with open(sys.argv[1], 'rb') as handle:",
    "    data = plistlib.load(handle)",
    "print(json.dumps({key: data.get(key) for key in ('CFBundleShortVersionString', 'CFBundleVersion')}))",
  ].join("\n");
  const parsed = spawnSync("python3", ["-c", script, file.absolutePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (parsed.status === 0) {
    const plist = parseJsonObject(parsed.stdout);
    values.cfBundleShortVersionString ??= firstVersion(plist?.CFBundleShortVersionString);
    values.cfBundleVersion ??= String(plist?.CFBundleVersion ?? "").trim() || null;
  }
  return values;
}

function extractVersionMetadata(files = []) {
  const result = {
    cfBundleShortVersionString: null,
    cfBundleVersion: null,
    appPackageVersion: null,
    electronVersion: null,
    codexCliVersion: null,
    bundledPluginVersions: {},
    evidence: [],
  };
  const record = (key, value, evidencePath) => {
    if (value != null && result[key] == null) {
      result[key] = value;
      result.evidence.push({ field: key, path: evidencePath });
    }
  };
  for (const file of files) {
    const relativePath = normalizePath(file.relativePath);
    const pathLower = relativePath.toLowerCase();
    const text = file.text ?? (file.nativeStrings ?? []).join(" ");
    if (!text) continue;
    if (pathLower === "contents/info.plist") {
      const plistVersions = canonicalPlistVersions(file);
      record("cfBundleShortVersionString", plistVersions.cfBundleShortVersionString, relativePath);
      record("cfBundleVersion", plistVersions.cfBundleVersion, relativePath);
    }
    if (
      pathLower === "contents/resources/app.asar/package.json" ||
      (pathLower === "package.json" && file.source === "asar")
    ) {
      const manifest = parseJsonObject(text);
      if (manifest?.name === "openai-codex-electron" || manifest?.productName === "Codex") {
        record("appPackageVersion", firstVersion(manifest.version), relativePath);
        record(
          "electronVersion",
          firstVersion(manifest.devDependencies?.electron ?? manifest.dependencies?.electron),
          relativePath,
        );
      }
    }
    if (pathLower === "contents/resources/codex" || pathLower === "contents/resources/codex.exe") {
      const cliVersion = text.match(
        /\bcodex-cli(?:\s+version)?\s*[:=]?\s*v?(\d+\.\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)/i,
      )?.[1];
      record("codexCliVersion", firstVersion(cliVersion), relativePath);
    }
    const pluginMatch = relativePath.match(/plugins\/openai-bundled\/plugins\/([^/]+)\/\.codex-plugin\/plugin\.json$/);
    if (pluginMatch) {
      const version = firstVersion(parseJsonObject(text)?.version);
      if (version != null) result.bundledPluginVersions[pluginMatch[1]] = version;
    }
  }
  return result;
}

function fileEvidenceForSurface(inventory, surface) {
  const evidence = [];
  for (const file of inventory.files) {
    if (/(^|\/)(legacy|fallback|previous-bundle)(\/|$)/i.test(file.relativePath)) {
      continue;
    }
    const pathHit = matchAny(surface.pathPatterns, file.relativePath);
    const contentHits = [];
    const nativeHits = [];
    if (file.text != null) {
      for (const needle of surface.contentNeedles ?? []) {
        if (includesNeedle(file.text, needle)) {
          contentHits.push({ needle, snippet: textSnippet(file.text, needle) });
        }
      }
    }
    if (Array.isArray(file.nativeStrings)) {
      for (const needle of surface.nativeStringNeedles ?? surface.contentNeedles ?? []) {
        const matched = file.nativeStrings.find((value) => includesNeedle(value, needle));
        if (matched != null) {
          nativeHits.push({ needle, value: matched });
        }
      }
    }
    if (pathHit || contentHits.length > 0 || nativeHits.length > 0) {
      evidence.push({
        path: file.relativePath,
        sha256: file.sha256 ?? null,
        size: file.size,
        source: file.source,
        type: file.type,
        pathHit,
        contentHits,
        nativeHits,
      });
    }
  }
  return evidence;
}

function anchorFileMatches(inventory, anchor) {
  return inventory.files.filter((file) => {
    const pathOk = (anchor.pathPatterns ?? []).length === 0 || matchAny(anchor.pathPatterns, file.relativePath);
    if (!pathOk) {
      return false;
    }
    if (anchor.type != null && file.type !== anchor.type) {
      return false;
    }
    return true;
  });
}

function matchPatternList(patterns, value) {
  return (patterns ?? []).every((pattern) => toRegex(pattern).test(value));
}

function pluginAnchorState(anchor, pluginMap) {
  const plugins = pluginMap?.plugins ?? [];
  const pluginIds = anchor.pluginIds ?? [];
  const scriptPatterns = anchor.pluginScriptPatterns ?? [];
  const skillPatterns = anchor.pluginSkillPatterns ?? [];
  if (pluginIds.length === 0 && scriptPatterns.length === 0 && skillPatterns.length === 0) {
    return { missing: [], matchedPaths: [] };
  }
  const missingPlugins = pluginIds.filter((pluginId) => !plugins.some((plugin) => plugin.id === pluginId));
  const missingScripts = scriptPatterns.filter((pattern) =>
    !plugins.some((plugin) => plugin.scripts.some((script) => toRegex(pattern).test(script))),
  );
  const missingSkills = skillPatterns.filter((pattern) =>
    !plugins.some((plugin) => plugin.skills.some((skill) => toRegex(pattern).test(skill))),
  );
  const matchedPaths = [];
  for (const plugin of plugins) {
    if (pluginIds.length === 0 || pluginIds.includes(plugin.id)) {
      matchedPaths.push(...plugin.manifests.map((manifest) => manifest.path));
      matchedPaths.push(...plugin.scripts.filter((script) => matchAny(scriptPatterns, script)));
      matchedPaths.push(...plugin.skills.filter((skill) => matchAny(skillPatterns, skill)));
    }
  }
  return {
    missing: [
      ...missingPlugins.map((pluginId) => `plugin:${pluginId}`),
      ...missingScripts.map((pattern) => `script:${pattern}`),
      ...missingSkills.map((pattern) => `skill:${pattern}`),
    ],
    matchedPaths,
  };
}

function mcpAnchorState(anchor, pluginMap) {
  const matchedPaths = [];
  const missing = [];
  const pluginIds = anchor.pluginIds ?? [];
  const serverNames = anchor.mcpServerNames ?? [];
  const commandPatterns = anchor.mcpCommandPatterns ?? [];
  const requiredArgs = anchor.mcpArgs ?? [];
  if (
    pluginIds.length === 0 &&
    serverNames.length === 0 &&
    commandPatterns.length === 0 &&
    requiredArgs.length === 0
  ) {
    return { missing: [], matchedPaths: [] };
  }
  const servers = [];
  for (const plugin of pluginMap?.plugins ?? []) {
    if (pluginIds.length > 0 && !pluginIds.includes(plugin.id)) {
      continue;
    }
    for (const manifest of plugin.mcpServers ?? []) {
      for (const server of manifest.servers ?? []) {
        servers.push({ pluginId: plugin.id, manifestPath: manifest.path, server });
      }
    }
  }
  if (serverNames.length > 0) {
    for (const serverName of serverNames) {
      const found = servers.some((entry) => entry.server.name === serverName);
      if (!found) {
        missing.push(`mcpServer:${serverName}`);
      }
    }
  }
  for (const pattern of commandPatterns) {
    const found = servers.some((entry) => toRegex(pattern).test(entry.server.command ?? ""));
    if (!found) {
      missing.push(`mcpCommand:${pattern}`);
    }
  }
  for (const arg of requiredArgs) {
    const found = servers.some((entry) => entry.server.args.includes(arg));
    if (!found) {
      missing.push(`mcpArg:${arg}`);
    }
  }
  for (const entry of servers) {
    if (
      (serverNames.length === 0 || serverNames.includes(entry.server.name)) &&
      matchPatternList(commandPatterns, entry.server.command ?? "") &&
      requiredArgs.every((arg) => entry.server.args.includes(arg))
    ) {
      matchedPaths.push(entry.manifestPath);
    }
  }
  return { missing, matchedPaths };
}

function bridgeAnchorState(anchor, bridgeMap) {
  const handlerNames = anchor.bridgeHandlers ?? [];
  if (handlerNames.length === 0) {
    return { missing: [], matchedPaths: [] };
  }
  const missing = handlerNames.filter((handlerName) => !bridgeMap?.handlers?.some((handler) => handler.name === handlerName));
  const matchedPaths = (bridgeMap?.handlers ?? [])
    .filter((handler) => handlerNames.length === 0 || handlerNames.includes(handler.name))
    .map((handler) => handler.path);
  return { missing: missing.map((handler) => `bridgeHandler:${handler}`), matchedPaths };
}

function nativeAnchorState(anchor, nativeBinaryMap) {
  const patterns = anchor.nativeBinaryPatterns ?? [];
  const binaries = nativeBinaryMap?.binaries ?? [];
  const missing = patterns.filter((pattern) => !binaries.some((binary) => toRegex(pattern).test(binary.relativePath)));
  return {
    missing: missing.map((pattern) => `nativeBinary:${pattern}`),
    matchedPaths: binaries.filter((binary) => matchAny(patterns, binary.relativePath)).map((binary) => binary.relativePath),
  };
}

function evaluateRequiredAnchor(inventory, anchor, context = {}) {
  const files = anchorFileMatches(inventory, anchor);
  const missingNeedles = [];
  const matchedNeedles = [];
  const matchedPathSet = new Set();
  for (const needle of anchor.contentNeedles ?? []) {
    const matchedFiles = files.filter((file) => file.text != null && includesNeedle(file.text, needle));
    if (matchedFiles.length === 0) {
      missingNeedles.push(needle);
    } else {
      matchedNeedles.push({
        needle,
        type: "content",
        paths: matchedFiles.map((file) => file.relativePath).sort().slice(0, 20),
      });
      for (const file of matchedFiles) matchedPathSet.add(file.relativePath);
    }
  }
  for (const needle of anchor.nativeStringNeedles ?? []) {
    const matchedFiles = files.filter(
      (file) => Array.isArray(file.nativeStrings) && file.nativeStrings.some((value) => includesNeedle(value, needle)),
    );
    if (matchedFiles.length === 0) {
      missingNeedles.push(needle);
    } else {
      matchedNeedles.push({
        needle,
        type: "nativeString",
        paths: matchedFiles.map((file) => file.relativePath).sort().slice(0, 20),
      });
      for (const file of matchedFiles) matchedPathSet.add(file.relativePath);
    }
  }
  const pluginState = pluginAnchorState(anchor, context.pluginMap);
  const mcpState = mcpAnchorState(anchor, context.pluginMap);
  const bridgeState = bridgeAnchorState(anchor, context.bridgeMap);
  const nativeState = nativeAnchorState(anchor, context.nativeBinaryMap);
  for (const matchedPath of [
    ...pluginState.matchedPaths,
    ...mcpState.matchedPaths,
    ...bridgeState.matchedPaths,
    ...nativeState.matchedPaths,
  ]) {
    matchedPathSet.add(matchedPath);
  }
  const requiredPathMatched = (anchor.pathPatterns ?? []).length === 0 || files.length > 0;
  if (requiredPathMatched && (anchor.pathPatterns ?? []).length > 0 && missingNeedles.length === 0) {
    for (const file of files) matchedPathSet.add(file.relativePath);
  }
  const structuralMissing = [
    ...pluginState.missing,
    ...mcpState.missing,
    ...bridgeState.missing,
    ...nativeState.missing,
  ];
  const satisfied = requiredPathMatched && missingNeedles.length === 0 && structuralMissing.length === 0;
  return {
    id: anchor.id,
    title: anchor.title ?? anchor.id,
    satisfied,
    matchedPaths: [...matchedPathSet].sort().slice(0, 50),
    matchedNeedles,
    missingNeedles: [...missingNeedles, ...structuralMissing],
    requiredPathMatched,
  };
}

function evaluateRequiredAnchors(inventory, surface, context = {}) {
  const anchors = surface.requiredEvidence ?? [];
  const evaluated = anchors.map((anchor) => evaluateRequiredAnchor(inventory, anchor, context));
  return {
    anchors: evaluated,
    satisfiedAnchors: evaluated.filter((anchor) => anchor.satisfied),
    missingAnchors: evaluated.filter((anchor) => !anchor.satisfied),
  };
}

function surfaceFingerprint(surfaceEvidence) {
  const hash = crypto.createHash("sha256");
  for (const item of surfaceEvidence) {
    hash.update(item.path);
    hash.update("\0");
    hash.update(item.sha256 ?? String(item.size));
    hash.update("\0");
    for (const hit of item.contentHits ?? []) {
      hash.update(String(hit.needle));
      hash.update("\0");
    }
    for (const hit of item.nativeHits ?? []) {
      hash.update(String(hit.needle));
      hash.update("\0");
      hash.update(String(hit.value));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function substrateStatus(surface, repoRoot) {
  const requiredPaths = surface.linuxSubstrate?.requiredPaths ?? [];
  if (requiredPaths.length === 0) {
    return {
      status: "UNKNOWN",
      missingPaths: [],
      requiredPaths,
    };
  }
  const missingPaths = requiredPaths.filter((candidatePath) => !fs.existsSync(path.join(repoRoot, candidatePath)));
  return {
    status: missingPaths.length === 0 ? "PRESENT" : "MISSING",
    missingPaths,
    requiredPaths,
  };
}

function extractProtectedSurfaces({ inventory, registry, repoRoot = process.cwd() } = {}) {
  const bridgeMap = createBridgeMap(inventory);
  const pluginMap = createPluginMap(inventory);
  const nativeBinaryMap = createNativeBinaryMap(inventory, registry);
  const postPatchIntegrity = findPostPatchIntegrityFindings(inventory);
  const surfaces = (registry.surfaces ?? []).map((surface) => {
    const evidence = fileEvidenceForSurface(inventory, surface).sort((a, b) => a.path.localeCompare(b.path));
    const anchors = evaluateRequiredAnchors(inventory, surface, { bridgeMap, pluginMap, nativeBinaryMap });
    const hasAnchorContract = (surface.requiredEvidence ?? []).length > 0;
    const status = hasAnchorContract
      ? anchors.missingAnchors.length === 0
        ? "PRESENT"
        : evidence.length > 0
          ? "PARTIAL"
          : "MISSING"
      : evidence.length > 0
        ? "PRESENT"
        : "MISSING";
    const confidence = status === "PRESENT" ? (hasAnchorContract ? "high" : "medium") : status === "PARTIAL" ? "low" : "none";
    return {
      id: surface.id,
      title: surface.title,
      category: surface.category,
      patchNamePatterns: surface.patchNamePatterns ?? [],
      status,
      confidence,
      evidence,
      evidenceCount: evidence.length,
      requiredAnchors: anchors.anchors,
      satisfiedAnchors: anchors.satisfiedAnchors,
      missingAnchors: anchors.missingAnchors,
      fingerprint: status === "PRESENT" ? surfaceFingerprint(evidence) : null,
      linuxSubstrate: substrateStatus(surface, repoRoot),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    source: inventory.source,
    registryVersion: registry.version ?? null,
    surfaces,
    surfacesById: Object.fromEntries(surfaces.map((surface) => [surface.id, surface])),
    bridgeMap,
    pluginMap,
    nativeBinaryMap,
    postPatchIntegrity,
  };
}

function createBridgeMap(inventory) {
  const handlerPattern = /\b(?:ipcMain|ipcRenderer|contextBridge)\.(?:handle|on|invoke|exposeInMainWorld)\(\s*(['"`])([^'"`]+)\1/g;
  const handlers = [];
  const channelCandidates = [];
  const seenCandidates = new Set();
  for (const file of inventory.files) {
    if (file.text == null) {
      continue;
    }
    for (const match of file.text.matchAll(handlerPattern)) {
      handlers.push({
        name: match[2],
        path: file.relativePath,
        kind: match[0].split("(")[0],
      });
    }
    for (const match of file.text.matchAll(STRING_LITERAL_PATTERN)) {
      const name = match[1] ?? match[2] ?? match[3] ?? "";
      if (!isBridgeChannelCandidate(name)) {
        continue;
      }
      const key = `${name}\0${file.relativePath}`;
      if (seenCandidates.has(key)) {
        continue;
      }
      seenCandidates.add(key);
      channelCandidates.push({
        name,
        path: file.relativePath,
        kind: "string-literal",
      });
    }
  }
  return {
    handlers: handlers.sort((a, b) => `${a.name}:${a.path}`.localeCompare(`${b.name}:${b.path}`)),
    channelCandidates: channelCandidates.sort((a, b) =>
      `${a.name}:${a.path}`.localeCompare(`${b.name}:${b.path}`),
    ),
  };
}

function isBridgeChannelCandidate(name) {
  return (
    (LOWER_BRIDGE_CHANNEL_PATTERN.test(name) || CAMEL_BRIDGE_CHANNEL_PATTERN.test(name)) &&
    BRIDGE_CHANNEL_TERM_PATTERN.test(name) &&
    !ASSET_EXTENSION_PATTERN.test(name) &&
    !/[-_.:]$/u.test(name)
  );
}

function pluginIdFromPath(relativePath) {
  const match = relativePath.match(/plugins\/openai-bundled\/plugins\/([^/]+)\//);
  return match?.[1] ?? null;
}

function createPluginMap(inventory) {
  const pluginsById = new Map();
  for (const file of inventory.files) {
    const pluginId = pluginIdFromPath(file.relativePath);
    if (pluginId == null) {
      continue;
    }
    const plugin = pluginsById.get(pluginId) ?? {
      id: pluginId,
      files: [],
      fileFingerprints: [],
      manifests: [],
      mcpServers: [],
      scripts: [],
      skills: [],
    };
    plugin.files.push(file.relativePath);
    plugin.fileFingerprints.push({
      path: file.relativePath,
      sha256: file.sha256 ?? null,
      size: file.size,
      mode: file.mode ?? null,
    });
    if (file.relativePath.endsWith(".codex-plugin/plugin.json") && file.text != null) {
      try {
        const manifest = JSON.parse(file.text);
        plugin.manifests.push({
          path: file.relativePath,
          id: manifest.id ?? manifest.name ?? pluginId,
          name: manifest.name ?? null,
          version: manifest.version ?? null,
          displayName: manifest.interface?.displayName ?? null,
          shortDescription: manifest.interface?.shortDescription ?? null,
          defaultPrompt: manifest.interface?.defaultPrompt ?? null,
          mcpServerKeys: Array.isArray(manifest.mcpServers)
            ? manifest.mcpServers.map((server) => server.name ?? server.id ?? null).filter(Boolean)
            : Object.keys(manifest.mcpServers ?? {}),
          skillCount: Array.isArray(manifest.skills) ? manifest.skills.length : 0,
        });
      } catch (error) {
        plugin.manifests.push({ path: file.relativePath, parseError: error.message });
      }
    }
    if (file.relativePath.endsWith(".mcp.json") && file.text != null) {
      try {
        const manifest = JSON.parse(file.text);
        plugin.mcpServers.push({
          path: file.relativePath,
          servers: Object.entries(manifest.mcpServers ?? {}).map(([name, server]) => ({
            name,
            command: server.command ?? null,
            args: Array.isArray(server.args) ? server.args : [],
            envKeys: Object.keys(server.env ?? {}),
            tools: Array.isArray(server.tools)
              ? server.tools.map((tool) => (typeof tool === "string" ? tool : tool.name)).filter(Boolean)
              : [],
          })),
        });
      } catch (error) {
        plugin.mcpServers.push({ path: file.relativePath, parseError: error.message });
      }
    }
    if (/\/scripts\/[^/]+\.(mjs|js|cjs)$/i.test(file.relativePath) || /\/browser-client\.mjs$/i.test(file.relativePath)) {
      plugin.scripts.push(file.relativePath);
    }
    if (/\/skills\/[^/]+\/SKILL\.md$/i.test(file.relativePath)) {
      plugin.skills.push(file.relativePath);
    }
    pluginsById.set(pluginId, plugin);
  }
  return {
    plugins: [...pluginsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function nativeProtectedStringHits(file, registry) {
  const strings = Array.isArray(file.nativeStrings) ? file.nativeStrings : [];
  const needles = [
    ...new Set(
      (registry?.surfaces ?? []).flatMap((surface) => [
        ...(surface.nativeStringNeedles ?? []),
        ...(surface.contentNeedles ?? []),
      ]),
    ),
  ];
  return needles
    .flatMap((needle) => {
      const value = strings.find((candidate) => includesNeedle(candidate, needle));
      return value == null ? [] : [{ needle, value }];
    })
    .slice(0, 200);
}

function runBoundedToolLines(command, args, maxLines = 200) {
  const commandPath = commandOnPath(command);
  if (commandPath == null) {
    return null;
  }
  const result = spawnSync(commandPath, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, maxLines);
}

function nativeSymbolInventory(file) {
  if (file.absolutePath == null) {
    return null;
  }
  const llvmSymbols = runBoundedToolLines("llvm-nm", ["-g", file.absolutePath]);
  if (llvmSymbols != null) {
    return { tool: "llvm-nm -g", symbols: llvmSymbols };
  }
  const nmSymbols = runBoundedToolLines("nm", ["-g", file.absolutePath]);
  if (nmSymbols != null) {
    return { tool: "nm -g", symbols: nmSymbols };
  }
  return null;
}

function nativeLinkedLibraries(file) {
  if (file.absolutePath == null) {
    return null;
  }
  const otoolLibraries = runBoundedToolLines("otool", ["-L", file.absolutePath]);
  if (otoolLibraries != null) {
    return { tool: "otool -L", libraries: otoolLibraries };
  }
  return null;
}

function createNativeBinaryMap(inventory, registry = null) {
  const binaries = inventory.files
    .filter((file) => file.type === "native")
    .map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256 ?? null,
      size: file.size,
      fileCommand: file.fileCommand ?? null,
      protectedStringHits: nativeProtectedStringHits(file, registry),
      symbols: nativeSymbolInventory(file),
      linkedLibraries: nativeLinkedLibraries(file),
    }));
  return { binaries };
}

const LINUX_SETTINGS_PATCH_SYMBOL_PATTERN = /\bcodexLinux[A-Za-z0-9_$]*SettingsIcon\b/g;

function segmentDeclaresSymbol(segment, symbol) {
  const escaped = escapeRegExp(symbol);
  return new RegExp(`^\\s*${escaped}(?![A-Za-z0-9_$])`).test(segment);
}

function hasVariableDeclarator(source, symbol) {
  const keywordPattern = /\b(?:var|let|const)\b/g;
  let match;
  while ((match = keywordPattern.exec(source)) != null) {
    let segmentStart = keywordPattern.lastIndex;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let terminated = false;
    for (let index = segmentStart; index < source.length; index += 1) {
      const char = source[index];
      if (quote != null) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(" || char === "[" || char === "{") {
        depth += 1;
        continue;
      }
      if (char === ")" || char === "]" || char === "}") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth === 0 && (char === "," || char === ";")) {
        if (segmentDeclaresSymbol(source.slice(segmentStart, index), symbol)) {
          return true;
        }
        if (char === ";") {
          terminated = true;
          break;
        }
        segmentStart = index + 1;
      }
    }
    if (!terminated && segmentDeclaresSymbol(source.slice(segmentStart), symbol)) {
      return true;
    }
  }
  return false;
}

function hasLocalPatchSymbolDeclaration(source, symbol) {
  const escaped = escapeRegExp(symbol);
  return (
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`).test(source) ||
    hasVariableDeclarator(source, symbol)
  );
}

function findComputerUsePlatformGateFindings(inventory) {
  const findings = [];
  const nativeAppsQueryGatePattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)===`macOS`\|\|\3===`windows`(?!\|\|\3===`linux`)\)/g;
  const nativeAppMentionSectionPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`macOS`\|\|\2===`windows`(?!\|\|\2===`linux`)/g;
  const nativeAppSettingsCardPattern =
    /if\(([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)===`macOS`\|\|\2===`windows`(?!\|\|\2===`linux`)\)\)for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{/g;
  const nativeAppIconQueryGatePattern =
    /([A-Za-z_$][\w$]*)=\(([A-Za-z_$][\w$]*)===`macOS`\|\|\2===`windows`(?!\|\|\2===`linux`)\)&&([A-Za-z_$][\w$]*)!=null&&\3!==``/g;
  const pluginRegistrationRolloutGatePattern =
    /(?:isEnabled|isAvailable):\(\{features:([A-Za-z_$][\w$]*),platform:([A-Za-z_$][\w$]*)\}\)=>\(\2===`darwin`\|\|\2===`linux`\)&&\1\.computerUse/g;
  for (const file of inventory.files) {
    if (file.text == null) {
      continue;
    }
    if (file.text.includes("`native-desktop-apps`") && file.text.includes("nativeApps:")) {
      for (const match of file.text.matchAll(nativeAppsQueryGatePattern)) {
        const nextSource = file.text.slice(match.index + match[0].length, match.index + match[0].length + 1400);
        if (!nextSource.includes("`native-desktop-apps`") || !nextSource.includes("nativeApps:")) {
          continue;
        }
        findings.push({
          path: file.relativePath,
          reason: "Computer Use native app query is still gated to macOS/Windows after Linux patching",
          snippet: textSnippet(file.text, match[0]),
          symbol: "computer-use-native-apps-linux-gate",
        });
      }
    }
    if (
      file.text.includes("computerUsePlugin:") &&
      file.text.includes("chromeAppPlugins:") &&
      file.text.includes("microsoftExcelAppPlugins:")
    ) {
      for (const match of file.text.matchAll(nativeAppMentionSectionPattern)) {
        const nextSource = file.text.slice(match.index + match[0].length, match.index + match[0].length + 1600);
        if (
          !nextSource.includes("computerUsePlugin:") ||
          !nextSource.includes("chromeAppPlugins:") ||
          !nextSource.includes("microsoftExcelAppPlugins:")
        ) {
          continue;
        }
        findings.push({
          path: file.relativePath,
          reason: "Computer Use composer native-app mention section is still gated to macOS/Windows after Linux patching",
          snippet: textSnippet(file.text, match[0]),
          symbol: "computer-use-composer-native-app-mentions-linux-gate",
        });
      }
    }
    if (
      file.text.includes("appControlId") &&
      file.text.includes("toggleAriaLabel") &&
      file.text.includes("plugin.installed")
    ) {
      for (const match of file.text.matchAll(nativeAppSettingsCardPattern)) {
        const nextSource = file.text.slice(match.index + match[0].length, match.index + match[0].length + 1800);
        if (
          !nextSource.includes("appControlId") ||
          !nextSource.includes("toggleAriaLabel") ||
          !nextSource.includes("plugin.installed")
        ) {
          continue;
        }
        findings.push({
          path: file.relativePath,
          reason: "Computer Use settings native app cards are still gated to macOS/Windows after Linux patching",
          snippet: textSnippet(file.text, match[0]),
          symbol: "computer-use-settings-native-app-card-linux-gate",
        });
      }
    }
    if (file.text.includes("`computer-use-native-desktop-app-icon`")) {
      for (const match of file.text.matchAll(nativeAppIconQueryGatePattern)) {
        const nextSource = file.text.slice(match.index + match[0].length, match.index + match[0].length + 1200);
        if (!nextSource.includes("`computer-use-native-desktop-app-icon`")) {
          continue;
        }
        findings.push({
          path: file.relativePath,
          reason: "Computer Use native app icon query is still gated to macOS/Windows after Linux patching",
          snippet: textSnippet(file.text, match[0]),
          symbol: "computer-use-native-app-icon-linux-gate",
        });
      }
    }
    if (file.text.includes("installWhenMissing:!0")) {
      for (const match of file.text.matchAll(pluginRegistrationRolloutGatePattern)) {
        findings.push({
          path: file.relativePath,
          reason: "Linux Computer Use plugin registration still depends on the upstream rollout flag",
          snippet: textSnippet(file.text, match[0]),
          symbol: "computer-use-plugin-registration-rollout-gate",
        });
      }
    }
    if (
      file.text.includes("computer-use-plugin-icon-linux.png") &&
      file.text.includes("availablePlugins.some") &&
      file.text.includes("plugin?.name") &&
      !file.text.includes("e.plugin?.installed===!0&&e.plugin?.enabled===!0")
    ) {
      findings.push({
        path: file.relativePath,
        reason: "Synthetic Linux Computer Use settings plugin can be masked by an unavailable upstream entry",
        snippet: textSnippet(file.text, "computer-use-plugin-icon-linux.png"),
        symbol: "computer-use-settings-synthetic-plugin-mask",
      });
    }
  }
  return findings;
}

function findPostPatchIntegrityFindings(inventory, options = {}) {
  const findings = [];
  for (const file of inventory.files) {
    if (file.text == null) {
      continue;
    }
    const symbols = [...new Set(file.text.match(LINUX_SETTINGS_PATCH_SYMBOL_PATTERN) ?? [])];
    for (const symbol of symbols) {
      if (hasLocalPatchSymbolDeclaration(file.text, symbol)) {
        continue;
      }
      findings.push({
        path: file.relativePath,
        reason: "Linux settings patch symbol is referenced without a local declaration",
        snippet: textSnippet(file.text, symbol),
        symbol,
      });
    }
  }
  if (options.includeComputerUsePlatformGates === true) {
    findings.push(...findComputerUsePlatformGateFindings(inventory));
  }
  return findings.sort((a, b) => `${a.symbol}:${a.path}`.localeCompare(`${b.symbol}:${b.path}`));
}

function platformGateContext(file, index, matchLength, radius = 900) {
  const start = Math.max(0, index - radius);
  const end = Math.min(file.text.length, index + matchLength + radius);
  return file.text.slice(start, end);
}

function compactSnippet(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 260);
}

function isComputerUsePlatformGateContext(lower, pathLower) {
  return (
    (pathLower.includes("computer-use") && !pathLower.includes("marketing")) ||
    lower.includes("computer-use-native-desktop-app-icon") ||
    lower.includes("computer-use-plugin-icon-linux") ||
    (lower.includes("native-desktop-apps") &&
      (lower.includes("availableplugins") || lower.includes("plugin.installed") || lower.includes("appcontrolid") ||
        lower.includes("queryconfig") || lower.includes("computeruseplugin"))) ||
    (lower.includes("accessibility_snapshot") && lower.includes("event_stream"))
  );
}

function classifyPlatformGate({ file, gate, context }) {
  const lower = context.toLowerCase();
  const pathLower = file.relativePath.toLowerCase();

  if (gate.includes("===`linux`")) {
    return {
      category: "already-linux-enabled",
      confidence: "high",
      feature: "Linux-aware platform gate",
      issueCandidate: false,
      linuxSurfaceId: null,
      patchTarget: "none",
      recommendation: "No action; Linux is already part of this platform gate.",
    };
  }

  const chronicleContract =
    (lower.includes("chroniclesidecarpresent") && lower.includes("chroniclesidecarprocessstate") &&
      lower.includes("rememberconsentaccepted")) ||
    (lower.includes("skysight_snapshot") && lower.includes("event_stream_start")) ||
    (lower.includes("linux-record-replay-skysight-status") && lower.includes("skysight"));
  if (chronicleContract) {
    const skysight = lower.includes("skysight") && !lower.includes("chroniclesidecar");
    return {
      category: "linux-parity-drift",
      confidence: "high",
      confidenceRationale: "Exact Chronicle/Skysight status, consent, or bridge contract matched.",
      feature: skysight ? "Skysight controls and bridge" : "Chronicle settings toggle paths",
      issueCandidate: false,
      linuxSurfaceId: skysight ? "skysight_bridge" : "chronicle_settings_toggles",
      patchTarget: skysight
        ? "linux-features/record-and-replay/patch.js and record-replay-linux/src/mcp.rs"
        : "linux-features/record-and-replay/patch.js",
      linuxStatus: "existing-linux-substrate",
      recommendation: "Expose and test the explicit stopped/not-started state, consent, enable/disable, and bridge status semantics on Linux.",
    };
  }

  if (
    lower.includes("appcontrolid") &&
    lower.includes("togglearialabel") &&
    lower.includes("plugin.installed")
  ) {
    return {
      category: "linux-parity-drift",
      confidence: "high",
      confidenceRationale: "Exact Computer Use settings card contract matched.",
      feature: "Computer Use settings native app cards",
      issueCandidate: false,
      linuxSurfaceId: "computer_use_plugin",
      patchTarget: "scripts/patches/impl/computer-use.js",
      recommendation: "Patch the settings native app card loop so Linux renders the existing Computer Use Any App/native app controls.",
      linuxStatus: "existing-linux-substrate",
    };
  }

  if (lower.includes("computer-use-native-desktop-app-icon")) {
    return {
      category: "linux-parity-drift",
      confidence: "high",
      confidenceRationale: "Exact Computer Use native icon contract matched.",
      feature: "Computer Use native app icons",
      issueCandidate: false,
      linuxSurfaceId: "computer_use_plugin",
      patchTarget: "scripts/patches/impl/computer-use.js",
      recommendation: "Patch the native desktop app icon query gate so Linux can request native app icons for Computer Use cards and mentions.",
      linuxStatus: "existing-linux-substrate",
    };
  }

  if (isComputerUsePlatformGateContext(lower, pathLower)) {
    return {
      category: "linux-parity-drift",
      confidence: "high",
      confidenceRationale: "Exact Computer Use renderer contract matched.",
      feature: "Computer Use native app UI",
      issueCandidate: false,
      linuxSurfaceId: "computer_use_plugin",
      patchTarget: "scripts/patches/impl/computer-use.js",
      recommendation: "Patch the renderer availability gate so Linux exposes the existing Computer Use backend in settings and @ mentions.",
      linuxStatus: "existing-linux-substrate",
    };
  }

  if (pathLower.includes("computer-use") || lower.includes("computer use") || lower.includes("computer-use")) {
    return {
      category: "needs-review",
      confidence: "medium",
      confidenceRationale: "Computer Use mention is present without an exact Linux parity contract.",
      feature: "Computer Use generic platform mention",
      issueCandidate: false,
      linuxSurfaceId: "computer_use_plugin",
      patchTarget: "scripts/patches/impl/computer-use.js",
      linuxStatus: "existing-linux-substrate",
      recommendation: "Review the current-bundle context before treating this generic mention as a Linux parity blocker.",
    };
  }

  if (lower.includes("microsoftexcel") || lower.includes("microsoftpowerpoint")) {
    return {
      category: "platform-specific-unsupported",
      confidence: "high",
      confidenceRationale: "Exact Office native-app marker matched.",
      feature: "Office live-control app mentions",
      issueCandidate: true,
      linuxSurfaceId: null,
      patchTarget: "new issue or optional linux-features/<office-live-control>/",
      recommendation: "Label as macOS/Windows-only until a Linux native app bridge exists; create a feature issue if parity is desired.",
      linuxStatus: "unsupported-no-substrate",
    };
  }

  if (
    lower.includes("settogglehotkey") ||
    lower.includes("synccommandkeybindings") ||
    lower.includes("commandkeybindings") ||
    lower.includes("globalhotkey")
  ) {
    return {
      category: "platform-specific-unsupported",
      confidence: "high",
      confidenceRationale: "Exact global-hotkey marker matched.",
      feature: "Global hotkey/keybinding integration",
      issueCandidate: true,
      linuxSurfaceId: null,
      patchTarget: "new issue or optional linux-features/<global-hotkeys>/",
      recommendation: "Label as macOS/Windows-only until a Linux global shortcut backend exists; create a feature issue if parity is desired.",
      linuxStatus: "unsupported-no-substrate",
    };
  }

  if (lower.includes("agi intelligence") || lower.includes("supreme")) {
    return {
      category: "new-upstream-capability",
      confidence: "high",
      feature: "Unmapped high-signal desktop capability",
      issueCandidate: true,
      linuxSurfaceId: null,
      patchTarget: "scripts/dev/upstream-dmg-protected-surfaces.json plus a new Linux feature or backend owner",
      recommendation: "Create an issue for the new upstream desktop capability and decide whether Linux needs a native port.",
    };
  }

  if (lower.includes("chronicle") || lower.includes("skysight") || lower.includes("recording") || lower.includes("event_stream")) {
    return {
      category: "needs-review",
      confidence: "medium",
      feature: "Chronicle/Skysight/Record & Replay desktop capability",
      issueCandidate: true,
      linuxSurfaceId: lower.includes("chronicle") ? "chronicle_settings_toggles" : "record_and_replay_plugin",
      patchTarget: "linux-features/record-and-replay and record-replay-linux",
      recommendation: "Review whether this gate hides an existing Linux-backed feature or a new upstream desktop capability.",
      confidenceRationale: "Generic Chronicle/Skysight text without an exact contract.",
    };
  }

  if (
    lower.includes("titlebar") ||
    lower.includes("trafficlight") ||
    lower.includes("dock") ||
    lower.includes("tray") ||
    lower.includes("windowbutton") ||
    pathLower.includes("titlebar")
  ) {
    return {
      category: "expected-platform-native",
      confidence: "medium",
      feature: "OS-native window chrome or shell integration",
      issueCandidate: false,
      linuxSurfaceId: null,
      patchTarget: "none by default",
      recommendation: "Keep labeled as platform-native unless the Linux window shell regresses.",
    };
  }

  if (
    lower.includes("native") ||
    lower.includes("desktop") ||
    lower.includes("appplugin") ||
    lower.includes("sidecar") ||
    lower.includes("mcp") ||
    lower.includes("plugin")
  ) {
    return {
      category: "new-upstream-capability",
      confidence: "medium",
      feature: "Unmapped desktop/native/plugin capability",
      issueCandidate: true,
      linuxSurfaceId: null,
      patchTarget: "scripts/dev/upstream-dmg-protected-surfaces.json plus a new Linux feature or backend owner",
      recommendation: "Create an issue, decide whether Linux needs a port or explicit unsupported label, and add a protected surface if accepted.",
    };
  }

  return {
    category: "needs-review",
    confidence: "low",
    feature: "Unclassified platform gate",
    issueCandidate: false,
    linuxSurfaceId: null,
    patchTarget: "manual review",
    recommendation: "Classify this gate as Linux parity, new capability, unsupported, or expected platform-native before accepting release drift.",
  };
}

function createPlatformGateEntry({ file, gate, index, patternName }) {
  const context = platformGateContext(file, index, gate.length);
  const classification = classifyPlatformGate({ file, gate, context });
  return {
    id: sha256(Buffer.from(`${file.relativePath}\0${gate}\0${compactSnippet(context)}`)).slice(0, 16),
    path: file.relativePath,
    gate,
    platforms: gate.includes("!==`linux`") && gate.includes("!==`darwin`")
      ? ["win32"]
      : (gate.includes("darwin") || gate.includes("win32") ? ["darwin", "win32"] : ["macOS", "windows"]),
    excludesLinux: gate.includes("!==`linux`"),
    pattern: patternName,
    snippet: compactSnippet(context),
    evidenceType: "platform-gate-context",
    platformLabel: classification.platformLabel ?? (gate.includes("darwin") || gate.includes("win32") ? "macOS/windows" : "unknown"),
    entitlement: classification.entitlement ?? "unknown",
    rollout: classification.rollout ?? "unknown",
    linuxStatus: classification.linuxStatus ?? "unknown",
    ownerPath: classification.patchTarget ?? "manual review",
    recommendedAction: classification.recommendation,
    ...classification,
  };
}

function createPlatformGateMap({ inventory, patchFindings = [], requiredPatchPreflight = null } = {}) {
  const gates = [];
  const seen = new Set();
  const gatePatterns = [
    {
      name: "ui-platform-macos-windows",
      regex: /[A-Za-z_$][\w$]*===`macOS`\|\|[A-Za-z_$][\w$]*===`windows`(?:\|\|[A-Za-z_$][\w$]*===`linux`)?/g,
    },
    {
      name: "process-platform-darwin-win32",
      regex: /process\.platform===`darwin`\|\|process\.platform===`win32`|process\.platform!==`linux`&&process\.platform!==`darwin`/g,
    },
  ];

  for (const file of inventory.files ?? []) {
    if (file.text == null) {
      continue;
    }
    for (const pattern of gatePatterns) {
      for (const match of file.text.matchAll(pattern.regex)) {
        const entry = createPlatformGateEntry({
          file,
          gate: match[0],
          index: match.index,
          patternName: pattern.name,
        });
        const key = `${entry.path}\0${entry.gate}\0${entry.category}\0${entry.feature}`;
        if (!seen.has(key)) {
          seen.add(key);
          gates.push(entry);
        }
      }
    }

    if (
      file.text.includes("computer-use-plugin-icon-linux.png") &&
      file.text.includes("availablePlugins.some") &&
      file.text.includes("plugin?.name") &&
      !file.text.includes("e.plugin?.installed===!0&&e.plugin?.enabled===!0")
    ) {
      const entry = {
        id: sha256(Buffer.from(`${file.relativePath}\0computer-use-settings-mask`)).slice(0, 16),
        path: file.relativePath,
        gate: "synthetic Linux Computer Use row masked by unavailable upstream plugin",
        platforms: ["linux"],
        pattern: "synthetic-plugin-mask",
        snippet: textSnippet(file.text, "computer-use-plugin-icon-linux.png"),
        category: "linux-parity-drift",
        confidence: "high",
        feature: "Computer Use settings row",
        issueCandidate: false,
        linuxSurfaceId: "computer_use_plugin",
        patchTarget: "scripts/patches/impl/computer-use.js",
        recommendation: "Prepend the enabled synthetic Linux Computer Use plugin unless an installed and enabled upstream entry already exists.",
      };
      const key = `${entry.path}\0${entry.gate}`;
      if (!seen.has(key)) {
        seen.add(key);
        gates.push(entry);
      }
    }
  }

  const findingsByName = new Map(patchFindings.map((finding) => [finding.name, finding]));
  for (const gate of gates) {
    if (gate.category !== "linux-parity-drift") {
      continue;
    }
    const requiredPatches = LINUX_PARITY_SURFACE_PATCHES[gate.linuxSurfaceId] ?? [];
    if (requiredPatches.length === 0) {
      continue;
    }
    const coverage = requiredPatches.map((name) => findingsByName.get(name) ?? { name, status: "not-recorded" });
    gate.patchPreflight = coverage.map(({ name, status }) => ({ name, status }));
    const gateProof = (requiredPatchPreflight?.computerUseInspection?.gateProofs ?? [])
      .find((proof) => proof.gateId === gate.id && proof.path === gate.path && proof.gate === gate.gate);
    if (
      requiredPatchPreflight?.status === "pass" &&
      requiredPatchPreflight?.exitCode === 0 &&
      requiredPatchPreflight?.computerUseInspection?.status === "pass" &&
      coverage.every((finding) => ["applied", "already-applied"].includes(finding.status)) &&
      gateProof?.status === "verified"
    ) {
      gate.rawCategory = gate.category;
      gate.category = "patched-linux-parity";
      gate.linuxStatus = "patched-for-candidate";
      gate.recommendedAction = "No action; every exact Linux parity patch applied to this candidate.";
      gate.recommendation = gate.recommendedAction;
    }
  }

  const categoryCounts = {};
  for (const gate of gates) {
    categoryCounts[gate.category] = (categoryCounts[gate.category] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    source: inventory.source,
    categoryCounts,
    blockingCount: gates.filter((gate) => PLATFORM_GATE_BLOCKING_CATEGORIES.has(gate.category)).length,
    reviewCount: gates.filter((gate) => PLATFORM_GATE_REVIEW_CATEGORIES.has(gate.category)).length,
    gates: gates.sort((a, b) => `${a.category}:${a.feature}:${a.path}`.localeCompare(`${b.category}:${b.feature}:${b.path}`)),
  };
}

function classifySurfaceDrift({ baselineSurface, candidateSurface }) {
  const baselinePresent = baselineSurface?.status === "PRESENT";
  const candidatePresent = candidateSurface?.status === "PRESENT";
  if (baselinePresent && candidatePresent) {
    const baselinePaths = new Set(baselineSurface.evidence.map((entry) => entry.path));
    const candidatePaths = new Set(candidateSurface.evidence.map((entry) => entry.path));
    const samePaths =
      baselinePaths.size === candidatePaths.size &&
      [...baselinePaths].every((entryPath) => candidatePaths.has(entryPath));
    if (samePaths && baselineSurface.fingerprint === candidateSurface.fingerprint) {
      return ["UNCHANGED"];
    }
    if (!samePaths) {
      return ["MOVED"];
    }
    return ["PAYLOAD_CHANGED"];
  }
  if (baselinePresent && !candidatePresent) {
    return ["REMOVED"];
  }
  if (!baselinePresent && candidatePresent) {
    return ["NEW_UPSTREAM_CAPABILITY"];
  }
  return ["UNCHANGED"];
}

function patchFindingsBySurface(patchReport, surfacesById = {}) {
  const map = new Map();
  const surfaces = Object.values(surfacesById);
  for (const patch of patchReport?.patches ?? []) {
    if (SUCCESSFUL_PATCH_STATUSES.has(patch.status)) {
      continue;
    }
    const classification = BLOCKING_PATCH_STATUSES.has(patch.status) ? "PATCH_BROKEN" : "PATCH_REVIEW";
    const explicitSurfaceId = patch.surfaceId ?? patch.protectedSurfaceId ?? null;
    const matchedSurfaceIds = new Set();
    if (explicitSurfaceId != null) {
      matchedSurfaceIds.add(explicitSurfaceId);
    }
    const patchText = [patch.name, patch.reason, patch.featureId].filter(Boolean).join(" ");
    for (const surface of surfaces) {
      if (matchAny(surface.patchNamePatterns, patchText)) {
        matchedSurfaceIds.add(surface.id);
      }
    }
    if (matchedSurfaceIds.size === 0) {
      continue;
    }
    for (const surfaceId of matchedSurfaceIds) {
      const list = map.get(surfaceId) ?? [];
      list.push({
        classification,
        name: patch.name,
        reviewOnly: classification === "PATCH_REVIEW",
        status: patch.status,
        reason: patch.reason ?? null,
      });
      map.set(surfaceId, list);
    }
  }
  return map;
}

function postPatchIntegrityFindingsFromReport(patchReport) {
  const findings = patchReport?.postPatchIntegrity?.findings ?? patchReport?.postPatchIntegrity ?? [];
  return Array.isArray(findings) ? findings : [];
}

function mergedPostPatchIntegrityFindings(...findingGroups) {
  const merged = new Map();
  for (const finding of findingGroups.flat()) {
    if (finding == null || typeof finding !== "object") {
      continue;
    }
    const symbol = finding.symbol ?? "unknown-symbol";
    const pathKey = finding.path ?? "unknown-path";
    const reason = finding.reason ?? "Linux settings patch symbol is referenced without a local declaration";
    const key = `${symbol}\0${pathKey}\0${finding.snippet ?? ""}`;
    merged.set(key, {
      path: pathKey,
      reason,
      snippet: finding.snippet ?? null,
      symbol,
    });
  }
  return [...merged.values()].sort((a, b) => `${a.symbol}:${a.path}`.localeCompare(`${b.symbol}:${b.path}`));
}

function compareProtectedSurfaces({ baseline, candidate, patchReport = null } = {}) {
  const hasBaseline = baseline != null;
  const patchFindings = patchFindingsBySurface(patchReport, {
    ...(baseline?.surfacesById ?? {}),
    ...(candidate?.surfacesById ?? {}),
  });
  const surfaceIds = new Set([
    ...Object.keys(baseline?.surfacesById ?? {}),
    ...Object.keys(candidate?.surfacesById ?? {}),
  ]);
  const surfaceDrift = [];
  for (const surfaceId of [...surfaceIds].sort()) {
    const baselineSurface = baseline?.surfacesById?.[surfaceId];
    const candidateSurface = candidate?.surfacesById?.[surfaceId];
    const classifications = hasBaseline ? classifySurfaceDrift({ baselineSurface, candidateSurface }) : [];
    if (candidateSurface?.status === "PARTIAL") {
      classifications.push("PROTECTED_SURFACE_PARTIAL");
    } else if (candidateSurface?.status === "MISSING") {
      classifications.push("PROTECTED_SURFACE_MISSING");
    }
    const evidenceDrift = compareEvidence(baselineSurface?.evidence ?? [], candidateSurface?.evidence ?? []);
    for (const classification of classifications) {
      surfaceDrift.push({
        surfaceId,
        title: candidateSurface?.title ?? baselineSurface?.title ?? surfaceId,
        category: candidateSurface?.category ?? baselineSurface?.category ?? "unknown",
        classification,
        baselineStatus: baselineSurface?.status ?? "MISSING",
        candidateStatus: candidateSurface?.status ?? "MISSING",
        evidenceSummary: {
          baseline: summarizeEvidenceState(baselineSurface?.evidence ?? []),
          candidate: summarizeEvidenceState(candidateSurface?.evidence ?? []),
        },
        evidenceDrift: summarizeEvidenceDrift(evidenceDrift),
        missingAnchors: summarizeAnchors(candidateSurface?.missingAnchors ?? []),
      });
    }
    if ((candidateSurface?.status === "PRESENT") && candidateSurface.linuxSubstrate?.status === "MISSING") {
      surfaceDrift.push({
        surfaceId,
        title: candidateSurface.title,
        category: candidateSurface.category,
        classification: "LINUX_SUBSTRATE_GAP",
        missingPaths: candidateSurface.linuxSubstrate.missingPaths,
      });
    }
    if (patchFindings.has(surfaceId)) {
      const findingsByClassification = new Map();
      for (const finding of patchFindings.get(surfaceId)) {
        const list = findingsByClassification.get(finding.classification) ?? [];
        list.push(finding);
        findingsByClassification.set(finding.classification, list);
      }
      for (const [classification, patches] of findingsByClassification) {
        surfaceDrift.push({
          surfaceId,
          title: candidateSurface?.title ?? baselineSurface?.title ?? surfaceId,
          category: candidateSurface?.category ?? baselineSurface?.category ?? "unknown",
          classification,
          patches,
        });
      }
    }
  }
  const postPatchIntegrity = mergedPostPatchIntegrityFindings(
    candidate?.postPatchIntegrity ?? [],
    postPatchIntegrityFindingsFromReport(patchReport),
  );
  if (postPatchIntegrity.length > 0) {
    surfaceDrift.push({
      surfaceId: "linux_patch_integrity",
      title: "Linux post-patch JavaScript integrity",
      category: "patch-integrity",
      classification: "PATCH_INTEGRITY_BROKEN",
      findingCount: postPatchIntegrity.length,
      findings: postPatchIntegrity.slice(0, 20),
      omittedFindingCount: Math.max(0, postPatchIntegrity.length - 20),
    });
  }

  const classificationCounts = {};
  for (const item of surfaceDrift) {
    classificationCounts[item.classification] = (classificationCounts[item.classification] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    baselineSource: baseline?.source ?? null,
    candidateSource: candidate?.source ?? null,
    classificationCounts,
    surfaceDrift,
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => {
    if (entryValue == null) {
      return false;
    }
    if (Array.isArray(entryValue) && entryValue.length === 0) {
      return false;
    }
    return true;
  }));
}

function summarizeEvidenceEntry(entry, { includeNeedles = true } = {}) {
  return compactObject({
    path: entry.path,
    sha256: entry.sha256 ?? null,
    size: entry.size,
    source: entry.source,
    type: entry.type,
    contentNeedles: includeNeedles ? (entry.contentHits ?? []).map((hit) => hit.needle) : [],
    nativeNeedles: includeNeedles ? (entry.nativeHits ?? []).map((hit) => hit.needle) : [],
  });
}

function summarizeEvidenceList(evidence, maxItems = DRIFT_PATH_SAMPLE_LIMIT, options = {}) {
  return evidence.slice(0, maxItems).map((entry) => summarizeEvidenceEntry(entry, options));
}

function summarizeEvidenceState(evidence, maxItems = DRIFT_PATH_SAMPLE_LIMIT) {
  return {
    evidenceCount: evidence.length,
    pathSamples: summarizeEvidenceList(evidence, maxItems, { includeNeedles: false }),
    omittedPathCount: Math.max(0, evidence.length - maxItems),
  };
}

function summarizeChangedEvidence(entry) {
  return compactObject({
    path: entry.candidate.path === entry.baseline.path ? entry.candidate.path : undefined,
    baselinePath: entry.candidate.path === entry.baseline.path ? undefined : entry.baseline.path,
    candidatePath: entry.candidate.path === entry.baseline.path ? undefined : entry.candidate.path,
    baselineSha256: entry.baseline.sha256 ?? null,
    candidateSha256: entry.candidate.sha256 ?? null,
    baselineSize: entry.baseline.size,
    candidateSize: entry.candidate.size,
    source: entry.candidate.source ?? entry.baseline.source,
    type: entry.candidate.type ?? entry.baseline.type,
  });
}

function normalizedHashedAssetPath(entryPath) {
  const normalized = normalizePath(entryPath);
  const directory = path.posix.dirname(normalized);
  const basename = path.posix.basename(normalized);
  const match = basename.match(/^(.+)-[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9.]+)$/);
  if (match == null) {
    return null;
  }
  const normalizedBasename = `${match[1]}-<hash>${match[2]}`;
  return directory === "." ? normalizedBasename : `${directory}/${normalizedBasename}`;
}

function classifyPathMovement(evidenceDrift) {
  if (evidenceDrift.addedEvidence.length === 0 && evidenceDrift.removedEvidence.length === 0) {
    return "none";
  }
  const addedKeys = evidenceDrift.addedEvidence.map((entry) => normalizedHashedAssetPath(entry.path));
  const removedKeys = evidenceDrift.removedEvidence.map((entry) => normalizedHashedAssetPath(entry.path));
  const allMovedPathsAreHashedAssets =
    addedKeys.length > 0 &&
    removedKeys.length > 0 &&
    addedKeys.every(Boolean) &&
    removedKeys.every(Boolean);
  if (!allMovedPathsAreHashedAssets) {
    return "protected_path_changed";
  }
  const addedSet = keyedSet(addedKeys);
  const removedSet = keyedSet(removedKeys);
  const sameNormalizedAssets =
    addedSet.size === removedSet.size && [...addedSet].every((entryPath) => removedSet.has(entryPath));
  return sameNormalizedAssets ? "hashed_asset_churn" : "mixed_hashed_asset_churn";
}

function summarizeEvidenceDrift(evidenceDrift) {
  return {
    pathMovementKind: classifyPathMovement(evidenceDrift),
    addedPathSamples: summarizeEvidenceList(evidenceDrift.addedEvidence, DRIFT_PATH_SAMPLE_LIMIT, { includeNeedles: false }),
    removedPathSamples: summarizeEvidenceList(evidenceDrift.removedEvidence, DRIFT_PATH_SAMPLE_LIMIT, { includeNeedles: false }),
    changedPathSamples: evidenceDrift.changedEvidence.slice(0, DRIFT_CHANGED_SAMPLE_LIMIT).map(summarizeChangedEvidence),
    unchangedEvidenceCount: evidenceDrift.unchangedEvidence.length,
    addedEvidenceCount: evidenceDrift.addedEvidence.length,
    removedEvidenceCount: evidenceDrift.removedEvidence.length,
    changedEvidenceCount: evidenceDrift.changedEvidence.length,
    omittedAddedPathCount: Math.max(0, evidenceDrift.addedEvidence.length - DRIFT_PATH_SAMPLE_LIMIT),
    omittedRemovedPathCount: Math.max(0, evidenceDrift.removedEvidence.length - DRIFT_PATH_SAMPLE_LIMIT),
    omittedChangedPathCount: Math.max(0, evidenceDrift.changedEvidence.length - DRIFT_CHANGED_SAMPLE_LIMIT),
  };
}

function summarizeAnchors(anchors) {
  return anchors.map((anchor) => ({
    id: anchor.id,
    title: anchor.title,
    missingNeedles: anchor.missingNeedles ?? [],
    matchedPaths: (anchor.matchedPaths ?? []).slice(0, 20),
    matchedPathCount: (anchor.matchedPaths ?? []).length,
  }));
}

function keyedSet(values) {
  return new Set(values.filter(Boolean).sort());
}

function diffSets(baselineValues, candidateValues) {
  const baselineSet = keyedSet(baselineValues);
  const candidateSet = keyedSet(candidateValues);
  return {
    added: [...candidateSet].filter((value) => !baselineSet.has(value)),
    removed: [...baselineSet].filter((value) => !candidateSet.has(value)),
    unchanged: [...candidateSet].filter((value) => baselineSet.has(value)),
  };
}

function compareEvidence(baselineEvidence, candidateEvidence) {
  const baselineByPath = new Map(baselineEvidence.map((entry) => [entry.path, entry]));
  const candidateByPath = new Map(candidateEvidence.map((entry) => [entry.path, entry]));
  const addedEvidence = [];
  const removedEvidence = [];
  const changedEvidence = [];
  const unchangedEvidence = [];
  for (const [entryPath, candidateEntry] of candidateByPath) {
    const baselineEntry = baselineByPath.get(entryPath);
    if (baselineEntry == null) {
      addedEvidence.push(candidateEntry);
    } else if ((baselineEntry.sha256 ?? baselineEntry.size) !== (candidateEntry.sha256 ?? candidateEntry.size)) {
      changedEvidence.push({ baseline: baselineEntry, candidate: candidateEntry });
    } else {
      unchangedEvidence.push(candidateEntry);
    }
  }
  for (const [entryPath, baselineEntry] of baselineByPath) {
    if (!candidateByPath.has(entryPath)) {
      removedEvidence.push(baselineEntry);
    }
  }
  return { addedEvidence, removedEvidence, changedEvidence, unchangedEvidence };
}

function bridgeHandlerKeys(map) {
  return (map?.handlers ?? []).map((handler) => `${handler.kind}:${handler.name}:${handler.path}`);
}

function pluginIds(map) {
  return (map?.plugins ?? []).map((plugin) => plugin.id);
}

function pluginById(map) {
  return new Map((map?.plugins ?? []).map((plugin) => [plugin.id, plugin]));
}

function mcpToolKeys(pluginMap) {
  const keys = [];
  for (const plugin of pluginMap?.plugins ?? []) {
    for (const mcpManifest of plugin.mcpServers ?? []) {
      for (const server of mcpManifest.servers ?? []) {
        for (const tool of server.tools ?? []) {
          keys.push(`${plugin.id}:${server.name}:${tool}`);
        }
      }
    }
  }
  return keys;
}

function nativeBinaryByPath(map) {
  return new Map((map?.binaries ?? []).map((binary) => [binary.relativePath, binary]));
}

function compareMaps({ baselineProtected, candidateProtected }) {
  if (baselineProtected == null) {
    return {
      mode: "inventoryOnly",
      bridgeHandlerDrift: diffSets([], bridgeHandlerKeys(candidateProtected.bridgeMap)),
      pluginDrift: diffSets([], pluginIds(candidateProtected.pluginMap)),
      mcpDrift: diffSets([], mcpToolKeys(candidateProtected.pluginMap)),
      nativeBinaryDrift: diffSets([], (candidateProtected.nativeBinaryMap?.binaries ?? []).map((binary) => binary.relativePath)),
    };
  }

  const baselinePlugins = pluginById(baselineProtected.pluginMap);
  const candidatePlugins = pluginById(candidateProtected.pluginMap);
  const pluginFileDrift = {};
  for (const pluginId of new Set([...baselinePlugins.keys(), ...candidatePlugins.keys()])) {
    pluginFileDrift[pluginId] = diffSets(
      baselinePlugins.get(pluginId)?.files ?? [],
      candidatePlugins.get(pluginId)?.files ?? [],
    );
  }

  const baselineNative = nativeBinaryByPath(baselineProtected.nativeBinaryMap);
  const candidateNative = nativeBinaryByPath(candidateProtected.nativeBinaryMap);
  const changedNative = [];
  for (const [binaryPath, candidateBinary] of candidateNative) {
    const baselineBinary = baselineNative.get(binaryPath);
    if (baselineBinary != null && baselineBinary.sha256 !== candidateBinary.sha256) {
      changedNative.push({ path: binaryPath, baselineSha256: baselineBinary.sha256, candidateSha256: candidateBinary.sha256 });
    }
  }

  return {
    mode: "baselineComparison",
    bridgeHandlerDrift: diffSets(
      bridgeHandlerKeys(baselineProtected.bridgeMap),
      bridgeHandlerKeys(candidateProtected.bridgeMap),
    ),
    pluginDrift: diffSets(pluginIds(baselineProtected.pluginMap), pluginIds(candidateProtected.pluginMap)),
    pluginFileDrift,
    mcpDrift: diffSets(mcpToolKeys(baselineProtected.pluginMap), mcpToolKeys(candidateProtected.pluginMap)),
    nativeBinaryDrift: {
      ...diffSets([...baselineNative.keys()], [...candidateNative.keys()]),
      changed: changedNative,
    },
    linuxSubstrateDrift: diffSets(
      baselineProtected.surfaces.filter((surface) => surface.linuxSubstrate.status === "MISSING").map((surface) => surface.id),
      candidateProtected.surfaces.filter((surface) => surface.linuxSubstrate.status === "MISSING").map((surface) => surface.id),
    ),
  };
}

function countDiffValues(diff) {
  return {
    addedCount: diff?.added?.length ?? 0,
    removedCount: diff?.removed?.length ?? 0,
    unchangedCount: diff?.unchanged?.length ?? 0,
  };
}

function summarizeMapDrift(mapDrift) {
  const pluginFileChanged = Object.entries(mapDrift?.pluginFileDrift ?? {}).filter(([, drift]) =>
    (drift.added?.length ?? 0) > 0 || (drift.removed?.length ?? 0) > 0,
  );
  const summary = {
    mode: mapDrift?.mode ?? "unknown",
    bridgeHandlers: countDiffValues(mapDrift?.bridgeHandlerDrift),
    plugins: countDiffValues(mapDrift?.pluginDrift),
    mcpTools: countDiffValues(mapDrift?.mcpDrift),
    nativeBinaries: {
      ...countDiffValues(mapDrift?.nativeBinaryDrift),
      changedCount: mapDrift?.nativeBinaryDrift?.changed?.length ?? 0,
    },
    linuxSubstrate: countDiffValues(mapDrift?.linuxSubstrateDrift),
    pluginFileSetsChangedCount: pluginFileChanged.length,
  };
  summary.hasStructuralAddRemove =
    summary.bridgeHandlers.addedCount > 0 ||
    summary.bridgeHandlers.removedCount > 0 ||
    summary.plugins.addedCount > 0 ||
    summary.plugins.removedCount > 0 ||
    summary.mcpTools.addedCount > 0 ||
    summary.mcpTools.removedCount > 0 ||
    summary.nativeBinaries.addedCount > 0 ||
    summary.nativeBinaries.removedCount > 0 ||
    summary.linuxSubstrate.addedCount > 0 ||
    summary.linuxSubstrate.removedCount > 0;
  return summary;
}

function capabilityId(parts) {
  return sha256(Buffer.from(parts.filter(Boolean).join("\0"))).slice(0, 16);
}

function capabilityFromPlatformGate(gate) {
  if (!["new-upstream-capability", "platform-specific-unsupported"].includes(gate.category)) {
    return null;
  }
  return {
    id: `platform-gate:${gate.id}`,
    type: "platform-gate",
    name: gate.feature,
    path: gate.path,
    category: gate.category,
    confidence: gate.confidence,
    issueCandidate: gate.issueCandidate,
    recommendation: gate.recommendation,
    patchTarget: gate.patchTarget,
    evidence: gate.gate,
    platformLabel: gate.platformLabel,
    entitlement: gate.entitlement,
    rollout: gate.rollout,
    evidenceType: gate.evidenceType,
    confidenceRationale: gate.confidenceRationale ?? "Classifier default; manual review required.",
    linuxStatus: gate.linuxStatus,
    ownerPath: gate.ownerPath,
    recommendedAction: gate.recommendation,
  };
}

function nativeBinaryIsFeatureCandidate(binaryPath) {
  const normalized = normalizePath(binaryPath);
  return !(
    normalized.startsWith("Contents/Frameworks/") ||
    normalized.startsWith("Contents/MacOS/") ||
    normalized.startsWith("Contents/Resources/cua_node/") ||
    normalized.includes("/plugins/") ||
    normalized.includes("/node_modules/")
  );
}

function createNewCapabilityMap({ mapDrift, platformGateMap, candidatePluginMap } = {}) {
  const capabilities = [];
  const addCapability = (capability) => {
    if (capability == null) {
      return;
    }
    capabilities.push({
      confidence: "medium",
      issueCandidate: true,
      patchTarget: "scripts/dev/upstream-dmg-protected-surfaces.json",
      recommendation: "Create an issue, classify Linux support, and add a protected surface if this capability needs parity.",
      platformLabel: "unknown",
      entitlement: "unknown",
      rollout: "unknown",
      evidenceType: "bundle-drift",
      confidenceRationale: "Capability discovered from current-bundle structural drift.",
      linuxStatus: "unknown",
      ownerPath: "scripts/dev/upstream-dmg-protected-surfaces.json",
      recommendedAction: "Create an issue and classify Linux support.",
      bundlePresent: true,
      uiExposed: null,
      serverGateObserved: false,
      entitlementProven: false,
      ...capability,
    });
  };

  if (mapDrift?.mode === "baselineComparison") {
    for (const pluginId of mapDrift?.pluginDrift?.added ?? []) {
      addCapability({
        id: `plugin:${pluginId}`,
        type: "plugin",
        name: pluginId,
        category: "new-upstream-capability",
        evidence: pluginId,
      });
    }

    for (const key of mapDrift?.mcpDrift?.added ?? []) {
      const [pluginId, serverName, toolName] = key.split(":");
      addCapability({
        id: `mcp:${key}`,
        type: "mcp-tool",
        name: toolName ?? serverName ?? key,
        category: "new-upstream-capability",
        evidence: key,
        recommendation: `Review new MCP tool ${key}; add Linux backend coverage or an unsupported label.`,
        patchTarget: pluginId ? `plugins/openai-bundled/plugins/${pluginId} or matching linux-features owner` : "matching Linux MCP owner",
      });
    }

    for (const binaryPath of mapDrift?.nativeBinaryDrift?.added ?? []) {
      if (!nativeBinaryIsFeatureCandidate(binaryPath)) continue;
      addCapability({
        id: `native:${binaryPath}`,
        type: "native-binary",
        name: path.posix.basename(binaryPath),
        path: binaryPath,
        category: "new-upstream-capability",
        evidence: binaryPath,
        recommendation: "Review the new native binary for Linux replacement, staging, or explicit unsupported status.",
        patchTarget: "scripts/lib/bundled-plugins.sh or a dedicated linux-features/<id>/ owner",
      });
    }

    for (const key of mapDrift?.bridgeHandlerDrift?.added ?? []) {
      addCapability({
        id: `bridge:${capabilityId(["bridge", key])}`,
        type: "bridge-handler",
        name: key.split(":")[1] ?? key,
        category: "new-upstream-capability",
        evidence: key,
        recommendation: "Review the new Electron bridge handler and decide whether Linux needs a native mirror or patch.",
        patchTarget: "scripts/patches/core/all-linux or matching linux-features owner",
      });
    }
  }

  const sites = (candidatePluginMap?.plugins ?? []).find((plugin) => plugin.id === "sites");
  if (sites != null && (mapDrift?.pluginDrift?.added ?? []).includes("sites")) {
    const manifest = sites.manifests?.[0] ?? {};
    addCapability({
      id: "plugin:sites",
      type: "plugin",
      name: "Sites",
      version: manifest.version ?? "unknown",
      category: "cross-platform-entitlement-gated",
      platformLabel: "cross-platform",
      entitlement: "connector_20205bf7d4e99a89d7154bb849718324",
      entitlementLabel: "connector_20205bf7d4e99a89d7154bb849718324 (server entitlement not proven)",
      rollout: "unknown",
      evidenceType: "plugin-manifest-and-app-registration",
      confidence: "high",
      confidenceRationale: "Current bundle contains the Sites manifest and connector registration; server entitlement is not proven.",
      bundlePresent: true,
      uiExposed: Boolean(manifest.displayName),
      serverGateObserved: false,
      entitlementProven: false,
      linuxStatus: "staging-ownership-needed",
      patchTarget: "scripts/lib/bundled-plugins.sh",
      ownerPath: "scripts/lib/bundled-plugins.sh",
      recommendation: "Create a staging issue for Sites and keep entitlement unknown until server evidence is available.",
      recommendedAction: "Create a staging issue; do not infer entitlement from bundle presence.",
      evidence: sites.files,
    });
  }

  for (const gate of platformGateMap?.gates ?? []) {
    addCapability(capabilityFromPlatformGate(gate));
  }

  const deduped = new Map();
  for (const capability of capabilities) {
    deduped.set(capability.id, capability);
  }
  const items = [...deduped.values()].sort((a, b) => `${a.category}:${a.type}:${a.name}`.localeCompare(`${b.category}:${b.type}:${b.name}`));
  const categoryCounts = {};
  for (const item of items) {
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: mapDrift?.mode ?? "unknown",
    categoryCounts,
    issueCandidateCount: items.filter((item) => item.issueCandidate).length,
    capabilities: items,
  };
}

function markdownList(items) {
  if (items.length === 0) {
    return "- None\n";
  }
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

function markdownCell(value) {
  const normalized = value != null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  return normalized
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function markdownTable(headers, rows) {
  if (rows.length === 0) {
    return "None.\n";
  }
  const headerLine = `| ${headers.map(markdownCell).join(" | ")} |`;
  const dividerLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`);
  return `${[headerLine, dividerLine, ...rowLines].join("\n")}\n`;
}

function platformGateRows(gates, categories, limit = PLATFORM_GATE_MARKDOWN_LIMIT) {
  return (gates ?? [])
    .filter((gate) => categories.includes(gate.category))
    .slice(0, limit)
    .map((gate) => [
      gate.feature,
      gate.category,
      gate.path,
      gate.patchTarget,
      gate.recommendation,
    ]);
}

function capabilityRows(capabilities, limit = NEW_CAPABILITY_MARKDOWN_LIMIT) {
  return (capabilities ?? [])
    .slice(0, limit)
    .map((capability) => [
      capability.name,
      capability.version ?? "",
      capability.type,
      capability.category,
      `${capability.path ?? capability.evidence ?? ""}${capability.entitlementLabel ? `; ${capability.entitlementLabel}` : capability.entitlement ? `; entitlement=${capability.entitlement}` : ""}`,
      capability.patchTarget,
      capability.recommendation,
    ]);
}

function renderDriftMarkdown(report) {
  const lines = ["# Upstream DMG Drift Report", ""];
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Candidate: ${report.candidateSource?.path ?? "unknown"}`);
  if (report.baselineSource != null) {
    lines.push(`Baseline: ${report.baselineSource.path}`);
  }
  lines.push("");
  lines.push("## App and bundle versions");
  lines.push("");
  lines.push(markdownTable(
    ["Field", "Baseline", "Candidate", "Evidence"],
    Object.keys(report.versionDelta ?? {}).map((field) => [
      field,
      report.versionDelta[field]?.baseline ?? "unknown",
      report.versionDelta[field]?.candidate ?? "unknown",
      report.versionDelta[field]?.evidence ?? "unknown",
    ]),
  ).trimEnd());
  lines.push("");
  lines.push("## Feature staging and runtime health");
  lines.push("");
  lines.push(markdownTable(
    ["Feature", "Owner", "Staging", "Runtime status", "Action"],
    (report.featureStaging?.features ?? []).map((feature) => [
      feature.id,
      feature.targetOwnership,
      feature.stagingPresent ? "present" : "missing",
      feature.id === "mcp-helper-reaper" ? (report.runtimeHealth?.mcpHelperReaper?.status ?? "unknown") : "not-run",
      feature.id === "mcp-helper-reaper" ? "Supply a runtime snapshot before claiming health." : "Compare current-bundle staging against this owner.",
    ]),
  ).trimEnd());
  lines.push("");
  lines.push("## Linux Parity Drift");
  lines.push("");
  lines.push(markdownTable(
    ["Feature", "Category", "Path", "Patch target", "Recommendation"],
    platformGateRows(report.platformGates, ["linux-parity-drift"]),
  ).trimEnd());
  lines.push("");
  lines.push("## Required patch preflight");
  lines.push("");
  lines.push(markdownTable(
    ["Patch", "Status", "Severity", "Owner", "Recommendation"],
    (report.requiredPatchPreflight?.findings ?? []).map((finding) => [finding.name, finding.status, finding.severity, finding.ownerPath, finding.recommendation]),
  ).trimEnd());
  lines.push("");
  lines.push("## New Capability Candidates");
  lines.push("");
  lines.push(markdownTable(
    ["Name", "Version", "Type", "Category", "Evidence", "Owner", "Recommendation"],
    capabilityRows(report.newCapabilities),
  ).trimEnd());
  lines.push("");
  lines.push("## Platform-Specific Labels");
  lines.push("");
  lines.push(markdownTable(
    ["Feature", "Category", "Path", "Patch target", "Recommendation"],
    platformGateRows(report.platformGates, [
      "platform-specific-unsupported",
      "expected-platform-native",
      "needs-review",
      "already-linux-enabled",
    ]),
  ).trimEnd());
  lines.push("");
  lines.push("## Classification Counts");
  lines.push("");
  lines.push(
    markdownList(
      Object.entries(report.classificationCounts).map(([classification, count]) => `${classification}: ${count}`),
    ).trimEnd(),
  );
  lines.push("");
  lines.push("## Protected Surface Drift");
  lines.push("");
  for (const item of report.surfaceDrift) {
    lines.push(`### ${item.surfaceId} - ${item.classification}`);
    if (item.title) {
      lines.push(`Surface: ${item.title}`);
    }
    if (item.baselineStatus || item.candidateStatus) {
      lines.push(`Status: ${item.baselineStatus ?? "n/a"} -> ${item.candidateStatus ?? "n/a"}`);
    }
    if (item.evidenceDrift != null) {
      lines.push(
        `Evidence drift: +${item.evidenceDrift.addedEvidenceCount ?? 0} / -${item.evidenceDrift.removedEvidenceCount ?? 0} / changed ${item.evidenceDrift.changedEvidenceCount ?? 0} / unchanged ${item.evidenceDrift.unchangedEvidenceCount ?? 0}`,
      );
      if (item.evidenceDrift.pathMovementKind && item.evidenceDrift.pathMovementKind !== "none") {
        lines.push(`Path movement: ${item.evidenceDrift.pathMovementKind}`);
      }
    }
    const candidatePaths = [...new Set((item.evidenceSummary?.candidate?.pathSamples ?? []).map((entry) => entry.path))]
      .slice(0, MARKDOWN_PATH_SAMPLE_LIMIT);
    const baselinePaths = [...new Set((item.evidenceSummary?.baseline?.pathSamples ?? []).map((entry) => entry.path))]
      .slice(0, MARKDOWN_PATH_SAMPLE_LIMIT);
    if (baselinePaths.length > 0) {
      lines.push(`Baseline paths: ${baselinePaths.join(", ")}`);
    }
    if (candidatePaths.length > 0) {
      lines.push(`Candidate paths: ${candidatePaths.join(", ")}`);
    }
    if (item.missingPaths?.length > 0) {
      lines.push(`Missing Linux substrate paths: ${item.missingPaths.join(", ")}`);
    }
    if (item.missingAnchors?.length > 0) {
      lines.push(`Missing required anchors: ${item.missingAnchors.map((anchor) => anchor.id).join(", ")}`);
    }
    if (item.patches?.length > 0) {
      lines.push(`Patch failures: ${item.patches.map((patch) => `${patch.name} (${patch.status})`).join(", ")}`);
    }
    if (item.evidenceDrift?.changedPathSamples?.length > 0) {
      const changedPaths = item.evidenceDrift.changedPathSamples
        .slice(0, MARKDOWN_PATH_SAMPLE_LIMIT)
        .map((entry) => `${entry.path ?? `${entry.baselinePath} -> ${entry.candidatePath}`}: ${formatHash(entry.baselineSha256)} -> ${formatHash(entry.candidateSha256)}`);
      lines.push(`Changed payload samples: ${changedPaths.join("; ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function structuralSummaryLine(summary) {
  if (summary == null) {
    return null;
  }
  return [
    `bridge +/- ${summary.bridgeHandlers.addedCount}/${summary.bridgeHandlers.removedCount}`,
    `plugin +/- ${summary.plugins.addedCount}/${summary.plugins.removedCount}`,
    `MCP +/- ${summary.mcpTools.addedCount}/${summary.mcpTools.removedCount}`,
    `native +/- ${summary.nativeBinaries.addedCount}/${summary.nativeBinaries.removedCount}`,
    `native changed ${summary.nativeBinaries.changedCount}`,
  ].join("; ");
}

function formatHash(value) {
  if (value == null) {
    return "nohash";
  }
  return `${String(value).slice(0, 12)}...`;
}

function evidencePathList(entries, maxItems = ACTION_PLAN_PATH_SAMPLE_LIMIT) {
  return entries
    .slice(0, maxItems)
    .map((entry) => `${entry.path} (${formatHash(entry.sha256)})`)
    .join(", ");
}

function changedPayloadList(entries, maxItems = ACTION_PLAN_PATH_SAMPLE_LIMIT) {
  return entries
    .slice(0, maxItems)
    .map((entry) => `- ${entry.path ?? `${entry.baselinePath} -> ${entry.candidatePath}`}: ${formatHash(entry.baselineSha256)} -> ${formatHash(entry.candidateSha256)}`)
    .join("\n");
}

function renderActionPlanMarkdown(driftReport, candidateProtected, mapDrift = null) {
  const actionable = driftReport.surfaceDrift.filter((item) => ACTIONABLE_CLASSIFICATIONS.has(item.classification));
  const platformBlockers = (driftReport.platformGates ?? []).filter((gate) =>
    PLATFORM_GATE_BLOCKING_CATEGORIES.has(gate.category),
  );
  const capabilityCandidates = driftReport.newCapabilities ?? [];
  const structuralSummary = driftReport.structuralDriftSummary ?? summarizeMapDrift(mapDrift);
  const lines = ["# Linux Substrate Action Plan", ""];
  lines.push(`Candidate: ${candidateProtected.source?.path ?? "unknown"}`);
  const summaryLine = structuralSummaryLine(structuralSummary);
  if (summaryLine != null) {
    lines.push(`Structural maps: ${summaryLine}`);
  }
  lines.push("");
  if (actionable.length === 0 && platformBlockers.length === 0 && capabilityCandidates.length === 0) {
    lines.push("No protected-surface action required by this report.");
    return `${lines.join("\n")}\n`;
  }
  if (platformBlockers.length > 0) {
    lines.push("## Linux parity blockers");
    for (const gate of platformBlockers) {
      lines.push(`- ${gate.feature}: ${gate.recommendation}`);
      lines.push(`  Patch target: ${gate.patchTarget}`);
      lines.push(`  Evidence: ${gate.path} :: ${gate.gate}`);
    }
    lines.push("");
  }
  if (capabilityCandidates.length > 0) {
    lines.push("## New capability / issue candidates");
    for (const capability of capabilityCandidates.slice(0, NEW_CAPABILITY_MARKDOWN_LIMIT)) {
      lines.push(`- ${capability.name} (${capability.category}): ${capability.recommendation}`);
      lines.push(`  Owner: ${capability.patchTarget}`);
    }
    if (capabilityCandidates.length > NEW_CAPABILITY_MARKDOWN_LIMIT) {
      lines.push(`- ${capabilityCandidates.length - NEW_CAPABILITY_MARKDOWN_LIMIT} additional candidates omitted; see new-capabilities.json.`);
    }
    lines.push("");
  }
  for (const item of actionable) {
    lines.push(`## ${item.surfaceId}`);
    lines.push(`Classification: ${item.classification}`);
    if (item.evidenceDrift != null) {
      lines.push(
        `Evidence: +${item.evidenceDrift.addedEvidenceCount ?? 0} / -${item.evidenceDrift.removedEvidenceCount ?? 0} / changed ${item.evidenceDrift.changedEvidenceCount ?? 0}; movement ${item.evidenceDrift.pathMovementKind ?? "unknown"}`,
      );
    }
    if (item.classification === "MOVED") {
      const structuralHint =
        structuralSummary?.hasStructuralAddRemove === false
          ? " Structural bridge/plugin/MCP/native paths did not add or disappear."
          : "";
      lines.push(`Action: review candidate evidence paths before changing Linux substrate.${structuralHint} Treat this as a navigation signal unless a Linux patch, staging rule, or mirror references one of the old paths.`);
      if (item.evidenceDrift?.removedPathSamples?.length > 0) {
        lines.push(`Removed path samples: ${evidencePathList(item.evidenceDrift.removedPathSamples)}`);
      }
      if (item.evidenceDrift?.addedPathSamples?.length > 0) {
        lines.push(`Added path samples: ${evidencePathList(item.evidenceDrift.addedPathSamples)}`);
      }
    } else if (item.classification === "PAYLOAD_CHANGED") {
      lines.push("Action: review payload diffs, refresh protected needles, and run the owning Linux feature/backend tests.");
      if (item.evidenceDrift?.changedPathSamples?.length > 0) {
        lines.push("Changed payload files:");
        lines.push(changedPayloadList(item.evidenceDrift.changedPathSamples, 8));
      }
    } else if (item.classification === "REMOVED") {
      lines.push("Action: verify whether upstream intentionally removed this surface before deleting Linux compatibility code.");
    } else if (item.classification === "NEW_UPSTREAM_CAPABILITY") {
      lines.push("Action: decide whether Linux needs a port, shim, explicit unsupported gate, or new optional feature.");
    } else if (item.classification === "PATCH_BROKEN") {
      lines.push("Action: repair the patch descriptor or feature patch before accepting the DMG.");
    } else if (item.classification === "PATCH_REVIEW") {
      lines.push("Action: review optional patch warning/skip details; do not block DMG acceptance unless a protected surface is also missing or broken.");
    } else if (item.classification === "LINUX_SUBSTRATE_GAP") {
      lines.push("Action: add or map the missing Linux substrate path before claiming parity.");
      lines.push(`Missing paths: ${(item.missingPaths ?? []).join(", ")}`);
    } else if (item.classification === "PROTECTED_SURFACE_PARTIAL") {
      lines.push("Action: inspect the missing required anchors and decide whether the registry, upstream map, or Linux substrate needs updating.");
      lines.push(`Missing anchors: ${(item.missingAnchors ?? []).map((anchor) => anchor.id).join(", ")}`);
    } else if (item.classification === "PROTECTED_SURFACE_MISSING") {
      lines.push("Action: locate the upstream replacement surface or explicitly retire the Linux mirror before accepting the DMG.");
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function publicInventory(inventory) {
  return {
    ...inventory,
    files: inventory.files.map((file) => {
      const publicFile = { ...file };
      delete publicFile.absolutePath;
      delete publicFile.buffer;
      delete publicFile.text;
      delete publicFile.nativeStrings;
      return publicFile;
    }),
  };
}

function createFeatureStagingInventory(repoRoot) {
  const root = path.join(repoRoot, "linux-features");
  const features = [];
  if (!fs.existsSync(root)) return { generatedAt: new Date().toISOString(), features };
  for (const id of fs.readdirSync(root).sort()) {
    const featureRoot = path.join(root, id);
    if (!fs.statSync(featureRoot).isDirectory()) continue;
    const featureJson = path.join(featureRoot, "feature.json");
    let manifest = null;
    if (fs.existsSync(featureJson)) {
      try { manifest = readJson(featureJson); } catch { manifest = null; }
    }
    const files = fs.readdirSync(featureRoot).filter((name) => !name.startsWith("."));
    features.push({
      id,
      manifestPath: fs.existsSync(featureJson) ? `linux-features/${id}/feature.json` : null,
      entrypoints: manifest?.entrypoints ?? {},
      sourcePaths: files.map((name) => `linux-features/${id}/${name}`),
      targetOwnership: manifest?.targetOwnership ?? `linux-features/${id}`,
      stagingPresent: files.some((name) => /stage|patch|plugin|cleanup/i.test(name)),
    });
  }
  return { generatedAt: new Date().toISOString(), features };
}

function sameResolvedPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function resolveBaselinePath({ autoBaseline = false, baselinePath = null, candidatePath, repoRoot = process.cwd() } = {}) {
  if (baselinePath != null || !autoBaseline) {
    return baselinePath;
  }
  const defaultBaselinePath = path.join(repoRoot, "Codex.dmg");
  if (!fs.existsSync(defaultBaselinePath)) {
    return null;
  }
  if (candidatePath != null && sameResolvedPath(defaultBaselinePath, candidatePath)) {
    return null;
  }
  return defaultBaselinePath;
}

function mergeProvenance(detected = {}, supplied = null) {
  if (supplied == null) return detected;
  const merged = { ...detected, ...supplied };
  for (const key of ["candidate", "baseline"]) {
    const detectedEntry = detected?.[key] ?? null;
    const suppliedEntry = supplied?.[key] ?? null;
    merged[key] =
      detectedEntry == null
        ? suppliedEntry
        : suppliedEntry == null
          ? detectedEntry
          : { ...detectedEntry, ...suppliedEntry };
  }
  return merged;
}

function buildIntelReports({
  autoBaseline = false,
  baselinePath = null,
  candidatePath,
  outputDir,
  patchReportPath = null,
  registry,
  repoRoot = process.cwd(),
  timestamp = null,
  provenance = null,
  runPatchPreflight = false,
} = {}) {
  if (candidatePath == null) {
    throw new Error("candidatePath is required");
  }
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-intel-report-"));
  try {
    const resolvedBaselinePath = resolveBaselinePath({
      autoBaseline,
      baselinePath,
      candidatePath,
      repoRoot,
    });
    const reportDir =
      outputDir ??
      path.join(
        repoRoot,
        "reports/upstream-dmg",
        timestamp ?? new Date().toISOString().replace(/[:.]/g, "-"),
      );
    const candidateInventory = createInventory({
      registry,
      sourcePath: candidatePath,
      workDir: path.join(scratchRoot, "candidate"),
    });
    const candidateProtected = extractProtectedSurfaces({ inventory: candidateInventory, registry, repoRoot });
    const baselineInventory =
      resolvedBaselinePath == null
        ? null
        : createInventory({
            registry,
            sourcePath: resolvedBaselinePath,
            workDir: path.join(scratchRoot, "baseline"),
          });
    const baselineProtected =
      resolvedBaselinePath == null
        ? null
        : extractProtectedSurfaces({
            inventory: baselineInventory,
            registry,
            repoRoot,
          });
    const patchReport =
      patchReportPath != null && fs.existsSync(patchReportPath) ? readJson(patchReportPath) : null;
    const requiredPatchPreflight = runPatchPreflight
      ? runRequiredPatchPreflight({ inventory: candidateInventory, repoRoot, workDir: scratchRoot })
      : { status: "not-run", findings: [] };
    const effectivePatchReport = patchReport == null && requiredPatchPreflight.status === "not-run"
      ? null
      : {
          ...(patchReport ?? { patches: [] }),
          patches: [...(patchReport?.patches ?? []), ...requiredPatchPreflight.findings.map((finding) => ({
            name: finding.name,
            status: finding.severity === "none" ? "already-applied" : "failed-required",
            ciPolicy: "required-upstream",
            reason: finding.reason ?? finding.recommendation,
          }))],
          postPatchIntegrity: requiredPatchPreflight.computerUseInspection == null
            ? patchReport?.postPatchIntegrity
            : {
                ...(patchReport?.postPatchIntegrity ?? {}),
                findings: [
                  ...(patchReport?.postPatchIntegrity?.findings ?? []),
                  ...requiredPatchPreflight.computerUseInspection.findings,
                ],
              },
        };
    const driftReport = compareProtectedSurfaces({
      baseline: baselineProtected,
      candidate: candidateProtected,
      patchReport: effectivePatchReport,
    });
    const baselineVersions = baselineInventory?.versionMetadata ?? {};
    const candidateVersions = candidateInventory.versionMetadata ?? {};
    const versionDelta = {};
    const versionFields = [
      "cfBundleShortVersionString",
      "cfBundleVersion",
      "appPackageVersion",
      "electronVersion",
      "codexCliVersion",
    ];
    for (const field of versionFields) {
      versionDelta[field] = {
        baseline: baselineVersions[field] ?? null,
        candidate: candidateVersions[field] ?? null,
        changed: (baselineVersions[field] ?? null) !== (candidateVersions[field] ?? null),
        evidence: [...(baselineVersions.evidence ?? []), ...(candidateVersions.evidence ?? [])]
          .filter((entry) => entry.field === field).map((entry) => entry.path).join(", ") || null,
      };
    }
    versionDelta.bundledPluginVersions = {
      baseline: baselineVersions.bundledPluginVersions ?? {},
      candidate: candidateVersions.bundledPluginVersions ?? {},
      changed: JSON.stringify(baselineVersions.bundledPluginVersions ?? {}) !== JSON.stringify(candidateVersions.bundledPluginVersions ?? {}),
      evidence: "plugin manifests",
    };
    driftReport.versionDelta = versionDelta;
    const detectedProvenance = {
      candidate: candidatePath.endsWith(".dmg") && fs.statSync(candidatePath).isFile() ? {
        url: process.env.CODEX_UPSTREAM_DMG_URL ?? null,
        bytes: fs.statSync(candidatePath).size,
        sha256: sha256File(candidatePath),
        etag: process.env.CODEX_UPSTREAM_DMG_ETAG ?? null,
        lastModified: process.env.CODEX_UPSTREAM_DMG_LAST_MODIFIED ?? null,
      } : null,
      baseline: resolvedBaselinePath?.endsWith(".dmg") && fs.statSync(resolvedBaselinePath).isFile() ? {
        url: null,
        bytes: fs.statSync(resolvedBaselinePath).size,
        sha256: sha256File(resolvedBaselinePath),
        etag: null,
        lastModified: null,
      } : null,
    };
    driftReport.provenance = mergeProvenance(detectedProvenance, provenance);
    const featureStaging = createFeatureStagingInventory(repoRoot);
    driftReport.featureStaging = featureStaging;
    driftReport.runtimeHealth = {
      mcpHelperReaper: {
        status: "UNKNOWN",
        evidenceType: "static-source-only",
        message: "No runtime snapshot supplied; helper liveness, ownership, duplicate state, and cleanup were not run.",
        ownerPath: "linux-features/mcp-helper-reaper/reaper/src/lib.rs",
      },
    };
    driftReport.requiredPatchPreflight = requiredPatchPreflight;
    const mapDrift = compareMaps({ baselineProtected, candidateProtected });
    const platformGateMap = createPlatformGateMap({
      inventory: candidateInventory,
      patchFindings: requiredPatchPreflight.findings,
      requiredPatchPreflight,
    });
    const newCapabilityMap = createNewCapabilityMap({ mapDrift, platformGateMap, candidatePluginMap: candidateProtected.pluginMap });
    driftReport.structuralDriftSummary = summarizeMapDrift(mapDrift);
    driftReport.platformGateSummary = {
      categoryCounts: platformGateMap.categoryCounts,
      blockingCount: platformGateMap.blockingCount,
      reviewCount: platformGateMap.reviewCount,
    };
    driftReport.platformGates = platformGateMap.gates.slice(0, 50);
    driftReport.newCapabilitySummary = {
      categoryCounts: newCapabilityMap.categoryCounts,
      issueCandidateCount: newCapabilityMap.issueCandidateCount,
    };
    driftReport.newCapabilities = newCapabilityMap.capabilities.slice(0, 50);

    fs.mkdirSync(reportDir, { recursive: true });
    writeJson(path.join(reportDir, "inventory.json"), publicInventory(candidateInventory));
    writeJson(path.join(reportDir, "feature-staging.json"), featureStaging);
    writeJson(path.join(reportDir, "required-patch-preflight.json"), requiredPatchPreflight);
    writeJson(path.join(reportDir, "protected-surfaces.json"), candidateProtected);
    writeJson(path.join(reportDir, "bridge-map.json"), candidateProtected.bridgeMap);
    writeJson(path.join(reportDir, "plugin-map.json"), candidateProtected.pluginMap);
    writeJson(path.join(reportDir, "native-binary-map.json"), candidateProtected.nativeBinaryMap);
    writeJson(path.join(reportDir, "platform-gates.json"), platformGateMap);
    writeJson(path.join(reportDir, "new-capabilities.json"), newCapabilityMap);
    writeJson(path.join(reportDir, "map-drift.json"), mapDrift);
    writeJson(path.join(reportDir, "drift-report.json"), driftReport);
    fs.writeFileSync(path.join(reportDir, "drift-report.md"), renderDriftMarkdown(driftReport), "utf8");
    fs.writeFileSync(
      path.join(reportDir, "substrate-action-plan.md"),
      renderActionPlanMarkdown(driftReport, candidateProtected, mapDrift),
      "utf8",
    );

    if (baselineProtected != null) {
      writeJson(path.join(reportDir, "baseline/inventory.json"), publicInventory(baselineInventory));
      writeJson(path.join(reportDir, "baseline/protected-surfaces.json"), baselineProtected);
      writeJson(path.join(reportDir, "baseline/bridge-map.json"), baselineProtected.bridgeMap);
      writeJson(path.join(reportDir, "baseline/plugin-map.json"), baselineProtected.pluginMap);
      writeJson(path.join(reportDir, "baseline/native-binary-map.json"), baselineProtected.nativeBinaryMap);
      writeJson(path.join(reportDir, "candidate/inventory.json"), publicInventory(candidateInventory));
      writeJson(path.join(reportDir, "candidate/protected-surfaces.json"), candidateProtected);
      writeJson(path.join(reportDir, "candidate/bridge-map.json"), candidateProtected.bridgeMap);
      writeJson(path.join(reportDir, "candidate/plugin-map.json"), candidateProtected.pluginMap);
      writeJson(path.join(reportDir, "candidate/native-binary-map.json"), candidateProtected.nativeBinaryMap);
    }

    return {
      outputDir: reportDir,
      inventory: candidateInventory,
      protectedSurfaces: candidateProtected,
      driftReport,
      mapDrift,
      platformGateMap,
      newCapabilityMap,
    };
  } finally {
    fs.rmSync(scratchRoot, { force: true, recursive: true });
  }
}

module.exports = {
  buildIntelReports,
  compareProtectedSurfaces,
  createBridgeMap,
  createInventory,
  runRequiredPatchPreflight,
  extractVersionMetadata,
  createNewCapabilityMap,
  createNativeBinaryMap,
  createPlatformGateMap,
  createPluginMap,
  compareMaps,
  extractProtectedSurfaces,
  findPostPatchIntegrityFindings,
  mergeProvenance,
  prepareRequiredPatchPreflightApp,
  renderActionPlanMarkdown,
  renderDriftMarkdown,
  resolveBaselinePath,
};
