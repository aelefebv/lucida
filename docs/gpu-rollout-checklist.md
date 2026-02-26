# GPU Rollout Checklist

## Scope

- [x] Confirm current renderer architecture and spec expectations.
- [x] Keep CPU rendering as an explicit fallback path.
- [x] Use WebGPU via `wgpu` for runtime capability detection.

## Phase 1: Backend Selection Plumbing

- [x] Add a render backend selector module (`auto|gpu|cpu`) with env override support.
- [x] Respect `performance.prefer_gpu` when selecting backend in `/render/image`.
- [x] Emit warning metadata when GPU is requested but unavailable and CPU fallback is used.
- [x] Keep render API contract stable for existing clients.

## Phase 2: Capabilities Endpoint

- [x] Add runtime GPU detection service in daemon state.
- [x] Add `GET /capabilities` endpoint.
- [x] Return GPU availability, adapter/backend details, and declared render modes/presets.
- [x] Add route-level tests for capabilities payload shape.

## Phase 3: Client/Model Surface

- [ ] Add typed capabilities models in Python and Rust DTOs.
- [ ] Add `LucidaClient.get_capabilities()` method.
- [ ] Keep strict schema behavior (`extra="forbid"` / `deny_unknown_fields`) intact.

## Phase 4: Validation

- [ ] Add backend selection tests (`prefer_gpu`, env override, fallback warning path).
- [ ] Run Rust test suite for daemon crate.
- [ ] Run Python test suite.

## Phase 5: Delivery

- [ ] Commit checkpoint: checklist + backend selector plumbing.
- [ ] Commit checkpoint: capabilities endpoint + runtime GPU detection.
- [ ] Commit checkpoint: Python client/models + test updates.
- [ ] Push branch and open draft PR with detailed body.
- [ ] Merge PR into `main` once checks pass.
