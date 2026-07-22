const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const moduleSource = fs.readFileSync(
  path.join(__dirname, "../../.dagger/src/codex_desktop_linux_tools/main.py"),
  "utf8",
);

test("Dagger agent review uses the directory input filesystem root", () => {
  assert.match(
    moduleSource,
    /workspace_cwd = "\/" if cwd in \("", "\."\) else f"\/\{cwd\.strip\('\/'\)\}"/,
  );
  assert.doesNotMatch(moduleSource, /workspace_cwd = "\/workspace"/);
  assert.match(moduleSource, /workspace directory is exposed at the agent filesystem root/);
});

test("Dagger verification includes its module binding regression", () => {
  assert.match(
    moduleSource,
    /node --test scripts\/dev\/dagger-module\.test\.js scripts\/dev\/upstream-dmg-intel\.test\.js/,
  );
});
