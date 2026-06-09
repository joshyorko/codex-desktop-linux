#!/bin/bash
# Driver for the Linux ASAR patcher (scripts/patch-linux-window-ui.js).
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

print_patch_report_summary() {
    local patch_report="$1"
    [ -f "$patch_report" ] || return 0

    node - "$patch_report" "$SCRIPT_DIR/scripts/lib/patch-report.js" <<'NODE'
const fs = require("node:fs");
const reportPath = process.argv[2];
const helperPath = process.argv[3];
const { summarizePatchReport } = require(helperPath);

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const summary = summarizePatchReport(report);
const fmt = (counts) => Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "none";

console.error("[INFO] inspect-upstream summary:");
console.error(`  required core: ${fmt(summary.groups.requiredCore.statusCounts)}`);
console.error(`  optional core: ${fmt(summary.groups.optionalCore.statusCounts)}`);

if (summary.enabledFeatures.length === 0) {
  console.error("  optional features: none enabled");
} else {
  console.error(`  enabled features: ${summary.enabledFeatures.join(", ")}`);
  const featureEntries = Object.entries(summary.groups.optionalFeatures.byFeature);
  if (featureEntries.length === 0) {
    console.error("  optional feature drift: none");
  } else {
    for (const [featureId, featureSummary] of featureEntries) {
      console.error(`  feature ${featureId}: ${fmt(featureSummary.statusCounts)}`);
    }
  }
}
NODE
}

# ---- Extract and patch app.asar ----
patch_asar() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"
    local -a patch_args=()

    [ -f "$resources_dir/app.asar" ] || error "app.asar not found in $resources_dir"

    info "Extracting app.asar..."
    cd "$WORK_DIR"
    npx --yes asar extract "$resources_dir/app.asar" app-extracted

    # Copy unpacked native modules if they exist
    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        cp -r "$resources_dir/app.asar.unpacked/"* app-extracted/ 2>/dev/null || true
    fi

    # Remove macOS-only modules
    rm -rf "$WORK_DIR/app-extracted/node_modules/sparkle-darwin" 2>/dev/null || true
    find "$WORK_DIR/app-extracted" -name "sparkle.node" -delete 2>/dev/null || true

    # Build native modules in clean environment and copy back
    build_native_modules "$WORK_DIR/app-extracted"

    info "Patching Linux window and shell behavior..."
    if [ -n "${CODEX_PATCH_REPORT_JSON:-}" ]; then
        mkdir -p "$(dirname "$CODEX_PATCH_REPORT_JSON")"
        patch_args+=(--report-json "$CODEX_PATCH_REPORT_JSON")
    fi
    node "$SCRIPT_DIR/scripts/patch-linux-window-ui.js" "${patch_args[@]}" "$WORK_DIR/app-extracted"

    # Repack
    info "Repacking app.asar..."
    cd "$WORK_DIR"
    (cd app-extracted && find . -type f | LC_ALL=C sort | sed 's#^\./##') > "$WORK_DIR/app.asar.ordering"
    npx asar pack app-extracted app.asar --ordering "$WORK_DIR/app.asar.ordering" --unpack "{*.node,*.so,*.dylib}" 2>/dev/null

    info "app.asar patched"
}

inspect_rebuild_candidate() {
    local app_dir="$1"
    local dmg_path="$2"
    local resources_dir="$app_dir/Contents/Resources"
    local inspect_dir="$WORK_DIR/inspect-app-extracted"
    local report_dir="${REPORT_DIR:-$(default_rebuild_report_dir)}"
    local patch_report
    local rebuild_report

    [ -f "$resources_dir/app.asar" ] || error "app.asar not found in $resources_dir"

    report_dir="$(prepare_rebuild_report_dir "$report_dir")"
    patch_report="$report_dir/patch-report.json"
    rebuild_report="$report_dir/rebuild-report.json"

    info "Inspecting app.asar without changing the active app..."
    cd "$WORK_DIR"
    npx --yes asar extract "$resources_dir/app.asar" "$inspect_dir"

    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        cp -r "$resources_dir/app.asar.unpacked/"* "$inspect_dir/" 2>/dev/null || true
    fi

    node "$SCRIPT_DIR/scripts/patch-linux-window-ui.js" --report-json "$patch_report" "$inspect_dir"
    write_rebuild_report_json "$rebuild_report" "$dmg_path" "$ELECTRON_VERSION" "$patch_report" ""

    info "Patch report: $patch_report"
    info "Rebuild report: $rebuild_report"
    print_patch_report_summary "$patch_report"
}
