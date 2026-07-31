#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  applyChronicleSkysightMainBridgePatch,
  descriptors,
} = require("./patch.js");

const featureDir = __dirname;

test("chronicle-skysight is an independent disabled-by-default feature", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(featureDir, "feature.json"), "utf8"),
  );

  assert.equal(manifest.id, "chronicle-skysight");
  assert.equal(manifest.title, "Chronicle / Skysight Activity Memory");
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.requires ?? [], []);
  assert.equal(fs.existsSync(path.join(featureDir, "README.md")), true);
});

test("chronicle-skysight owns activity-memory bridge and tray integration", () => {
  const source = [
    'const cp=require("node:child_process"),fs=require("node:fs"),path=require("node:path");',
    "var tray={getChronicleSidecarControlState:()=>tt().skysight?$9:Se.appServerConnectionRegistry.getMaybeConnection(`local`)?.getChronicleSidecarControlState()??$9,toggleChronicleSidecar:async()=>{if(tt().skysight)return $9;let e=Se.appServerConnectionRegistry.getMaybeConnection(V);return e==null?$9:e.getChronicleSidecarControlState().running?e.pauseChronicleSidecar():e.resumeChronicleSidecar()}};",
    'var bridge={"get-global-state":async({key:e})=>null};',
  ].join("");

  const patched = applyChronicleSkysightMainBridgePatch(source);

  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, "linux-chronicle-skysight-main-bridge");
  assert.notEqual(patched, source);
  assert.equal(applyChronicleSkysightMainBridgePatch(patched), patched);
  assert.match(patched, /"chronicle-permissions":async/);
  assert.match(patched, /"linux-record-replay-skysight-start":async/);
  assert.match(patched, /codexLinuxChronicleToggleSidecar/);
  assert.doesNotMatch(patched, /"linux-record-replay-start":async/);
  assert.doesNotMatch(patched, /"linux-record-replay-draft-skill":async/);
});
