"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  findMainBundle,
} = require("../../../../shared.js");

const PATCH_MARKER = "codexLinuxWorkspaceRootOpenTarget";

function warn(message) {
  console.warn(`WARN: ${message} - skipping Linux workspace-root open targets patch`);
}

function findMatching(source, openIndex, openChar, closeChar) {
  let depth = 0;
  const stack = [{ type: "code" }];

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const top = stack[stack.length - 1];

    if (top.type === "string") {
      if (top.escaped) {
        top.escaped = false;
      } else if (char === "\\") {
        top.escaped = true;
      } else if (char === top.quote) {
        stack.pop();
      }
      continue;
    }

    if (top.type === "template") {
      if (top.escaped) {
        top.escaped = false;
      } else if (char === "\\") {
        top.escaped = true;
      } else if (char === "`") {
        stack.pop();
      } else if (char === "$" && source[index + 1] === "{") {
        stack.push({ type: "templateExpression", depth: 1 });
        index += 1;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      stack.push({ type: "string", quote: char, escaped: false });
      continue;
    }
    if (char === "`") {
      stack.push({ type: "template", escaped: false });
      continue;
    }

    if (top.type === "templateExpression") {
      if (char === "{") {
        top.depth += 1;
      } else if (char === "}") {
        top.depth -= 1;
        if (top.depth === 0) {
          stack.pop();
        }
      }
      continue;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function enabledWorkspaceRootTargets(mainSource) {
  const targets = [];
  if (
    mainSource.includes("id:`vscode`") &&
    (
      mainSource.includes("linuxDetect:()=>codexLinuxOpenTargetExecutable(`code`)") ||
      mainSource.includes("codexLinuxIdePlatform(`vscode`") ||
      mainSource.includes("function codexLinuxIdeCommand(")
    )
  ) {
    targets.push({ id: "vscode", label: "VS Code" });
  }
  if (mainSource.includes("id:`zed`") && mainSource.includes("linux:{label:`Zed`")) {
    targets.push({ id: "zed", label: "Zed" });
  }
  if (mainSource.includes("id:`terminal`") && mainSource.includes("linux:{label:`Terminal`")) {
    targets.push({ id: "terminal", label: "Terminal" });
  }
  return targets;
}

function findItemAssignment(source, onSelectName, searchStart) {
  const pattern = /([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*)\.Item,\{/g;
  let match = null;
  const prefix = source.slice(0, searchStart);
  for (let next; (next = pattern.exec(prefix)) != null;) {
    match = next;
  }
  if (match == null) {
    return null;
  }

  const valueStart = source.indexOf("=", match.index) + 1;
  const firstParenStart = source.indexOf("(", valueStart);
  const firstParenEnd = findMatching(source, firstParenStart, "(", ")");
  const callParenStart = firstParenEnd + 1;
  if (source[callParenStart] !== "(") {
    return null;
  }
  const callParenEnd = findMatching(source, callParenStart, "(", ")");
  if (callParenEnd === -1) {
    return null;
  }

  const value = source.slice(valueStart, callParenEnd + 1);
  if (!value.includes(`onSelect:${onSelectName}`)) {
    return null;
  }

  return {
    start: match.index,
    end: callParenEnd + 1,
    itemVar: match[1],
    jsxVar: match[2],
    menuVar: match[3],
    value,
  };
}

function openTargetItem({ jsxVar, menuVar, openFn, pathVar, cwdVar, openFileVar, closeVar, target }) {
  return `(0,${jsxVar}.jsx)(${menuVar}.Item,{key:\`${PATCH_MARKER}:${target.id}\`,onSelect:()=>{${openFn}({path:${pathVar},cwd:${cwdVar},target:\`${target.id}\`,openFile:${openFileVar}.mutate}),${closeVar}(!1)},children:\`${target.label}\`})`;
}

function applyWorkspaceRootOpenTargetsPatch(currentSource, targets) {
  if (currentSource.includes(PATCH_MARKER)) {
    return currentSource;
  }
  if (targets.length === 0) {
    warn("Could not find Linux editor or terminal open targets in the main bundle");
    return currentSource;
  }

  const openCallPattern = /([A-Za-z_$][\w$]*)\(\{path:([A-Za-z_$][\w$]*),cwd:([A-Za-z_$][\w$]*),target:`fileManager`,openFile:([A-Za-z_$][\w$]*)\.mutate\}\)/u;
  const openCallMatch = currentSource.match(openCallPattern);
  if (openCallMatch == null) {
    warn("Could not find workspace-root File Manager open action");
    return currentSource;
  }

  const [openCall, openFn, pathVar, cwdVar, openFileVar] = openCallMatch;
  const callbackPattern = /([A-Za-z_$][\w$]*)=\(\)=>\{/g;
  let callbackMatch = null;
  const callbackSearchSource = currentSource.slice(0, openCallMatch.index);
  for (let next; (next = callbackPattern.exec(callbackSearchSource)) != null;) {
    callbackMatch = next;
  }
  if (callbackMatch == null) {
    warn("Could not identify workspace-root File Manager callback");
    return currentSource;
  }

  const [, onSelectName] = callbackMatch;
  const callbackBraceIndex = currentSource.indexOf("{", callbackMatch.index);
  const callbackEnd = findMatching(currentSource, callbackBraceIndex, "{", "}");
  if (callbackEnd === -1 || callbackEnd < openCallMatch.index) {
    warn("Could not parse workspace-root File Manager callback body");
    return currentSource;
  }

  const callbackBodyAfterOpen = currentSource.slice(openCallMatch.index + openCall.length, callbackEnd);
  const closeVar = callbackBodyAfterOpen.match(/,([A-Za-z_$][\w$]*)\(!1\)/u)?.[1] ?? null;
  if (closeVar == null) {
    warn("Could not identify workspace-root dropdown close callback");
    return currentSource;
  }

  const onSelectIndex = currentSource.indexOf(`onSelect:${onSelectName}`, callbackEnd);
  if (onSelectIndex === -1) {
    warn("Could not find workspace-root File Manager menu item");
    return currentSource;
  }

  const item = findItemAssignment(currentSource, onSelectName, onSelectIndex);
  if (item == null) {
    warn("Could not parse workspace-root File Manager menu item");
    return currentSource;
  }

  const targetItems = targets.map((target) =>
    openTargetItem({
      jsxVar: item.jsxVar,
      menuVar: item.menuVar,
      openFn,
      pathVar,
      cwdVar,
      openFileVar,
      closeVar,
      target,
    }),
  );
  const replacement =
    `${item.itemVar}=(0,${item.jsxVar}.jsxs)(${item.jsxVar}.Fragment,{children:[` +
    `${targetItems.join(",")},${item.value}]})`;

  return currentSource.slice(0, item.start) + replacement + currentSource.slice(item.end);
}

function patchWorkspaceRootOpenTargets(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    return { matched: 0, changed: 0 };
  }

  const main = findMainBundle(extractedDir);
  if (main == null) {
    return { matched: 0, changed: 0 };
  }

  const mainSource = fs.readFileSync(path.join(main.buildDir, main.mainBundle), "utf8");
  const targets = enabledWorkspaceRootTargets(mainSource);
  let matched = 0;
  let changed = 0;

  for (const name of fs.readdirSync(assetsDir)) {
    if (!/^app-main-.*\.js$/u.test(name)) {
      continue;
    }
    matched += 1;
    const filePath = path.join(assetsDir, name);
    const source = fs.readFileSync(filePath, "utf8");
    const patched = applyWorkspaceRootOpenTargetsPatch(source, targets);
    if (patched !== source) {
      fs.writeFileSync(filePath, patched, "utf8");
      changed += 1;
    }
  }

  if (matched === 0) {
    return { matched, changed };
  }
  return { matched, changed };
}

module.exports = {
  id: "linux-workspace-root-open-targets",
  phase: "extracted-app",
  order: 2060,
  ciPolicy: "optional",
  apply: patchWorkspaceRootOpenTargets,
  applyWorkspaceRootOpenTargetsPatch,
  enabledWorkspaceRootTargets,
};
