## Integrated Delivery Plan: Python + Rust Viewer Server Migration

### Summary
This plan combines the existing Python implementation with a Rust daemon rollout in a single ordered program.  
Goal: keep Python as the stable client/contract oracle while implementing a Rust daemon that matches current Phase 1 behavior exactly, then cut over safely.

Locked decisions:
1. Parallel parity migration (Python and Rust run side-by-side).
2. Strict API contract parity (no schema drift).
3. Rust stack is locked to `tokio + axum + wgpu/WGSL + zarrs`.
4. Rust daemon lives in this repo at `rust/lucida-daemon`.
5. Python client/CLI remain the thin front door.

### Order Of Operations

## Milestone 0: Contract Freeze + Parity Harness
1. Python work:
2. Freeze current Phase 1 contracts as canonical fixtures from real responses for all endpoints.
3. Add a parity test harness that can target `python` or `rust` backend and compare normalized responses.
4. Add a backend selector in CLI/client runtime config for local dev and tests.
5. Rust work:
6. Create `rust/lucida-daemon` crate scaffold with `tokio`, `axum`, structured error envelope, and `/healthz`.
7. Define Rust DTOs mirroring Python models exactly for all Phase 1 contracts.
8. Gate:
9. `uv run pytest` stays green.
10. `cargo test` baseline green.
11. Parity harness boots against Python and validates fixture corpus.

## Milestone 1: Dataset Open Parity
1. Rust work:
2. Implement URI normalization parity and deterministic dataset ID hashing.
3. Implement OME-Zarr open via `zarrs` + OME-NGFF metadata parsing behavior matching Python.
4. Implement tolerant metadata warnings and curated/full raw metadata policy parity.
5. Implement `POST /dataset/open` with optional `session_id` compatibility behavior.
6. Python work:
7. Keep Python endpoint unchanged.
8. Expand parity fixtures for edge metadata cases.
9. Gate:
10. Rust passes all dataset-open tests currently used by Python plus parity compare tests.

## Milestone 2: Sessions, ViewState, Selectors, Hashing
1. Rust work:
2. Implement in-memory registries and lock-protected mutation (`sessions`, `datasets`, `views`).
3. Implement `/session/create`, `/view/create`, `/view/{id}`, `/view/update`.
4. Implement selector normalization (`index`, `range`, `set`) with clamp/strict semantics and warning parity.
5. Implement `state_version` and canonical `state_hash` parity (sorted keys, float quantization, exclude hash/version fields).
6. Python work:
7. Add cross-runtime deterministic fixtures for selector behavior and hash/version transitions.
8. Gate:
9. Existing Python view-state tests pass unchanged against Rust target mode.
10. Parity diff for ViewState flows is clean after nondeterministic field normalization.

## Milestone 3: 2D Render + Snapshot Contract Parity
1. Rust work:
2. Implement `/render/image` stateful and stateless one-of behavior (`view_id` xor `view_state`).
3. Implement plane logic (XY/XZ/YZ), pan/zoom semantics, slab modes, selector reduction warnings, and LOD behavior.
4. Implement `wgpu` rendering path with WGSL shaders for Phase 1 2D rendering pipeline.
5. Implement PNG outputs for `inline_base64` and safe `file_path` under `output/`.
6. Implement exact errors: `invalid_render_request`, `render_output_path_invalid`, `render_output_too_large`, `unsupported_plane`, `invalid_patch`, etc.
7. Python work:
8. Keep current render behavior as oracle.
9. Add pixel-level parity checks where deterministic and contract-level checks where backend variability exists.
10. Gate:
11. Render endpoint/CLI/client test suites pass against Rust.
12. Snapshot notebook parity checks pass against Rust backend.

## Milestone 4: Export/Import + Cache Architecture
1. Rust work:
2. Implement `/export/viewstate` and `/import/viewstate` parity behavior and rebasing rules.
3. Implement required import guards (`unsupported_mode`, dataset scope checks, dataset existence checks).
4. Add explicit CPU LRU cache and GPU texture cache with configurable budgets.
5. Add cache stats to internal logs/metrics for validation (no public schema change).
6. Python work:
7. Add parity fixtures for export/import invariants and session auto-attach behavior.
8. Gate:
9. Export/import suites pass in Rust mode.
10. Cache stress tests show bounded memory behavior.

## Milestone 5: Packaging, Cutover, and Stabilization
1. Rust work:
2. Build single-binary daemon packaging.
3. Add Cargo feature flags for GPU and fallback modes (for example `gpu` feature enabled by default, software-capable test path in CI).
4. Python work:
5. Keep Python client/CLI unchanged externally; set default dev target to Rust daemon.
6. Retain Python server as fallback runtime during stabilization window.
7. Gate:
8. Full `uv run pytest` green against Rust target.
9. Full `cargo test` green.
10. All Phase 1 notebooks execute top-to-bottom against Rust target.
11. No open parity blocker for contract/schema/error behavior.

### Public API / Interface Policy
1. No public API contract changes during migration.
2. Existing endpoints and payloads remain stable.
3. Optional internal-only additions allowed (`/healthz`, internal cache metrics).
4. Python client and CLI signatures remain backward-compatible.

### Combined Implementation Workstreams

## Python Stream (Oracle + Tooling)
1. Maintain current server behavior as reference until cutover complete.
2. Maintain Pydantic contracts and CLI/client UX.
3. Own fixture generation and parity comparison harness.
4. Own notebook validation flow and acceptance checks.
5. Provide fallback server path during Rust stabilization.

## Rust Stream (Daemon Replacement)
1. Implement full Phase 1 behavior with locked stack:
2. Concurrency: `tokio`.
3. API: `axum` HTTP.
4. Rendering: `wgpu` with WGSL shaders.
5. Zarr I/O: `zarrs` + OME-NGFF parsing.
6. Caching: CPU LRU + GPU texture cache.
7. Packaging: single binary + optional GPU feature flags.

### Test Cases And Scenarios
1. Endpoint contract parity for all Phase 1 routes.
2. Error code/status parity for all known failure modes.
3. Selector normalization parity including clamp/strict behavior.
4. Hash/version parity across create/update/import/render effective state.
5. Render contract parity for stateful/stateless requests and both delivery modes.
6. Safe output path enforcement parity.
7. CLI/client integration parity with unchanged command/API usage.
8. Notebook end-to-end parity execution on Rust target.

### Acceptance Criteria
1. Python suite remains green throughout migration.
2. Rust suite is green with meaningful unit and integration coverage.
3. Cross-runtime parity harness passes with no contract-level diffs.
4. Phase 1 notebooks run successfully against Rust daemon.
5. Rust becomes default runtime only after all parity gates pass.
6. Python fallback remains available for one stabilization cycle.

### Assumptions And Defaults
1. Migration starts immediately after plan approval.
2. No new Phase 2+ features are added until Phase 1 parity cutover is complete.
3. HTTP remains the primary protocol during this program.
4. GPU availability may vary by environment; CI must support deterministic headless path.
5. Existing client/CLI behavior is treated as user-facing contract and cannot regress.
