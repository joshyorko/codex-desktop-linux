#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
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
