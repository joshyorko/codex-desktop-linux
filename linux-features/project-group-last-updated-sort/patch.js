"use strict";

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const currentGroupSorterPattern = new RegExp(
  String.raw`function (${identifier})\(\{groups:e,items:t,projectOrder:n\}\)\{let r=new Map\(t\.map\(e=>\[e\.task\.key,e\.recencyAt\]\)\);return (${identifier})\(e\.map\(\(e,t\)=>\(\{group:e,index:t,recencyAt:e\.threadKeys\.reduce\(\(e,t\)=>Math\.max\(e,r\.get\(t\)\?\?0\),e\.projectUpdatedAt\?\?0\)\}\)\)\.sort\(\(e,t\)=>t\.recencyAt-e\.recencyAt\|\|e\.index-t\.index\)\.map\(\(\{group:e\}\)=>e\),n\)\}`,
  "g",
);
const patchedGroupSorterPattern = new RegExp(
  String.raw`function (${identifier})\(\{groups:e,items:t,projectOrder:n,sortMode:codexLinuxProjectSortMode\}\)\{let r=new Map\(t\.map\(e=>\[e\.task\.key,e\.recencyAt\]\)\);return\(\(codexLinuxRecencySortedGroups\)=>codexLinuxProjectSortMode===\`updated_at\`\?codexLinuxRecencySortedGroups:(${identifier})\(codexLinuxRecencySortedGroups,n\)\)\(e\.map\(\(e,t\)=>\(\{group:e,index:t,recencyAt:e\.threadKeys\.reduce\(\(e,t\)=>Math\.max\(e,r\.get\(t\)\?\?0\),e\.projectUpdatedAt\?\?0\)\}\)\)\.sort\(\(e,t\)=>t\.recencyAt-e\.recencyAt\|\|e\.index-t\.index\)\.map\(\(\{group:e\}\)=>e\)\)\}`,
  "g",
);

function allMatches(source, pattern) {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentSorterCallPattern(sorterName) {
  return new RegExp(
    String.raw`${escapeRegExp(sorterName)}\(\{groups:(${identifier}),items:(${identifier}),projectOrder:(${identifier}\(${identifier},${identifier}\.PROJECT_ORDER\))\}\)`,
    "g",
  );
}

function patchedSorterCallPattern(sorterName) {
  return new RegExp(
    String.raw`${escapeRegExp(sorterName)}\(\{groups:(${identifier}),items:(${identifier}),projectOrder:(${identifier}\(${identifier},${identifier}\.PROJECT_ORDER\)),sortMode:(${identifier})\}\)`,
    "g",
  );
}

function projectSortModeBefore(source, callIndex) {
  const prefix = source.slice(Math.max(0, callIndex - 300), callIndex);
  const matches = [...prefix.matchAll(new RegExp(String.raw`projectSortMode:(${identifier})`, "g"))];
  return matches.length === 1 ? matches[0][1] : null;
}

function patchedGroupSorter(sorterName, orderFunction) {
  return `function ${sorterName}({groups:e,items:t,projectOrder:n,sortMode:codexLinuxProjectSortMode}){let r=new Map(t.map(e=>[e.task.key,e.recencyAt]));return((codexLinuxRecencySortedGroups)=>codexLinuxProjectSortMode===\`updated_at\`?codexLinuxRecencySortedGroups:${orderFunction}(codexLinuxRecencySortedGroups,n))(e.map((e,t)=>({group:e,index:t,recencyAt:e.threadKeys.reduce((e,t)=>Math.max(e,r.get(t)??0),e.projectUpdatedAt??0)})).sort((e,t)=>t.recencyAt-e.recencyAt||e.index-t.index).map(({group:e})=>e))}`;
}

function applyProjectGroupLastUpdatedSortPatch(source) {
  const currentSorters = allMatches(source, currentGroupSorterPattern);
  const patchedSorters = allMatches(source, patchedGroupSorterPattern);

  if (patchedSorters.length === 1 && currentSorters.length === 0) {
    const [sorterName] = patchedSorters[0].slice(1);
    const patchedCalls = allMatches(source, patchedSorterCallPattern(sorterName));
    const currentCalls = allMatches(source, currentSorterCallPattern(sorterName));
    if (patchedCalls.length === 1 && currentCalls.length === 0) return source;
  }

  if (currentSorters.length !== 1 || patchedSorters.length !== 0) {
    console.warn(
      "WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch",
    );
    return source;
  }

  const [sorterName, orderFunction] = currentSorters[0].slice(1);
  const currentCalls = allMatches(source, currentSorterCallPattern(sorterName));
  const patchedCalls = allMatches(source, patchedSorterCallPattern(sorterName));
  if (currentCalls.length !== 1 || patchedCalls.length !== 0) {
    console.warn(
      "WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch",
    );
    return source;
  }

  const sortMode = projectSortModeBefore(source, currentCalls[0].index);
  if (sortMode == null) {
    console.warn(
      "WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch",
    );
    return source;
  }

  const call = currentCalls[0][0];
  const patchedCall = `${call.slice(0, -2)},sortMode:${sortMode}})`;
  return source
    .replace(currentSorters[0][0], patchedGroupSorter(sorterName, orderFunction))
    .replace(call, patchedCall);
}

const descriptors = [
  {
    id: "last-updated-project-groups",
    phase: "webview-asset",
    order: 20_900,
    ciPolicy: "optional",
    pattern: /^app-initial-[A-Za-z0-9_-]+\.js$/,
    missingDescription: "project group sort webview bundle",
    skipDescription: "project group Last updated sorting feature patch",
    apply: applyProjectGroupLastUpdatedSortPatch,
  },
];

module.exports = {
  applyProjectGroupLastUpdatedSortPatch,
  descriptors,
};
