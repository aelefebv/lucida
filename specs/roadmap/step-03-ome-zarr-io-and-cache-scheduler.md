# Step 03 Sub-Spec: OME-Zarr IO and Cache Scheduler

## Objective
Implement robust OME-Zarr access and chunk scheduling for local, HTTP(S), and S3 backends with predictable cache behavior.

## What Lives in This Sub-Spec
- OME-Zarr metadata parsing and multiscale discovery.
- Backend adapters for filesystem, HTTP(S), and S3.
- Chunk request scheduling and cache policy.
- Error mapping from backend failures to typed protocol errors.

## Scope
In scope:
1. Read support for OME-Zarr v0.4/v0.5.
2. Initial write/export compatibility targeting v0.5 metadata requirements.
3. IO cancellation and timeout behavior.
4. Cache eviction and priority rules.

Out of scope:
1. Advanced analytics processing.
2. Full dataset conversion tooling.

## Interface and Contract Changes
- Define dataset handle metadata returned by `dataset.get`.
- Define async job behavior for `dataset.open`.
- Define IO-related error mapping (`LUCIDA_IO_FAILURE`, `LUCIDA_TIMEOUT`, etc).

## Deliverables
1. OME-Zarr adapter modules.
2. Backend abstraction for local/HTTP/S3.
3. Cache scheduler implementation.
4. Integration fixtures and tests.

## Test and Acceptance Gates
1. Local/HTTP/S3 integration tests pass on real fixtures.
2. Chunk cache hit/miss behavior is measurable and stable.
3. Dataset open handles cancellation and timeout correctly.
4. Metadata and axis information are surfaced consistently.

## Dependencies
- Step 02 state and command dispatcher.

## Exit Criteria
Step 03 is complete when datasets can be opened and queried reliably across supported backends with stable performance behavior.
