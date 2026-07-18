#!/usr/bin/env python3
"""Static, offline checks for release/deployment supply-chain invariants."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_RELEASE_PLATFORMS = frozenset(("linux/amd64", "linux/arm64"))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def yaml_scalar_values_at_path(text: str, path: tuple[str, ...]) -> list[Any]:
    """Return scalar values at one YAML mapping path without matching comments.

    The delivery validator intentionally has no third-party runtime dependencies.
    Kubernetes' pod security context is a plain nested mapping, so a small
    indentation-aware reader is sufficient and materially safer than accepting
    an unscoped marker that could live in a comment or container context.
    """

    stack: list[tuple[int, str]] = []
    values: list[Any] = []
    mapping_line = re.compile(
        r"([A-Za-z_][A-Za-z0-9_.-]*):(?:[ ]+(.*?))?[ ]*$",
    )
    for raw_line in text.splitlines():
        content = raw_line.lstrip(" ")
        if not content or content.startswith("#") or content.startswith("- "):
            continue
        indent = len(raw_line) - len(content)
        match = mapping_line.fullmatch(content)
        if match is None:
            continue
        while stack and stack[-1][0] >= indent:
            stack.pop()
        key, raw_value = match.groups()
        current_path = tuple(item[1] for item in stack) + (key,)
        if raw_value is None or raw_value.lstrip().startswith("#"):
            stack.append((indent, key))
            continue

        value = raw_value.split(" #", 1)[0].rstrip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            parsed: Any = value[1:-1]
        elif re.fullmatch(r"-?[0-9]+", value):
            parsed = int(value)
        elif value.lower() in ("true", "false"):
            parsed = value.lower() == "true"
        elif value.lower() in ("null", "~"):
            parsed = None
        else:
            parsed = value
        if current_path == path:
            values.append(parsed)
    return values


def validate_kubernetes_pod_security_context(deployment: str) -> None:
    pod_security_context = ("spec", "template", "spec", "securityContext")
    required = {
        "fsGroup": 10001,
        "fsGroupChangePolicy": "OnRootMismatch",
    }
    for field, expected in required.items():
        values = yaml_scalar_values_at_path(
            deployment,
            pod_security_context + (field,),
        )
        require(
            values == [expected],
            f"Kubernetes pod securityContext {field} must be exactly {expected!r}",
        )


def validate_compose_volume_migration_contract(compose: str) -> None:
    application_paths = (
        'application_paths="/var/lib/lucida/lucida.db '
        "/var/lib/lucida/lucida.db-wal /var/lib/lucida/lucida.db-shm "
        '/var/lib/lucida/generated-coarse /var/lib/lucida/proxy-cache"'
    )
    guard = 'test "$${path_device}" = "$${volume_device}" || {'
    root_chown = "chown 10001:10001 /var/lib/lucida"
    traversal = 'find "$${path}" -xdev -exec chown -h 10001:10001 {} +'
    for marker in (
        "lucida-volume-migrate:",
        'profiles: ["volume-migration"]',
        'user: "0:0"',
        "cap_add:",
        "- CHOWN",
        "- DAC_OVERRIDE",
        "network_mode: none",
        "backup-complete-and-lucida-stopped",
        application_paths,
        'volume_device="$$(stat -c \'%d\' /var/lib/lucida)"',
        'path_device="$$(stat -c \'%d\' "$${path}")"',
        'test -e "$${path}" || test -L "$${path}"',
        'test ! -L "$${path}"',
        guard,
        "refusing separately mounted application path",
        traversal,
        "stat -c '%u:%g' /var/lib/lucida",
    ):
        require(marker in compose, f"Compose volume-migration contract is missing {marker}")
    require(
        compose.count("for path in $${application_paths}; do") == 2,
        "Compose volume migration must validate and traverse the same application paths",
    )
    require(
        compose.index(guard) < compose.index(root_chown) < compose.index(traversal),
        "Compose mounted-child guard must run before any ownership traversal",
    )


def workflow_jobs(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"(?m)^  ([a-z][a-z0-9_-]*):\n", text))
    return {
        match.group(1): text[match.start() : matches[index + 1].start()]
        if index + 1 < len(matches)
        else text[match.start() :]
        for index, match in enumerate(matches)
    }


def matrix_platforms(job: str) -> list[str]:
    """Return explicit platform entries from a job's include matrix."""

    return re.findall(
        r"(?m)^ {10}- platform:\s*([a-z0-9]+/[a-z0-9]+)\s*$",
        job,
    )


