#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { buildIntelReports } = require("../lib/upstream-dmg-intel.js");

const repoRoot = path.resolve(__dirname, "../..");
const defaultRegistryPath = path.join(__dirname, "upstream-dmg-protected-surfaces.json");

function usage() {
  return `Usage: scripts/dev/upstream-dmg-intel.js --candidate PATH [options]

Build an upstream DMG intelligence report without mutating codex-app/.

Options:
  --candidate PATH       Candidate Codex.dmg, extracted .app, or extracted app resources directory
  --baseline PATH        Optional known-good baseline DMG or extracted .app
  --patch-report PATH    Optional patch-report.json to fold PATCH_BROKEN into drift-report.json
  --registry PATH        Protected surface registry (default: scripts/dev/upstream-dmg-protected-surfaces.json)
  --output-dir DIR       Exact output directory (default: reports/upstream-dmg/<timestamp>)
  --timestamp VALUE      Timestamp slug used when --output-dir is omitted
  -h, --help             Show this help
`;
}

function parseArgs(argv) {
  const args = {
    baselinePath: null,
    candidatePath: null,
    outputDir: null,
    patchReportPath: null,
    registryPath: defaultRegistryPath,
    timestamp: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate") {
      args.candidatePath = argv[++index];
    } else if (arg === "--baseline") {
      args.baselinePath = argv[++index];
    } else if (arg === "--patch-report") {
      args.patchReportPath = argv[++index];
    } else if (arg === "--registry") {
      args.registryPath = argv[++index];
    } else if (arg === "--output-dir") {
      args.outputDir = argv[++index];
    } else if (arg === "--timestamp") {
      args.timestamp = argv[++index];
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (!arg.startsWith("-") && args.candidatePath == null) {
      args.candidatePath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireReadable(label, filePath) {
  if (filePath == null) {
    throw new Error(`${label} is required`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  requireReadable("Candidate", args.candidatePath);
  requireReadable("Registry", args.registryPath);
  if (args.baselinePath != null) {
    requireReadable("Baseline", args.baselinePath);
  }
  if (args.patchReportPath != null) {
    requireReadable("Patch report", args.patchReportPath);
  }

  const registry = JSON.parse(fs.readFileSync(args.registryPath, "utf8"));
  const reports = buildIntelReports({
    baselinePath: args.baselinePath,
    candidatePath: args.candidatePath,
    outputDir: args.outputDir,
    patchReportPath: args.patchReportPath,
    registry,
    repoRoot,
    timestamp: args.timestamp,
  });

  const summary = {
    outputDir: reports.outputDir,
    inventory: path.join(reports.outputDir, "inventory.json"),
    protectedSurfaces: path.join(reports.outputDir, "protected-surfaces.json"),
    driftReport: path.join(reports.outputDir, "drift-report.json"),
    driftMarkdown: path.join(reports.outputDir, "drift-report.md"),
    substrateActionPlan: path.join(reports.outputDir, "substrate-action-plan.md"),
    classificationCounts: reports.driftReport.classificationCounts,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
