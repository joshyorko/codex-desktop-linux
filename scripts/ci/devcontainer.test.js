"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const dockerfile = fs.readFileSync(
  path.join(__dirname, "..", "..", ".devcontainer", "Dockerfile"),
  "utf8",
);

test("devcontainer installs modern 7zz for current APFS DMGs", () => {
  assert.doesNotMatch(dockerfile, /\bp7zip-full\b/);
  assert.match(dockerfile, /ARG SEVENZIP_VERSION=2600/);
  assert.match(dockerfile, /7z\$\{SEVENZIP_VERSION\}-linux-\$\{sevenzip_arch\}\.tar\.xz/);
  assert.match(dockerfile, /install -m 0755 .*7zz.* \/usr\/local\/bin\/7zz/);
});