def job_field_is(job: str, field: str, value: str) -> bool:
    """Match a top-level job field without accepting a comment or step field."""

    return (
        re.search(
            rf"(?m)^ {{4}}{re.escape(field)}:\s*{re.escape(value)}\s*$",
            job,
        )
        is not None
    )


def validate_action_pins() -> None:
    for workflow in sorted((ROOT / ".github/workflows").glob("*.yml")):
        text = workflow.read_text()
        require(
            re.search(r"(?m)^\s*(?:runs-on|runner):\s*\S*latest\s*$", text) is None,
            f"{workflow.relative_to(ROOT)}: runner image must not float on latest",
        )
        for line_number, line in enumerate(text.splitlines(), 1):
            match = re.search(r"\buses:\s+[^\s@]+@([^\s#]+)", line)
            if match:
                require(
                    re.fullmatch(r"[0-9a-f]{40}", match.group(1)) is not None,
                    f"{workflow.relative_to(ROOT)}:{line_number}: action is not SHA-pinned",
                )


def validate_toolchain_pins() -> None:
    toolchain = (ROOT / "rust-toolchain.toml").read_text()
    require(
        re.search(r'(?m)^channel\s*=\s*"1\.95\.0"\s*$', toolchain) is not None,
        "Rust toolchain must remain exact",
    )
    require((ROOT / ".node-version").read_text().strip() == "22.14.0", "Node pin drifted")

    pyproject = tomllib.loads((ROOT / "lucida-py/pyproject.toml").read_text())
    project = pyproject["project"]
    runtime_requirements = list(project.get("dependencies", []))
    for requirements in project.get("optional-dependencies", {}).values():
        runtime_requirements.extend(requirements)
    require(
        all(
            re.match(r"[A-Za-z0-9_.-]+", requirement).group(0).lower() != "maturin"
            for requirement in runtime_requirements
        ),
        "Maturin must remain build/dev-only, not a shipped Python dependency",
    )

    web_package = (ROOT / "lucida-web/package.json").read_text()
    web_manifest = json.loads(web_package)
    dockerfile = (ROOT / "Dockerfile").read_text()
    ci = (ROOT / ".github/workflows/ci.yml").read_text()
    for marker, sources in (
        ("1.95.0", (dockerfile, ci)),
        ("22.14.0", (dockerfile,)),
        ("pnpm@9.15.9", (web_package, dockerfile)),
        ("wasm-pack 0.15.0", ((ROOT / "scripts/verify.sh").read_text(),)),
    ):
        require(all(marker in source for source in sources), f"toolchain pin drifted: {marker}")
    require("version: 9.15.9" in ci, "CI pnpm pin drifted")
    require("node-version-file: .node-version" in ci, "CI must consume the Node pin")
    require(
        web_manifest.get("devDependencies", {}).get("playwright") == "1.61.0",
        "production-browser harness Playwright pin drifted",
    )
    require(
        web_manifest.get("devDependencies", {}).get("axe-core") == "4.12.1",
        "production-browser harness axe-core pin drifted",
    )
    require(
        web_manifest.get("devDependencies", {}).get("eslint-plugin-jsx-a11y")
        == "6.10.2",
        "JSX accessibility lint pin drifted",
    )
    eslint_config = (ROOT / "lucida-web/eslint.config.js").read_text()
    require(
        "jsxA11y.flatConfigs.recommended" in eslint_config,
        "web lint no longer enforces the recommended JSX accessibility rules",
    )
    require(
        "scripts/install-wasm-pack.sh" in ci and "scripts/install-wasm-pack.sh" in dockerfile,
        "CI and Docker must share the checksum-verified wasm-pack installer",
    )


