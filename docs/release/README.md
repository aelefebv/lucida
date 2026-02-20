# Step 10 Release Runbook

This runbook defines how Lucida Step 10 releases are built, verified, signed, and published.

## Release Policy

1. Valid tags:
   - stable: `vX.Y.Z`
   - prerelease: `vX.Y.Z-rc.N`
2. Tags must be on commits reachable from `main`.
3. Version sync is required before release:
   - `pyproject.toml` `project.version`
   - `rust/Cargo.toml` `workspace.package.version`
4. Channel routing:
   - stable -> PyPI
   - prerelease -> TestPyPI

## Required Artifact Outputs

1. Desktop:
   - `lucida-render-shell-v<version>-macos-x86_64.dmg`
   - `lucida-render-shell-v<version>-windows-x86_64.msi`
   - `lucida-render-shell-v<version>-linux-x86_64.AppImage`
2. Python:
   - `lucida-<python_version>-py3-none-any.whl`
   - `lucida-<python_version>.tar.gz`
3. Integrity:
   - `SHA256SUMS`
   - per-artifact SBOM files (`*.sbom.spdx.json`)
   - provenance attestations from CI

## Required Secrets

### Apple signing/notarization

1. `APPLE_SIGNING_CERT_P12_BASE64`
2. `APPLE_SIGNING_CERT_PASSWORD`
3. `APPLE_SIGNING_IDENTITY`
4. `APPLE_NOTARY_KEY_ID`
5. `APPLE_NOTARY_ISSUER_ID`
6. `APPLE_NOTARY_KEY_P8_BASE64`

### Windows signing

1. `WINDOWS_SIGNING_CERT_PFX_BASE64`
2. `WINDOWS_SIGNING_CERT_PASSWORD`
3. `WINDOWS_SIGNING_TIMESTAMP_URL`

### Linux AppImage signing

1. `APPIMAGE_GPG_PRIVATE_KEY_ASC`
2. `APPIMAGE_GPG_PASSPHRASE`

### Package publish credentials

1. `PYPI_API_TOKEN`
2. `TEST_PYPI_API_TOKEN`

## CI Workflows

1. Fast PR gates:
   - `.github/workflows/step10-release-gates.yml`
2. Strict tag releases:
   - `.github/workflows/step10-tag-release.yml`

## Local Verification Commands

```bash
python3 scripts/release/parse_tag_version.py --tag v0.1.0
python3 scripts/release/verify_version_sync.py --tag v0.1.0
python3 scripts/check_context.py
python3 -m unittest tests/release/test_step10_version_mapping.py -v
python3 -m unittest tests/release/test_step10_version_sync.py -v
python3 -m unittest tests/release/test_step10_workflow_contracts.py -v
```

## Packaging Smoke Commands (unsigned)

```bash
RELEASE_TAG=v0.1.0 DRY_RUN=1 UNSIGNED=1 bash scripts/release/build_linux_appimage.sh
RELEASE_TAG=v0.1.0 DRY_RUN=1 UNSIGNED=1 bash scripts/release/build_macos_dmg.sh
pwsh -File scripts/release/build_windows_msi.ps1 -ReleaseTag v0.1.0 -DryRun -Unsigned
```

## Failure Triage

1. Tag parsing fails:
   - Validate `vX.Y.Z` / `vX.Y.Z-rc.N` format.
2. Version sync fails:
   - Update `pyproject.toml` and `rust/Cargo.toml` versions to match tag mapping.
3. Signing errors:
   - Validate required secret exists and certificate/key material decodes correctly.
4. Notarization fails:
   - Verify Apple key/issuer/key-id values and app signing identity.
5. Publish fails:
   - Check channel routing (PyPI/TestPyPI) and token presence.
6. GitHub release upload fails:
   - Verify `GH_TOKEN` permissions include `contents: write`.

## Notes

1. Existing step workflows (`step3` to `step7`) remain active and unchanged.
2. Step 10 keeps payload scope to `lucida-render-shell` for desktop installers.
3. x86_64-only packaging is an explicit Step-10 boundary.
