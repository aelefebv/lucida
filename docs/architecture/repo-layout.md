# Repository Layout

## Top-Level Ownership

- `crates/lucida-daemon/`: Rust daemon implementation (HTTP server, rendering, dataset I/O, daemon tests).
- `src/lucida/`: Python client/CLI package and typed API contracts.
- `tests/python/`: Python test suite grouped by responsibility.
- `skills/`: canonical cross-agent skill packages and adapter metadata.
- `notebooks/`: runnable notebooks grouped by milestone and phase.
- `scripts/ci/`: CI/stabilization entrypoints.
- `scripts/release/`: release packaging scripts.
- `scripts/skills/`: skill validation, drift checks, bundling, and smoke checks.
- `docs/`: specifications and architecture documentation.
- `output/`: generated artifacts (snapshots/releases) only.

## Python Test Organization

- `tests/python/cli/`: CLI behavior and contract tests.
- `tests/python/client/`: client/runtime-config behavior tests.
- `tests/python/integration/`: direct HTTP integration coverage.
- `tests/python/parity/`: corpus-driven parity fixtures/harness.
- `tests/python/skills/`: skill contract and bundling checks.

## Conventions

- Keep client-side logic in Python (`src/lucida`).
- Keep server-side behavior in Rust (`crates/lucida-daemon`).
- Use REST/HTTP as the communication layer between Python and Rust.
- Keep reusable notebooks under `notebooks/`; keep generated runtime artifacts under `output/`.
