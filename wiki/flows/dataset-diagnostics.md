---
type: Flow
title: "Flow: Dataset Diagnostics"
description: "How to diagnose dataset open, restore, source-cache, and generated-coarse"
tags: [lucida, flow]
source_path: wiki/flows/dataset-diagnostics.md
created: 2026-06-10
modified: 2026-07-06
---

# Flow: Dataset Diagnostics

How to diagnose dataset open, restore, source-cache, and generated-coarse
behavior through the browser, CLI, Python, and server logs.

This flow is intentionally about the current server-mediated product path. It
does not describe legacy proxy fallback as a normal route, and it does not add a
direct Python/native-store product surface.

## Surfaces

Use the surface that matches the user:

- **Browser:** open the workspace, then use Debug > Health. The normal dataset
  loading line also reflects request-correlated open progress while an open is
  active.
- **CLI:** use `lucida dataset open <path-or-url> --json`, `lucida dataset
  health [dataset] --json`, and `lucida dataset retry <dataset> --json`.
- **Python:** use `workspace.datasets.open(path)`,
  `workspace.datasets.health(dataset)`, and `workspace.datasets.retry(dataset)`.
  Catch `LucidaError` and inspect `error.to_dict()` for structured failures.
- **Server logs:** search for the same stage and kind labels that appear in
  client diagnostics.

## Dataset Open

Dataset open reports progress in coarse server-authored stages:

1. `request_received`
2. `authorization`
3. `source_lookup`
4. `backend_open`
5. `metadata_import`
6. `binding_build`
7. `generated_coarse_planning`
8. `workspace_persist`
9. `broadcast`
10. `complete`

The successful CLI/Python result includes the final dataset summary and a
`progress` array. The browser receives the same `dataset_open_progress` messages
and updates the loading surface for the matching request.

If open fails, the structured diagnostic includes:

- `stage` — where the failure occurred.
- `kind` — stable failure category.
- `retryable` — whether retry might reasonably help.
- `message` and optional `detail` — concise operator-facing context.

CLI JSON errors include the diagnostic under `error.diagnostic`. Python exposes
the same data as `LucidaError.diagnostic` and `LucidaError.to_dict()`.

## Failure Categories

Common branches:

- `unsupported_scheme` — the source URL scheme is not supported by
  `lucida-store::backend::open`.
- `local_path`, `missing_object`, `missing_metadata` — the server cannot see the
  path/object/metadata. Check the server's `--data-dir`, Docker mount, or source
  path spelling.
- `permission`, `cloud_configuration`, `http`, `storage_backend` — storage
  backend, credential, or network problem. Check server env and remote storage
  access before changing dataset code.
- `unsupported_codec`, `unsupported_layout`, `malformed_metadata`, `import` —
  importer rejected the OME-Zarr metadata or chunk layout. Re-export the dataset
  when possible; otherwise keep the fixture and add importer coverage.
- `authorization`, `workspace_lookup`, `persistence`, `session_closed` — Lucida
  workspace/session problem rather than dataset content.

Do not branch scripts on human text. Branch on `error.kind` plus
`error.diagnostic.stage` and `error.diagnostic.kind`.

## Dataset Health

After open or restore, `dataset_health` is the shared truth for loaded workspace
datasets. It reports:

- dataset status: `healthy`, `degraded`, or `unavailable`
- `source_url` and backend kind
- binding status and restore/open failure notes
- source-cache counters: current bytes, budget, used percent, entries, hits,
  misses, evictions, and backend errors
- generated-coarse status: level count, ready/pending/failed/unavailable counts,
  cache storage/budget/root/evictions, and recent generated failures
- operator-facing messages when pressure, evictions, backend errors, or restore
  failures need attention

Health is observational. It does not replace the workspace document as the
source of dataset membership truth. A persisted dataset with a failed runtime
binding should remain visible as a workspace dataset and report unhealthy
binding health.

## Restore And Retry

On workspace restore, the server rebuilds runtime bindings from persisted
workspace dataset source metadata. If restore fails, health reports the persisted
dataset as unavailable with the recorded source URL, backend kind, and failure
diagnostic.

Use `dataset retry <dataset>` or `workspace.datasets.retry(dataset)` to rebuild
the binding from the persisted source without removing and re-adding the
dataset. Retry returns the normal dataset-open result and progress array.

## Fixture Smoke

Developer-run reliability smoke:

```bash
env LUCIDA_BIND=127.0.0.1:9995 LUCIDA_AUTH=disabled \
  cargo run -p lucida-server -- serve \
  --data-dir /Users/austin/local_data/lucida_test_zarrs

uv run --project lucida-py python scripts/smoke_dataset_reliability.py \
  --server http://127.0.0.1:9995
```

Generated coarse planning is enabled by default; the smoke command does not
need an opt-in flag.

The smoke opens every configured fixture present under
`/Users/austin/local_data/lucida_test_zarrs`:

- collection A
- volume 3D
- LIF bundled channels
- CZI non-canonical axes

It also asserts negative diagnostics for a missing local path and malformed
`zarr.json`. Per-command artifacts and a summary JSON are written to the smoke
output directory.

## Related

- [Flow: Dataset Opening](dataset-opening.md) — low-level open-to-first-render trace
- [lucida-cli](../systems/crates/lucida-cli.md) — CLI command tree and smoke workflow
- [lucida-py](../systems/crates/lucida-py.md) — Python client surface
- [Three-Output Import Model](../decisions/0005-three-output-import-model.md)
- [ContentSource (JS) vs FetchSource (wire)](../decisions/0006-content-source-vs-fetch-source.md)
- [Canonical dataset URL form](../decisions/0042-canonical-dataset-url-form.md)
