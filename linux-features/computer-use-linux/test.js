"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");

test("computer-use-linux is opt-in and owns the seven Linux descriptors", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    [
      "avatar-cursor",
      "ui-feature",
      "plugin-gate",
      "native-desktop-apps",
      "ui-availability",
      "host-platform",
      "install-flow",
    ],
  );
});

test("computer-use-linux staging consumes release artifacts without invoking Cargo", () => {
  const stage = fs.readFileSync(path.join(__dirname, "stage.sh"), "utf8");
  assert.doesNotMatch(stage, /cargo\s+(?:build|install)/);
  assert.match(stage, /target\/release\/codex-computer-use-linux/);
});
