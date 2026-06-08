Start with the repo wiki at `wiki/index.md` (or `wiki/CLAUDE.md` for navigation conventions). The wiki captures intent, invariants, and gotchas across the codebase.

Use Conventional Commit subjects for all commits and squash-merge PR titles because `release-please` reads commits on `main`.

When changing CLI behavior, try the commands yourself as a user and as a developer would: run the built binary/help, exercise config/status or the relevant workflow against a real local server when feasible, and verify both human and `--json` output paths. Do not rely only on unit tests for CLI UX.

When making product-surface changes, keep the use-case smoke matrix current at `wiki/outputs/2026-06-07-lucida-use-case-test-matrix.md`. Add new high-level use cases when the change introduces a new user workflow or persona need, and smoke test the affected rows through the natural surface (browser, CLI, Python, or admin CLI) when feasible. Record the result as Pass/Partial/Fail with concrete notes about what was actually exercised; do not mark broad use cases green based only on unit tests.

For the chunk pipeline deep-dive, see `CHUNK_PIPELINE.md`.
