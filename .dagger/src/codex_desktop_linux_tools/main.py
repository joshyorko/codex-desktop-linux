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


@object_type
class CodexDesktopLinuxTools:
    """Containerized tools for codex-desktop-linux maintenance."""

    def _devcontainer(self, source: dagger.Directory) -> dagger.Container:
        return (
            source.docker_build(dockerfile=".devcontainer/Dockerfile")
            .with_directory("/workspaces/codex-desktop-linux", source)
            .with_workdir("/workspaces/codex-desktop-linux")
            .with_env_variable("HOME", "/tmp/codex-dmg-intel-home")
            .with_env_variable("TMPDIR", "/tmp")
        )

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
                    "node --test scripts/dev/upstream-dmg-intel.test.js "
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
        container = self._devcontainer(source).with_file("/inputs/candidate.dmg", candidate)
        args = [
            "node",
            "scripts/dev/upstream-dmg-intel.js",
            "--candidate",
            "/inputs/candidate.dmg",
            "--output-dir",
            "/reports/upstream-dmg-intel",
        ]
        if baseline is not None:
            container = container.with_file("/inputs/baseline.dmg", baseline)
            args.extend(["--baseline", "/inputs/baseline.dmg"])

        if patch_report is not None:
            container = container.with_file("/inputs/patch-report.json", patch_report)
            args.extend(["--patch-report", "/inputs/patch-report.json"])

        return container.with_exec(args).directory("/reports/upstream-dmg-intel")
