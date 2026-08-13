"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("Cachix builds when official Linux package pins change", () => {
  const workflow = fs.readFileSync(".github/workflows/cachix.yml", "utf8");
  assert.match(workflow, /nix\/upstream-linux-packages\.json/);
  assert.match(workflow, /nix build/);
  assert.doesNotMatch(workflow, /codexDmg|nativeModulesSource/);
});