def validate_release_order_text(text: str) -> None:
    jobs = workflow_jobs(text)
    for name in ("build", "candidate", "scan", "promote"):
        require(name in jobs, f"release workflow is missing {name!r} job")

    for name in ("build", "scan"):
        platforms = matrix_platforms(jobs[name])
        require(
            len(platforms) == len(REQUIRED_RELEASE_PLATFORMS)
            and set(platforms) == REQUIRED_RELEASE_PLATFORMS,
            f"{name} matrix must contain exactly linux/amd64 and linux/arm64",
        )

    scan = jobs["scan"]
    promote = jobs["promote"]
    require(job_field_is(scan, "needs", "candidate"), "scan must depend on candidate")
    require(
        job_field_is(promote, "needs", "[candidate, scan]"),
        "promotion must depend on every successful architecture scan",
    )
    require(
        "fail-fast: false" in scan,
        "scan matrix must report every architecture instead of cancelling siblings",
    )
    require(
        re.search(r"(?m)^\s+if:", scan) is None
        and "continue-on-error:" not in scan,
        "architecture scans must not be conditional or allowed to fail",
    )
    for marker in (
        "CANDIDATE_DIGEST: ${{ needs.candidate.outputs.digest }}",
        "EXPECTED_PLATFORM: ${{ matrix.platform }}",
        '"${IMAGE}@${CANDIDATE_DIGEST}" --raw',
        ".platform.os == $os and .platform.architecture == $architecture",
        'if [[ "$descriptor_count" != 1 ]]',
        "image-ref: ${{ needs.candidate.outputs.image }}@${{ steps.child.outputs.digest }}",
        "exit-code: '1'",
        "severity: CRITICAL",
    ):
        require(marker in scan, f"per-architecture scan is missing {marker}")
    require(
        scan.count("aquasecurity/trivy-action@") == 1,
        "scan matrix must run exactly one Trivy gate for each architecture",
    )
    require(
        re.search(r"(?m)^ {4}if:", promote) is None,
        "promotion must not override the successful-needs guard",
    )
    require(
        "needs.candidate.outputs.digest" in promote,
        "promotion must reuse the scanned candidate digest",
    )
    for marker in ("type=ref,event=tag", "type=raw,value=latest"):
        require(marker in promote, f"promotion is missing {marker}")
        require(
            all(marker not in body for name, body in jobs.items() if name != "promote"),
            f"{marker} appears before the promotion job",
        )


def validate_release_order() -> None:
    validate_release_order_text((ROOT / ".github/workflows/release.yml").read_text())


