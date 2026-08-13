#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const THORIUM_BROWSER_FAMILY = "thorium";

// 26.803.41515 replaced the per-script Chrome-only Linux constants with a
// browser registry in extension-ids.json. Adding Thorium there covers manifest
// locations, the browser inventory, running-process detection, profile
// resolution, and window command selection in one entry, which is what the
// seven source patches this replaces did by hand.
const THORIUM_BROWSER_ENTRY = {
  browserFamily: THORIUM_BROWSER_FAMILY,
  displayName: "Thorium",
  shortDisplayName: "Thorium",
  extensionManagementUrl: "thorium://extensions",
  linux: {
    commands: ["thorium-browser-avx2", "thorium-browser", "thorium"],
    configHomeEnvironmentVariables: ["XDG_CONFIG_HOME"],
    nativeMessagingManifestDirectories: [".config/thorium/NativeMessagingHosts"],
    processNames: ["thorium", "thorium-browser", "thorium-browser-avx2"],
    userDataDirectorySegments: [".config", "thorium"],
  },
  macos: {
    applicationNames: ["Thorium.app"],
    bundleId: "org.chromium.Thorium",
    nativeMessagingManifestDirectories: [
      "Library/Application Support/Thorium/NativeMessagingHosts",
    ],
    processNames: ["Thorium", "Thorium Helper"],
    userDataDirectorySegments: ["Library", "Application Support", "Thorium"],
  },
  windows: {
    commandNames: ["thorium.exe", "thorium"],
    installPathSegments: ["Thorium", "Application", "thorium.exe"],
    processNames: ["thorium.exe"],
    userDataDirectorySegments: ["Thorium", "User Data"],
  },
};

function warn(message) {
  process.stderr.write(`WARN: ${message}\n`);
}

function detectIndent(source) {
  const match = source.match(/\n([ \t]+)"/u);
  return match == null ? 2 : match[1].length;
}

function readRegistry(registryPath) {
  let source;
  try {
    source = fs.readFileSync(registryPath, "utf8");
  } catch (error) {
    warn(
      `Could not read ${path.basename(registryPath)}: ${error.message}; leaving Thorium unregistered`,
    );
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    warn(
      `Could not parse ${path.basename(registryPath)}: ${error.message}; leaving Thorium unregistered`,
    );
    return null;
  }

  if (!Array.isArray(parsed?.browserDiagnostics)) {
    warn(
      `${path.basename(registryPath)} missing browserDiagnostics registry; leaving Thorium unregistered`,
    );
    return null;
  }

  return { source, parsed };
}

function thoriumEntryFor(registry) {
  const donor = registry.browserDiagnostics.find(
    (browser) => browser?.browserFamily === "chrome",
  );
  if (donor == null) {
    return null;
  }

  // Thorium is a Chromium fork and loads the same extension build, so it
  // inherits the Chrome extension identity rather than declaring its own.
  return {
    ...THORIUM_BROWSER_ENTRY,
    ...(donor.extensionIds == null ? {} : { extensionIds: [...donor.extensionIds] }),
    ...(donor.storeUrl == null ? {} : { storeUrl: donor.storeUrl }),
  };
}

function registerThorium(pluginDir) {
  const registryPath = path.join(pluginDir, "scripts", "extension-ids.json");
  const registry = readRegistry(registryPath);
  if (registry == null) {
    return false;
  }

  const { source, parsed } = registry;
  if (
    parsed.browserDiagnostics.some(
      (browser) => browser?.browserFamily === THORIUM_BROWSER_FAMILY,
    )
  ) {
    console.log("extension-ids.json already patched: Thorium browser registry");
    return true;
  }

  const entry = thoriumEntryFor(parsed);
  if (entry == null) {
    warn(
      "extension-ids.json missing the Chrome registry entry Thorium inherits from; leaving Thorium unregistered",
    );
    return false;
  }

  parsed.browserDiagnostics.push(entry);
  const trailingNewline = source.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(
    registryPath,
    `${JSON.stringify(parsed, null, detectIndent(source))}${trailingNewline}`,
    "utf8",
  );
  console.log("Patched extension-ids.json: Thorium browser registry");
  return true;
}

const pluginDir = process.argv[2];
if (!pluginDir) {
  throw new Error("Usage: patch-chrome-plugin.js /path/to/chrome/plugin");
}

registerThorium(pluginDir);
