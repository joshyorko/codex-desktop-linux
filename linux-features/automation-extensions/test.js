"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");

test("automation-extensions is disabled by default and owns both optional patches", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    ["multi-time-rrule", "eager-automation-update"],
  );
  assert.ok(descriptors.every(({ ciPolicy }) => ciPolicy === "optional"));
});
