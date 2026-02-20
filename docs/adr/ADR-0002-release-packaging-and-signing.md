# ADR-0002: Step 10 Release Packaging and Signing Contracts

- Status: accepted
- Date: 2026-02-20

## Context

Lucida needs reproducible, policy-enforced, cross-platform distribution in CI.

Before Step 10, the repo had runtime and protocol validation workflows but no unified, signed release pipeline for desktop installers and Python package publication.

## Decision

Adopt a Step-10 release model with these hard contracts:

1. Release source of truth is semver Git tag (`vX.Y.Z` or `vX.Y.Z-rc.N`).
2. Release tags must point to commits reachable from `main`.
3. Version synchronization is enforced between:
   - `pyproject.toml` `project.version` (Python-mapped version)
   - `rust/Cargo.toml` `workspace.package.version` (semver)
4. Signed installer outputs are required for tag releases:
   - macOS DMG (signed + notarized)
   - Windows MSI (Authenticode signed)
   - Linux AppImage (GPG signed)
5. Python publish routing is tag-driven:
   - stable tags -> PyPI
   - prerelease tags -> TestPyPI
6. CI is split into:
   - fast PR release gates
   - strict tag release gates with signing and publishing
7. Supply-chain outputs are mandatory:
   - checksums
   - per-artifact SBOMs
   - provenance attestations

## Consequences

Positive:

1. Release behavior is explicit, testable, and automated.
2. Protocol/runtime quality remains gated before artifact publication.
3. Consumers get signed artifacts with integrity metadata.

Tradeoffs:

1. Signing and publish credentials become required operational dependencies.
2. CI complexity and runtime increase for tag releases.
3. Step 10 limits architecture targets to x86_64 to keep first release pipeline scope constrained.

## Alternatives Considered

1. Unsigned release-candidate pipeline first:
   - rejected due to weak production readiness.
2. Consolidate all existing step workflows into one large pipeline:
   - rejected for Step 10 to avoid destabilizing existing validated workflows.
3. Delay SBOM/provenance to later step:
   - rejected due to release-integrity requirements in Step 10 contract.
