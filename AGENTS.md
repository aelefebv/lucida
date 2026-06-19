Start with the repo wiki at `wiki/index.md` (or `wiki/CLAUDE.md` for navigation conventions). The wiki captures intent, invariants, and gotchas across the codebase.

Use Conventional Commit subjects for all commits and squash-merge PR titles because `release-please` reads commits on `main`.

When changing CLI behavior, try the commands yourself as a user and as a developer would: run the built binary/help, exercise config/status or the relevant workflow against a real local server when feasible, and verify both human and `--json` output paths. Do not rely only on unit tests for CLI UX.

To actually try lucida out end-to-end — yourself or as an agent — use the tryout harness at `extras/tryout/`. It spins lucida up from the **current working tree** (so it reflects your changes) and exercises every surface, saving logs and screenshots for verification: `python3 extras/tryout/tryout.py up` boots a throwaway server on a free port; `drive --surface cli|python|web|all` drives each surface and captures per-command output, a `LucidaClient` session, and a real viewer screenshot; `report` writes a single self-contained `report.html` (screenshots embedded) plus raw artifacts to a gitignored `.tmp/tryout/<ts>/`. See [`extras/tryout/README.md`](extras/tryout/README.md). Set `LUCIDA_TRYOUT_SERVER_BIN` / `LUCIDA_TRYOUT_CLI` / `LUCIDA_TRYOUT_WEB_DIST` to prebuilt artifacts to skip rebuilds.

When making product-surface changes, keep the use-case smoke matrix current at `wiki/outputs/2026-06-07-lucida-use-case-test-matrix.md`. Add new high-level use cases when the change introduces a new user workflow or persona need, and smoke test the affected rows through the natural surface (browser, CLI, Python, or admin CLI) when feasible. Record the result as Pass/Partial/Fail with concrete notes about what was actually exercised; do not mark broad use cases green based only on unit tests.

For the chunk pipeline deep-dive, see `CHUNK_PIPELINE.md`.
