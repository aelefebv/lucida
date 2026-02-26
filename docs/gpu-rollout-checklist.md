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

- [x] Add typed capabilities models in Python and Rust DTOs.
- [x] Add `LucidaClient.get_capabilities()` method.
- [x] Keep strict schema behavior (`extra="forbid"` / `deny_unknown_fields`) intact.

## Phase 4: Validation

- [x] Add backend selection tests (`prefer_gpu`, env override, fallback warning path).
- [x] Run Rust test suite for daemon crate.
- [x] Run Python test suite.
Status note: `uv run pytest -q` currently has 3 pre-existing failures in `tests/python/skills/test_skill_tooling.py` because `skills/lucida-orchestrator` is absent in this repo checkout.

## Phase 5: Delivery

- [x] Commit checkpoint: checklist + backend selector plumbing.
- [x] Commit checkpoint: capabilities endpoint + runtime GPU detection.
- [x] Commit checkpoint: Python client/models + test updates.
- [x] Push branch and open draft PR with detailed body.
- [x] Merge PR into `main` once checks pass.
