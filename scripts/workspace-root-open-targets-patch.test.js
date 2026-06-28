#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  apply: patchWorkspaceRootOpenTargets,
  applyWorkspaceRootOpenTargetsPatch,
  enabledWorkspaceRootTargets,
} = require("./patches/core/all-linux/extracted-app/workspace-root-open-targets/patch.js");

test("workspace root dropdown adds Linux open targets alongside File Manager", () => {
  const mainSource = [
    "function codexLinuxIdeCommand(){}",
    "var lM={id:`vscode`};",
    "var wN={id:`zed`,platforms:{linux:{label:`Zed`}}};",
    "var Hj={id:`terminal`,platforms:{linux:{label:`Terminal`}}};",
  ].join("");
  const source = [
    "function WorkspaceRootMenu(){",
    "let t=[],a=()=>{},v=`/tmp/project`,S=Zt(`open-file`),C;",
    "t[7]!==v||t[8]!==a||t[9]!==S?",
    "(C=()=>{if(v==null)return;let e=lr(v);El({path:v,cwd:e,target:`fileManager`,openFile:S.mutate}),a(!1)},t[7]=v,t[8]=a,t[9]=S,t[10]=C):C=t[10];",
    "let T;t[11]!==C?(T=(0,Z.jsx)(uv.Item,{LeftIcon:iy,onSelect:C,children:`File Manager`}),t[11]=C,t[12]=T):T=t[12];",
    "return (0,Z.jsxs)(Z.Fragment,{children:[T]})",
    "}",
  ].join("");

  const targets = enabledWorkspaceRootTargets(mainSource);
  const patched = applyWorkspaceRootOpenTargetsPatch(source, targets);

  assert.deepEqual(targets, [
    { id: "vscode", label: "VS Code" },
    { id: "zed", label: "Zed" },
    { id: "terminal", label: "Terminal" },
  ]);
  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:vscode/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:zed/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:terminal/);
  assert.match(patched, /target:`vscode`/);
  assert.match(patched, /target:`zed`/);
  assert.match(patched, /target:`terminal`/);
  assert.match(patched, /target:`fileManager`/);
  assert.equal(applyWorkspaceRootOpenTargetsPatch(patched, targets), patched);
});

test("workspace root dropdown follows aliased File Manager callbacks", () => {
  const targets = [
    { id: "vscode", label: "VS Code" },
    { id: "zed", label: "Zed" },
    { id: "terminal", label: "Terminal" },
  ];
  const source = [
    "function CurrentWorkspaceMenu(){",
    "let _=`/tmp/project`,a=()=>{},x=A(`open-file`),C,w,E;",
    "C=()=>{if(_==null)return;let e=S(_);Ta({path:_,cwd:e,target:`fileManager`,openFile:x.mutate}),a(!1)};",
    "w=C;",
    "E=_==null?null:(0,$.jsx)(di.Item,{LeftIcon:em,onSelect:w,children:(0,$.jsx)(Gh,{platform:m})});",
    "return (0,$.jsxs)($.Fragment,{children:[E]})",
    "}",
  ].join("");

  const patched = applyWorkspaceRootOpenTargetsPatch(source, targets);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:vscode/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:zed/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:terminal/);
  assert.match(patched, /onSelect:\(\)=>\{Ta\(\{path:_,cwd:e,target:`vscode`,openFile:x\.mutate\}\),a\(!1\)\}/);
  assert.match(patched, /target:`fileManager`,openFile:x\.mutate/);
  assert.match(patched, /\(0,\$\.jsx\)\(di\.Item,\{LeftIcon:em,onSelect:w/);
  assert.equal(applyWorkspaceRootOpenTargetsPatch(patched, targets), patched);
});

test("workspace root open targets patch scans current shared app main project chunks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-root-open-targets-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      [
        "function codexLinuxIdeCommand(){}",
        "var lM={id:`vscode`};",
        "var wN={id:`zed`,platforms:{linux:{label:`Zed`}}};",
        "var Hj={id:`terminal`,platforms:{linux:{label:`Terminal`}}};",
      ].join(""),
    );
    fs.writeFileSync(path.join(assetsDir, "app-main-current.js"), "console.log(`shell`);");
    const sharedChunkName = "app-initial~app-main~remote-conversation-page~projects-index-page-current.js";
    fs.writeFileSync(
      path.join(assetsDir, sharedChunkName),
      [
        "function CurrentWorkspaceMenu(){",
        "let _=`/tmp/project`,a=()=>{},x=A(`open-file`),C,w,E;",
        "C=()=>{if(_==null)return;let e=S(_);Ta({path:_,cwd:e,target:`fileManager`,openFile:x.mutate}),a(!1)};",
        "w=C;",
        "E=_==null?null:(0,$.jsx)(di.Item,{LeftIcon:em,onSelect:w,children:(0,$.jsx)(Gh,{platform:m})});",
        "return (0,$.jsxs)($.Fragment,{children:[E]})",
        "}",
      ].join(""),
    );

    const result = patchWorkspaceRootOpenTargets(root);
    const patched = fs.readFileSync(path.join(assetsDir, sharedChunkName), "utf8");

    assert.equal(result.changed, 1);
    assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:vscode/);
    assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:zed/);
    assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:terminal/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
