# Step 03 Sub-Spec: OME-Zarr IO and Cache Scheduler

## Objective
Implement production-facing OME-Zarr IO for local, HTTP(S), S3-compatible, and GCS backends with deterministic cache/scheduler behavior and typed protocol errors.

## What Lives in This Sub-Spec
1. OME-NGFF (`0.4` and `0.5`) metadata parsing and normalization.
2. Backend URI routing for local, HTTP(S), S3-compatible, GCS, plus retained synthetic adapter for deterministic tests.
3. Metadata cache + chunk-byte LRU cache policy.
4. IO scheduler defaults for timeout/retry/cancellation.
5. Minimal `0.5` export path (`dataset.export`) to local filesystem destinations.

## Scope
In scope:
1. Read support for OME-Zarr `0.4` and `0.5`.
2. `dataset.open` timeout/retry options and typed failure mapping.
3. Strict `axis_map` behavior (`source_axis -> canonical_axis`).
4. Additive `dataset.get` metadata fields for backend/NGFF/cache visibility.
5. New async `dataset.export` method (local destination only in Step 03).

Out of scope:
1. Cloud export destinations for `dataset.export`.
2. Full conversion toolchain and arbitrary format translation.
3. Step 04+ renderer-side multiscale selection policies.

## Protocol Delta Owned by Step 03
1. Add method:
   - `dataset.export`
2. Extend `dataset.open` request with optional:
   - `timeout_ms`
   - `max_retries`
3. Extend `dataset.get` response with optional fields:
   - `backend`
   - `ngff`
   - `cache`
4. Add event type:
   - `dataset.exported`

Protocol version policy:
1. Protocol version string remains `1.0.0` during current pre-release development.
2. Additive method and field updates are allowed in-place while the contract is pre-release.
3. OpenRPC/schema/docs/tests must always match the live `1.0.0` artifacts in-repo.

## Backend Matrix and URI Rules
1. `local`:
   - accepted URI forms: `file://...` and absolute/`.zarr` filesystem paths.
2. `http`:
   - accepted URI forms: `http://...` and `https://...`.
3. `s3`:
   - accepted URI forms: `s3://bucket/path`.
   - dependency: optional `s3fs`.
4. `gcs`:
   - accepted URI forms: `gs://bucket/path`.
   - dependency: optional `gcsfs`.
5. `synthetic`:
   - retained for deterministic runtime tests only.

Unsupported schemes must fail with `LUCIDA_UNSUPPORTED_CAPABILITY`.

## Axis Mapping Contract (`axis_map`)
1. `axis_map` is a strict mapping from source axis labels to canonical output axis labels.
2. Unknown source keys are rejected.
3. Duplicate target labels are rejected.
4. Invalid mappings fail with `LUCIDA_INVALID_PARAMS`.

## Cache Scheduler Policy
1. Metadata cache:
   - key: dataset URI.
   - records metadata hit/miss counters.
2. Chunk cache:
   - byte-budgeted LRU.
   - records chunk hit/miss and eviction counters.
3. Default cache snapshot surfaced via `dataset.get.cache`:
   - `chunk_capacity_bytes`
   - `chunk_used_bytes`
   - `metadata_entries`
   - counter set (`chunk_hits`, `chunk_misses`, `metadata_hits`, `metadata_misses`, `evictions`)

## Timeout, Retry, and Cancellation Rules
1. Scheduler defaults are deterministic and bounded.
2. `dataset.open` supports per-request override via `timeout_ms` and `max_retries`.
3. `dataset.export` is async and idempotent-key protected.
4. `job.cancel` can cancel queued/running export jobs.
5. Timeout maps to `LUCIDA_TIMEOUT`.

## Error Mapping Matrix
1. invalid `axis_map` / malformed parameters -> `LUCIDA_INVALID_PARAMS`.
2. missing optional backend dependency (`s3fs`/`gcsfs`) -> `LUCIDA_UNSUPPORTED_CAPABILITY`.
3. unsupported URI scheme -> `LUCIDA_UNSUPPORTED_CAPABILITY`.
4. timeout budget exceeded -> `LUCIDA_TIMEOUT`.
5. backend read/write failure -> `LUCIDA_IO_FAILURE`.
6. destination exists without overwrite -> `LUCIDA_CONFLICT`.

## Deliverables
1. `python/lucida_core/io/` subsystem (backend routing, metadata, cache, scheduler).
2. `python/lucida_core/engine.py` integration for Step 03 dataset behavior.
3. Protocol artifacts and OpenRPC updates for `dataset.export` and additive dataset metadata.
4. Updated Step 03 docs and protocol guide.
5. Runtime and protocol tests for Step 03 acceptance gates.

## Test and Acceptance Gates
1. Protocol contract tests:
   - method set includes `dataset.export`.
   - schema/OpenRPC integrity checks are green.
   - generated model freshness check is green.
2. Core runtime tests:
   - strict axis-map validation coverage.
   - timeout mapping coverage.
   - export cancellation coverage.
3. Integration-style IO tests:
   - local OME-Zarr fixture open/get.
   - export/re-open local OME-Zarr flow.
4. CI backend strategy:
   - S3-compatible integration via MinIO.
   - GCS integration via emulator.

## Dependencies
1. Step 02 state model and dispatcher.
2. Protocol artifacts from Step 01/02.
3. Runtime compatibility target is Zarr 2 and Zarr 3 under one code path (no `<3` pin).

## Expansion Trigger (Post Step 03)
After Step 03 acceptance gates are consistently green and Step 07 daemon/event lifecycle is stable, expand `dataset.export` destinations in this order:
1. S3-compatible destinations.
2. GCS destinations.

## Exit Criteria
Step 03 is complete when datasets can be opened and introspected across supported backends with deterministic cache/scheduler behavior, and minimal local `0.5` export works through the protocol.