def validate_runtime_contracts() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text()
    from_lines = re.findall(r"(?m)^FROM\s+(\S+)", dockerfile)
    require(from_lines, "Dockerfile contains no stages")
    require(
        all("@sha256:" in image for image in from_lines),
        "every Docker base image must be digest-pinned",
    )
    require("USER 10001:10001" in dockerfile, "runtime image must be non-root")
    require(
        "ARG LUCIDA_BUILD_VERSION=0.2.0+source" in dockerfile
        and 'LUCIDA_BUILD_VERSION="${LUCIDA_BUILD_VERSION}"' in dockerfile,
        "Docker build does not compile in an explicit product identity",
    )

    ci = (ROOT / ".github/workflows/ci.yml").read_text()
    release = (ROOT / ".github/workflows/release.yml").read_text()
    require(
        "build-args: LUCIDA_BUILD_VERSION=ci-${{ github.sha }}" in ci
        and 'test "$version" = "ci-${{ github.sha }}"' in ci,
        "CI image smoke does not prove its injected /version identity",
    )
    require(
        "build-args: LUCIDA_BUILD_VERSION=${{ github.ref_name }}" in release,
        "release images do not compile in the immutable release tag",
    )
    health = (ROOT / "lucida-server/src/health.rs").read_text()
    server_main = (ROOT / "lucida-server/src/main.rs").read_text()
    require(
        "(StatusCode::OK, BUILD_VERSION)" in health
        and "version = health::BUILD_VERSION" in server_main,
        "HTTP and binary version surfaces do not share one build identity",
    )

    compose = (ROOT / "extras/deploy/docker-compose.yml").read_text()
    require(
        "<YOUR-TAG>@sha256:<YOUR-DIGEST>" in compose,
        "Compose image reference must require a readable tag and immutable digest",
    )
    require(
        'test: ["CMD", "lucida-server", "healthcheck"]' in compose,
        "Compose must use the native runtime healthcheck",
    )
    for marker in ('user: "10001:10001"', "read_only: true", "cap_drop:", "no-new-privileges:true"):
        require(marker in compose, f"Compose runtime contract is missing {marker}")
    validate_compose_volume_migration_contract(compose)
    require(
        "coreutils" in dockerfile and "findutils" in dockerfile,
        "runtime image does not guarantee the ownership helper commands",
    )
    deployment = (ROOT / "extras/deploy/k8s/deployment.yaml").read_text()
    require(
        "<YOUR-TAG>@sha256:<YOUR-DIGEST>" in deployment,
        "Kubernetes image reference must require a readable tag and immutable digest",
    )
    for marker in (
        "runAsNonRoot: true",
        "allowPrivilegeEscalation: false",
        "readOnlyRootFilesystem: true",
        "type: RuntimeDefault",
        "terminationGracePeriodSeconds: 35",
        "automountServiceAccountToken: false",
        "runAsUser: 10001",
        "runAsGroup: 10001",
        "drop:\n                - ALL",
    ):
        require(marker in deployment, f"Kubernetes runtime contract is missing {marker}")
    validate_kubernetes_pod_security_context(deployment)

    # The active derived-data cache shares its volume with authoritative
    # SQLite state. Keep the reference cap explicit and identical across both
    # deploy surfaces, and retain the retired root solely for upgrade cleanup.
    for manifest_name, manifest in (("Compose", compose), ("Kubernetes", deployment)):
        for marker in (
            "LUCIDA_GENERATED_COARSE_DISK_BUDGET_BYTES",
            '8589934592',
            "LUCIDA_PROXY_CACHE_DIR",
            "/var/lib/lucida/proxy-cache",
            "LUCIDA_SOURCE_HTTP_IPV6_TRANSLATION_CIDRS",
        ):
            require(marker in manifest, f"{manifest_name} cache/source contract is missing {marker}")
    pvc = (ROOT / "extras/deploy/k8s/pvc.yaml").read_text()
    require(
        "storage: 50Gi" in pvc and "8 GiB" in pvc and "42 GiB" in pvc,
        "reference PVC must document generated-cache headroom",
    )

    runbook = (ROOT / "extras/deploy/RUNBOOK.md").read_text()
    for marker in (
        "Mandatory migration checkpoint",
        "short-ID -> full-digest rewrite",
        "scale deploy/lucida --replicas=0",
        "verify a disposable",
        "LUCIDA_VOLUME_MIGRATION_ACK=backup-complete-and-lucida-stopped",
        "same device ID as `/var/lib/lucida`",
        "refuses a separate-device application child",
        "Never use binary-only `kubectl rollout undo`",
        "previous image **and** restoring the pre-upgrade database/volume",
    ):
        require(marker in runbook, f"upgrade/rollback runbook is missing {marker}")
    upgrade_runbook = runbook.split("## 10. Updating to a new release", 1)[1]
    require(
        upgrade_runbook.index("scale deploy/lucida --replicas=0")
        < upgrade_runbook.index("kubectl apply -f k8s/deployment.yaml"),
        "Kubernetes upgrade starts the new image before quiesce/backup ordering",
    )

    generated_cache = (ROOT / "lucida-server/src/generated_coarse/cache.rs").read_text()
    server_lib = (ROOT / "lucida-server/src/lib.rs").read_text()
    diagnostics = (ROOT / "lucida-protocol/src/diagnostics.rs").read_text()
    for marker in ("metadata.blocks()", "total_entries", "entry_budget"):
        require(marker in generated_cache, f"generated-cache resource ledger is missing {marker}")
    require(
        "DEFAULT_GENERATED_DISK_ENTRY_BUDGET: u64 = 100_000" in server_lib,
        "generated-cache root entry ceiling is missing or implicit",
    )
    require(
        "entry_count: u64" in diagnostics and "max_entries: Option<u64>" in diagnostics,
        "generated-cache inode telemetry is absent from the wire contract",
    )


