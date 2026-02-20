# Step 10 Sub-Spec: Installers and CI Release Gates

## Objective
Deliver production-grade signed release artifacts and enforceable CI release gates for Lucida desktop distribution and Python SDK publishing without changing runtime protocol contracts.

## What Lives in This Sub-Spec
1. Signed desktop installer build and release contracts for macOS, Windows, and Linux.
2. Python package build and publish policy for stable and prerelease channels.
3. CI release gates that validate version synchronization, protocol/runtime quality, packaging, and supply-chain metadata.
4. Operational release runbooks and release-signing architecture decisions.

## Scope
In scope:
1. Desktop artifact contracts for:
   - macOS: signed + notarized `DMG`
   - Windows: signed `MSI`
   - Linux: signed `AppImage`
2. Python package publishing for `lucida` wheel + sdist.
3. Tag-driven release policies:
   - stable tags (`vX.Y.Z`) publish to PyPI
   - prerelease tags (`vX.Y.Z-rc.N`) publish to TestPyPI
4. Version synchronization checks between release tag, `pyproject.toml`, and Rust workspace metadata.
5. Fast PR release-gate workflow and strict tag-release workflow.
6. Release integrity outputs:
   - `SHA256SUMS`
   - per-artifact SBOM files
   - provenance attestations for built artifacts
7. Step-10 release test coverage for mapping/version/workflow contracts.

Out of scope:
1. Runtime protocol method or schema changes.
2. Multi-arch release expansion beyond x86_64.
3. GUI feature expansion or payload changes beyond `lucida-render-shell` desktop artifact baseline.
4. App store automation or full auto-update framework.

## Protocol and Interface Policy
1. Step 10 is protocol-boundary neutral:
   - no OpenRPC method additions/removals
   - no JSON Schema request/response/event/error changes
   - no SDK API surface changes required
2. Build and release behavior become explicit operational contracts.

## Release Tag and Version Contracts
1. Allowed release tags:
   - `vX.Y.Z`
   - `vX.Y.Z-rc.N`
2. Tag semantics:
   - semver source of truth is Git tag (without leading `v`)
   - release tags must reference commits reachable from `main`
3. Python version mapping:
   - `X.Y.Z` -> `X.Y.Z`
   - `X.Y.Z-rc.N` -> `X.Y.ZrcN`
4. Version sync gate:
   - `pyproject.toml` `project.version` must equal mapped Python version
   - `rust/Cargo.toml` `workspace.package.version` must equal semver tag version

## Artifact Contracts
1. Desktop artifact naming:
   - `lucida-render-shell-v<version>-macos-x86_64.dmg`
   - `lucida-render-shell-v<version>-windows-x86_64.msi`
   - `lucida-render-shell-v<version>-linux-x86_64.AppImage`
2. Python artifact naming:
   - `lucida-<python_version>-py3-none-any.whl`
   - `lucida-<python_version>.tar.gz`
3. Integrity artifacts:
   - `SHA256SUMS`
   - `<artifact>.sbom.spdx.json`
   - provenance attestations created in release workflow

## Signing and Security Contracts
1. Signing is required for tagged release workflow (hard-fail on missing credentials or signing failure).
2. Required signing/notary environment variables:
   - `APPLE_SIGNING_CERT_P12_BASE64`
   - `APPLE_SIGNING_CERT_PASSWORD`
   - `APPLE_SIGNING_IDENTITY`
   - `APPLE_NOTARY_KEY_ID`
   - `APPLE_NOTARY_ISSUER_ID`
   - `APPLE_NOTARY_KEY_P8_BASE64`
   - `WINDOWS_SIGNING_CERT_PFX_BASE64`
   - `WINDOWS_SIGNING_CERT_PASSWORD`
   - `WINDOWS_SIGNING_TIMESTAMP_URL`
   - `APPIMAGE_GPG_PRIVATE_KEY_ASC`
   - `APPIMAGE_GPG_PASSPHRASE`
3. Release channel credentials:
   - stable publish path uses PyPI credentials
   - prerelease publish path uses TestPyPI credentials

## Runtime and Packaging Architecture
1. Desktop payload in Step 10 is `lucida-render-shell` (Rust scaffold executable) packaged per OS installer format.
2. Python package payload remains monolithic `lucida` distribution that includes:
   - `lucida_sdk`
   - `lucida_daemon`
   - `lucida_core`
3. Build backend policy:
   - use PEP 517 with hatchling
   - package sources from `python/` tree

## CI Workflow Model
1. Fast PR gate workflow (`step10-release-gates.yml`):
   - context checks and context tests
   - protocol/schema/generated-model freshness tests
   - release-specific Step-10 tests
   - Rust workspace check/tests
   - Python build smoke (wheel + sdist)
   - unsigned packaging smoke on Linux/macOS/Windows
2. Strict tag release workflow (`step10-tag-release.yml`):
   - preflight tag parse + branch ancestry + version sync validation
   - strict runtime/perf test suites
   - signed installer builds on Linux/macOS/Windows
   - Python package build
   - checksum/SBOM/provenance generation
   - publish to PyPI/TestPyPI and GitHub Releases

## Release Tooling Deliverables
1. `scripts/release/parse_tag_version.py`
2. `scripts/release/verify_version_sync.py`
3. `scripts/release/build_macos_dmg.sh`
4. `scripts/release/build_windows_msi.ps1`
5. `scripts/release/build_linux_appimage.sh`
6. `scripts/release/generate_checksums.sh`
7. `scripts/release/publish_pypi.sh`
8. `scripts/release/create_github_release.sh`

## Documentation and Decision Deliverables
1. Release runbook:
   - `docs/release/README.md`
2. Release packaging/signing ADR:
   - `docs/adr/ADR-0002-release-packaging-and-signing.md`

## Test and Acceptance Gates
1. Step-10 release tests verify:
   - tag parsing and Python version mapping contract
   - version synchronization policy
   - workflow contract invariants
2. Fast PR gates pass without requiring signing credentials.
3. Tagged release gates fail-fast before publish on:
   - invalid tag or non-main ancestry
   - metadata version mismatch
   - missing signing credentials
   - signing/notarization failures
4. Tagged release artifacts include installer + Python distributions + checksums + SBOM + provenance.
5. Protocol artifacts remain unchanged by Step 10 work.

## Dependencies
1. Steps 01-09 complete for protocol/runtime baseline.
2. Existing step workflows remain active and unchanged.
3. External release accounts and signing credentials are required before first production release run.

## Exit Criteria
Step 10 is complete when:
1. Signed installers (DMG/MSI/AppImage) and Python distributions can be produced from semver tags with enforced fail-fast gates.
2. Stable and prerelease channels route to PyPI/TestPyPI per tag policy.
3. Release integrity artifacts (checksums, SBOM, provenance) are generated and published with release outputs.
4. Context traceability/status are updated to `done` with concrete implementation and test paths.
