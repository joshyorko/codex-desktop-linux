#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

const MARKERS = [
  "acquireVsCodeApi",
  "dispatchHostMessage",
  "dispatchMessage",
  "ipcRenderer",
  "electron",
  "vscode://codex",
  "get-global-state",
  "set-global-state",
  "computer_use",
  "Browser Use",
];

function usage() {
  console.error("Usage: web-mode-inventory.mjs --webview-dir <dir> --out <file>");
}

function parseArgs(argv) {
  const args = {
    webviewDir: null,
    out: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--webview-dir") {
      args.webviewDir = argv[++index] ?? null;
    } else if (arg === "--out") {
      args.out = argv[++index] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.webviewDir || !args.out) {
    usage();
    process.exit(64);
  }

  return args;
}

async function* walkFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile() && /\.(?:html?|mjs|cjs|js)$/i.test(entry.name)) {
      yield fullPath;
    }
  }
}

function countOccurrences(source, marker) {
  let count = 0;
  let index = 0;
  while (index < source.length) {
    const found = source.indexOf(marker, index);
    if (found === -1) {
      break;
    }
    count += 1;
    index = found + marker.length;
  }
  return count;
}

async function buildInventory(webviewDir) {
  const root = path.resolve(webviewDir);
  const hostApiMarkers = Object.fromEntries(MARKERS.map((marker) => [marker, 0]));
  const files = [];

  await fs.access(root);

  for await (const file of walkFiles(root)) {
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    const source = await fs.readFile(file, "utf8");
    const markerCounts = {};
    let totalMarkers = 0;

    for (const marker of MARKERS) {
      const count = countOccurrences(source, marker);
      if (count > 0) {
        markerCounts[marker] = count;
        hostApiMarkers[marker] += count;
        totalMarkers += count;
      }
    }

    files.push({
      path: relativePath,
      bytes: Buffer.byteLength(source),
      host_api_marker_count: totalMarkers,
      host_api_markers: markerCounts,
    });
  }

  return {
    schema_version: 1,
    generated_at: new Date(0).toISOString(),
    webview_dir: root,
    scanned_files: files.length,
    host_api_markers: hostApiMarkers,
    files,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inventory = await buildInventory(args.webviewDir);
  await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await fs.writeFile(args.out, `${JSON.stringify(inventory, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`web-mode inventory failed: ${error.message}`);
  process.exit(1);
});
