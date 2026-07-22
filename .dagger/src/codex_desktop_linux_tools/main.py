import re
from typing import Annotated

import dagger
from dagger import dag, function, object_type
from dagger.mod import DefaultPath, Ignore

SOURCE_IGNORE = [
    ".git",
    ".codex",
    ".dagger/sdk",
    "Codex.dmg",
    "*.dmg",
    "*.dmg.metadata",
    "bin/codex-*",
    "codex-app",
    "codex-app-next",
    "codex-*-app",
    "dist",
    "dist-next",
    "node_modules",
    "reports",
    "target",
]
DEFAULT_DMG_URL = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg"
SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+"),
    re.compile(r"\b(sk-[A-Za-z0-9][A-Za-z0-9_-]{12,})\b"),
    re.compile(r"\b([A-Za-z0-9_]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b"),
]


@object_type
class CodexDesktopLinuxTools:
    """Containerized tools for codex-desktop-linux maintenance."""

    def _redact_secret_shapes(self, value: str) -> str:
        redacted = value
        for pattern in SECRET_PATTERNS:
            redacted = pattern.sub("[REDACTED]", redacted)
        return redacted

    def _devcontainer(self, source: dagger.Directory) -> dagger.Container:
        return (
            source.docker_build(dockerfile=".devcontainer/Dockerfile")
            .with_directory("/workspaces/codex-desktop-linux", source)
            .with_workdir("/workspaces/codex-desktop-linux")
            .with_env_variable("HOME", "/tmp/codex-dmg-intel-home")
            .with_env_variable("TMPDIR", "/tmp")
        )

    @function
    async def headroom_agent_review(
        self,
        prompt: str,
        source: Annotated[
            dagger.Directory,
            DefaultPath("."),
            Ignore(SOURCE_IGNORE),
        ],
        cwd: str = ".",
        context: str = "",
    ) -> str:
        """Ask a Dagger-native Headroom-routed agent to review this repository."""
        if not prompt.strip():
            raise ValueError("prompt is required")

        workspace_cwd = "/" if cwd in ("", ".") else f"/{cwd.strip('/')}"
        environment = (
            dag.env()
            .with_string_input("prompt", prompt, "the review assignment")
            .with_string_input(
                "cwd",
                workspace_cwd,
                "the repository subdirectory to treat as the working directory",
            )
            .with_string_input(
                "context",
                self._redact_secret_shapes(context),
                "caller-supplied context and constraints",
            )
            .with_directory_input(
                "workspace",
                source,
                "read-only repository workspace; inspect only files needed for the assignment",
            )
            .with_string_output(
                "report",
                "concise review report with findings first, then evidence and gaps",
            )
        )

        work = (
            dag.llm()
            .with_env(environment)
            .with_prompt(
                """
You are a Dagger-native code review agent called by Codex.

The $workspace directory is exposed at the agent filesystem root. Treat $cwd as
the intended working directory inside that workspace. Do not request or reveal
secrets. Do not invent evidence. Inspect only what is needed to answer $prompt.

Return findings first, ordered by severity, with exact file paths when relevant.
If no issue is found, say that clearly and list any residual verification gaps.

Caller context:
$context

Assignment:
$prompt
"""
            )
        )

        return await work.env().output("report").as_string()

    @function
    async def verify_dmg_intel(
        self,
        source: Annotated[
            dagger.Directory,
            DefaultPath("."),
            Ignore(SOURCE_IGNORE),
        ],
    ) -> str:
        """Run the DMG intelligence unit and syntax checks in the devcontainer."""
        return await (
            self._devcontainer(source)
            .with_exec(
                [
                    "bash",
                    "-lc",
                    "node --test scripts/dev/dagger-module.test.js scripts/dev/upstream-dmg-intel.test.js "
                    "&& node --check scripts/lib/upstream-dmg-intel.js "
                    "&& node --check scripts/dev/upstream-dmg-intel.js "
                    "&& jq empty scripts/dev/upstream-dmg-protected-surfaces.json",
                ]
            )
            .stdout()
        )

    @function
    def inspect_upstream_dmg(
        self,
        source: Annotated[
            dagger.Directory,
            DefaultPath("."),
            Ignore(SOURCE_IGNORE),
        ],
        candidate: dagger.File,
        baseline: dagger.File | None = None,
        patch_report: dagger.File | None = None,
    ) -> dagger.Directory:
        """Run upstream DMG intelligence and return the generated report directory."""
        container = self._devcontainer(source).with_file("/tmp/inputs/candidate.dmg", candidate)
        args = [
            "node",
            "scripts/dev/upstream-dmg-intel.js",
            "--candidate",
            "/tmp/inputs/candidate.dmg",
            "--output-dir",
            "/tmp/reports/upstream-dmg-intel",
        ]
        if baseline is not None:
            container = container.with_file("/tmp/inputs/baseline.dmg", baseline)
            args.extend(["--baseline", "/tmp/inputs/baseline.dmg"])

        if patch_report is not None:
            container = container.with_file("/tmp/inputs/patch-report.json", patch_report)
            args.extend(["--patch-report", "/tmp/inputs/patch-report.json"])

        return container.with_exec(args).directory("/tmp/reports/upstream-dmg-intel")

    @function
    async def inspect_upstream_dmg_url(
        self,
        source: Annotated[
            dagger.Directory,
            DefaultPath("."),
            Ignore(SOURCE_IGNORE),
        ],
        baseline: Annotated[
            dagger.File,
            DefaultPath("Codex.dmg"),
        ],
        candidate_url: str = DEFAULT_DMG_URL,
    ) -> str:
        """Download a DMG URL, compare it to repo Codex.dmg, and return a compact drift summary."""
        script = r"""
set -euo pipefail
mkdir -p /tmp/codex-dmg-intel-download /tmp/reports/upstream-dmg-intel
curl -fsSL --retry 3 --connect-timeout 30 --max-time 600 \
  -o /tmp/codex-dmg-intel-download/candidate.dmg "$CODEX_DMG_INTEL_CANDIDATE_URL"
node scripts/dev/upstream-dmg-intel.js \
  --candidate /tmp/codex-dmg-intel-download/candidate.dmg \
  --baseline /tmp/codex-dmg-intel-baseline.dmg \
  --output-dir /tmp/reports/upstream-dmg-intel \
  > /tmp/codex-dmg-intel-summary.json
node <<'NODE'
const fs = require("node:fs");
const reportDir = "/tmp/reports/upstream-dmg-intel";
const summary = JSON.parse(fs.readFileSync("/tmp/codex-dmg-intel-summary.json", "utf8"));
const protectedSurfaces = JSON.parse(fs.readFileSync(`${reportDir}/protected-surfaces.json`, "utf8"));
const driftReport = JSON.parse(fs.readFileSync(`${reportDir}/drift-report.json`, "utf8"));
const mapDrift = JSON.parse(fs.readFileSync(`${reportDir}/map-drift.json`, "utf8"));
const surfaces = protectedSurfaces.surfaces.map((surface) => ({
  id: surface.id,
  status: surface.status,
  confidence: surface.confidence,
  evidenceCount: surface.evidence.length,
  missingAnchors: (surface.missingAnchors ?? []).map((anchor) => anchor.id),
}));
const surfaceCounts = surfaces.reduce((counts, surface) => {
  counts[surface.status] = (counts[surface.status] ?? 0) + 1;
  return counts;
}, {});
const blockingClassifications = new Set([
  "REMOVED",
  "PATCH_BROKEN",
  "LINUX_SUBSTRATE_GAP",
  "PROTECTED_SURFACE_MISSING",
  "PROTECTED_SURFACE_PARTIAL",
]);
const changedSurfaces = driftReport.surfaceDrift
  .filter((entry) => entry.classification !== "UNCHANGED")
  .map((entry) => ({
    surfaceId: entry.surfaceId,
    classification: entry.classification,
    candidateStatus: entry.candidateStatus,
    missingAnchors: (entry.missingAnchors ?? []).map((anchor) => anchor.id),
  }));
const blockers = changedSurfaces.filter((entry) => blockingClassifications.has(entry.classification));
const reviewItems = changedSurfaces.filter((entry) => !blockingClassifications.has(entry.classification));
const allProtectedSurfacesPresent = surfaces.every((surface) => surface.status === "PRESENT");
process.stdout.write(JSON.stringify({
  decision: {
    acceptance: blockers.length === 0 ? "no-blockers" : "blocked",
    baselineComparison: mapDrift.mode === "baselineComparison",
    allProtectedSurfacesPresent,
    blockersCount: blockers.length,
    reviewItemsCount: reviewItems.length,
  },
  summary,
  surfaceCounts,
  classificationCounts: driftReport.classificationCounts,
  structuralDriftSummary: driftReport.structuralDriftSummary,
  mapMode: mapDrift.mode,
  surfaces,
  blockers,
  reviewItems: reviewItems.slice(0, 25),
}, null, 2) + "\n");
NODE
"""
        return await (
            self._devcontainer(source)
            .with_file("/tmp/codex-dmg-intel-baseline.dmg", baseline)
            .with_env_variable("CODEX_DMG_INTEL_CANDIDATE_URL", candidate_url)
            .with_exec(["bash", "-lc", script])
            .stdout()
        )