def validate_package_boundary() -> None:
    require(not (ROOT / "package.json").exists(), "root JavaScript package is not canonical")
    require(not (ROOT / "pnpm-lock.yaml").exists(), "duplicate root lockfile remains")
    tracked_vite_files = subprocess.run(
        ["git", "ls-files", "lucida-web/.vite"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    require(
        not any((ROOT / path).is_file() for path in tracked_vite_files),
        "a generated Vite cache file remains tracked",
    )
    tracked_cargo_artifacts = subprocess.run(
        ["git", "ls-files", ".cargo-target"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    require(
        not any((ROOT / path).is_file() for path in tracked_cargo_artifacts),
        "a generated .cargo-target artifact remains in the worktree",
    )
    ignore = (ROOT / ".gitignore").read_text()
    require("**/.vite/" in ignore, "Vite cache is not ignored")
    require("/.cargo-target" in ignore, "stray Cargo target directories are not ignored")
    require(
        "/lucida-core/pkg" in ignore
        and "pkg\n" in (ROOT / "lucida-core/.gitignore").read_text(),
        "generated WASM package directory/symlink is not ignored",
    )
    dockerignore = (ROOT / ".dockerignore").read_text()
    require(".cargo-target/" in dockerignore, ".cargo-target can enter the Docker context")
    require("lucida-core/pkg\n" in dockerignore, "generated WASM package can enter the Docker context")
    readme = (ROOT / "README.md").read_text()
    require("pnpm install --force" not in readme, "canonical web install bypasses its lockfile")
    require("pnpm run dev -- --force" not in readme, "canonical web launch rebuilds generated cache")
    web_package = json.loads((ROOT / "lucida-web/package.json").read_text())
    require(
        web_package["dependencies"].get("lucida-core") == "link:../lucida-core/pkg",
        "web package must consume the generated WASM package through a live link",
    )
    vite_config = (ROOT / "lucida-web/vite.config.ts").read_text()
    require("exclude: ['lucida-core']" in vite_config, "Vite must not copy the linked WASM package into its optimization cache")
    dev_script = (ROOT / "scripts/dev.sh").read_text()
    require("--force" not in dev_script, "developer loop bypasses a generated cache or frozen dependency state")
    require("pnpm install --frozen-lockfile" in dev_script, "developer loop does not enforce the web lockfile")
    require("wasm-pack build --target web --out-dir pkg -- --locked" in dev_script, "developer loop does not enforce Cargo.lock for WASM")
    require("| sort -z" not in dev_script, "developer loop restored the error-masked NUL hash pipeline")
    require(
        "wasm-dev-fingerprint.sh source" in dev_script
        and "wasm-dev-fingerprint.sh artifacts" in dev_script
        and "source=%s\\nartifacts=%s" in dev_script,
        "developer loop does not verify both WASM inputs and generated artifacts",
    )
    require(
        "--replace" in dev_script
        and dev_script.index("cargo build -p lucida-server") < dev_script.index('die "builds are fresh'),
        "busy dev ports can prevent stale build artifacts from being repaired",
    )
    require(
        "LUCIDA_VITE_PROXY_TARGET" in vite_config,
        "Vite backend proxy target is not configurable for parallel dev instances",
    )
    web_lock = (ROOT / "lucida-web/pnpm-lock.yaml").read_text()
    require("file:../lucida-core/pkg" not in web_lock, "web lockfile retains the obsolete copied WASM package")


def validate_dependency_and_project_contracts() -> None:
    for path in ("SECURITY.md", "CONTRIBUTING.md", "COMPATIBILITY.md", "SUPPORT.md", "deny.toml"):
        require((ROOT / path).is_file(), f"project contract is missing {path}")

    ci = (ROOT / ".github/workflows/ci.yml").read_text()
    ci_jobs = workflow_jobs(ci)
    for marker in (
        "dependency-review-action@",
        "cargo-deny-action@",
        "pnpm audit --prod",
        "pip-audit --requirement",
        "kubernetes-version 1.36.2",
    ):
        require(marker in ci, f"continuous dependency policy is missing {marker}")
    require((ROOT / ".github/dependabot.yml").is_file(), "automated update policy is missing")

    require(
        "windows-local-open" in ci_jobs,
        "CI is missing the native Windows local-file compatibility gate",
    )
    windows_local = ci_jobs["windows-local-open"]
    for marker in (
        "runs-on: windows-2025",
        "cargo check --locked -p lucida-store --all-targets --all-features",
        "cargo test --locked -p lucida-store backend::tests",
        "tests/test_store.py::test_store_opens_and_reads_local_object",
    ):
        require(
            marker in windows_local,
            f"Windows local-file compatibility gate is missing {marker}",
        )

    deny = (ROOT / "deny.toml").read_text()
    require(
        re.search(r'(?m)^\s*"RUSTSEC-[0-9-]+"\s*,?$', deny) is None,
        "advisory waivers must be structured and explain their ownership",
    )
    waiver_ids = re.findall(r'id\s*=\s*"(RUSTSEC-[^"]+)"', deny)
    waiver_reasons = re.findall(
        r'\{\s*id\s*=\s*"RUSTSEC-[^"]+"\s*,\s*reason\s*=\s*"([^"]+)"\s*\}',
        deny,
    )
    require(
        len(waiver_ids) == len(waiver_reasons),
        "every advisory waiver must include one structured reason",
    )
    for reason in waiver_reasons:
        require("owner=" in reason, "advisory waiver is missing owner")
        require("expires=" in reason, "advisory waiver is missing expiry")
        require("remove when" in reason, "advisory waiver is missing removal criteria")


def validate_cross_stack_contract() -> None:
    """Keep the review's real-client/browser gate from regressing to unit smoke."""

    ci = (ROOT / ".github/workflows/ci.yml").read_text()
    jobs = workflow_jobs(ci)
    require("cross-stack" in jobs, "CI is missing the cross-stack acceptance job")
    cross_stack = jobs["cross-stack"]
    require(
        "needs: [rust, web, python]" in cross_stack,
        "cross-stack acceptance must consume all three proven stack artifacts",
    )
    for marker in (
        "create_browser_smoke_fixture.py",
        "drive \\",
        "--surface all",
        "LUCIDA_TRYOUT_REQUIRE_NON_U16",
        "LUCIDA_TRYOUT_MIN_CHANNELS",
        "LUCIDA_TRYOUT_EXPECT_CHANNEL",
        "LUCIDA_TRYOUT_EXPECT_CONTRAST_MIN",
        "LUCIDA_TRYOUT_EXPECT_CONTRAST_MAX",
        "LUCIDA_TRYOUT_REQUIRE_FIRST_RUN",
        "python3 -m unittest discover -s extras/tryout/tests",
        "--fixture /tmp/lucida-browser-smoke.ome.zarr",
        "cross-stack-evidence",
    ):
        require(marker in cross_stack, f"cross-stack acceptance is missing {marker}")
    require(
        (ROOT / "scripts/create_browser_smoke_fixture.py").is_file(),
        "cross-stack browser fixture generator is missing",
    )
    fixture_generator = (ROOT / "scripts/create_browser_smoke_fixture.py").read_text()
    for marker in (
        "COLLECTION_COLUMNS = tuple(str(index) for index in range(1, 13))",
        '"plate"',
        '"wells"',
    ):
        require(
            marker in fixture_generator,
            f"cross-stack fixture is missing mandatory wide-collection marker {marker}",
        )
    require(
        (ROOT / "extras/tryout/tests/test_browser_smoke_fixture.py").is_file()
        and (ROOT / "extras/tryout/tests/test_web_surface.py").is_file(),
        "cross-stack fixture/DPR contract tests are missing",
    )
    browser_harness = (
        ROOT / "extras/tryout/tryout/surfaces/web_surface.py"
    ).read_text()
    for marker in (
        "desktop-1280x720",
        "mobile-390x844",
        "zeroSizeRecovery(page, '2d')",
        "zeroSizeRecovery(page, '3d')",
        "initialZeroSizeRecovery(context, page, '2d')",
        "initialZeroSizeRecovery(context, page, '3d')",
        "window.__lucidaRenderContract",
        "waitForRuntimeSettled(page)",
        "waitForRenderedChannel(",
        "waitForFocusInside(",
        "waitForLocatorFocus(",
        "expected_focus_matched",
        "focus_failure_png",
        "keyboard.layers-dialog-initial-focus",
        "first-run.sharing-dialog-initial-focus",
        "first-run.sharing-dialog-focus-restored",
        "const failureReceipt = async (reason)",
        "stage = 'dataset-readiness'",
        "websocket-frame-sent",
        "websocket-frame-received",
        "long_task_duration_delta_ms",
        "interaction.posted_advanced",
        "exerciseOverlayContract(page, browser, deviceScaleFactor)",
        "exerciseErrorPlacement(page, deviceScaleFactor)",
        "exerciseKeyboardContract(page, focusFailurePng)",
        "exerciseIdleContract(page)",
        "window.axe.run",
        "exerciseFirstRun(",
        "exerciseDashboardContract(",
        "browser-page-scale-1.25",
        "Emulation.setPageScaleFactor",
        "window.visualViewport.scale",
        "namedSurfaceSpecs",
        "named_surface_collisions",
        "overlays-open-with-notice",
        "notice-active",
        "data-floating-safe-region",
        "exerciseThreadPopover(page)",
        "exerciseSavedViewActionsMenu(page)",
        "saved_view_actions",
        "clipped_anchor",
        "safe_control_collisions",
        "exerciseCollectionSelector(page, label)",
        "edge_cell_hit_testable",
        "edge_cell_focus_visible",
        "edge_cell_focus_ring_inset",
        "edge_cell_keyboard_returned",
        "edge_cell_click_received",
        "selector_minimap_overlap",
        'collection.get("present") is True',
        "trigger_panel_linked: linked",
        "exerciseDashboardFailures(",
        "exerciseWorkspaceOpenFailure(",
        "exerciseViewerApiFailures(",
        "exerciseTransportFailure(",
        "exerciseTerminalPath(",
        "asyncFailureContractFailures(",
        "terminalPathFailures(",
        "async_failures",
        "terminal_paths",
        "sharing_cancel",
        "duplicate_submit_blocked",
        "retry_send_frame_delta",
        "gpu-worker-crash",
        "gpu-device-loss",
        "decode-terminal",
        "worker_recreated",
        "failNextConstruction(",
        "construction_failure_surfaced",
        "presented_frame_count",
        "socket.close(4012",
        "retry_action",
        "intersects_visible_clip",
        "resetWorkspaceScroll(page)",
        "exerciseDialogFocusCycle(",
        "navigation_changed_channel_exactly",
        "rendered_channel_wait_matched",
        "canvas_pixels_changed",
        "seed_open_transport",
        "sharing_link_action",
        "sharing_initial_focus_visible",
        "cpu_task_duration_delta_ms",
        "collapsed_invalid_not_forwarded",
        "pageErrors.map",
        "_browser_acceptance_contract_failures(",
    ):
        require(
            marker in browser_harness,
            f"cross-stack browser acceptance is missing {marker}",
        )


def main() -> int:
    checks = (
        validate_action_pins,
        validate_toolchain_pins,
        validate_release_order,
        validate_runtime_contracts,
        validate_package_boundary,
        validate_dependency_and_project_contracts,
        validate_cross_stack_contract,
    )
    try:
        for check in checks:
            check()
    except AssertionError as error:
        print(f"delivery contract failed: {error}", file=sys.stderr)
        return 1
    print("delivery contracts: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
