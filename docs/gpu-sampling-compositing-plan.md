# GPU Sampling and Compositing Plan

This plan migrates 2D render sampling/compositing from CPU to GPU while preserving API behavior, deterministic fallback, and output parity.

## Success Criteria

- [ ] GPU path executes sampling and compositing (not post-copy only).
- [ ] CPU fallback remains correct and automatic on GPU failure.
- [ ] Default `auto` backend shows lower end-to-end render latency on representative scenes.
- [ ] CPU/GPU output parity passes for interpolation, slab modes, channel modes, and layer stacking.
- [ ] Cache budgets are enforced for both CPU and GPU resources.

## Cross-Cutting Guardrails

- [ ] Keep request/response contracts backward compatible unless explicitly versioned.
- [ ] Preserve warning semantics for runtime GPU fallback.
- [ ] Keep timings stage-accurate (`chunk_fetch`, `chunk_decode`, `sample`, `compose`, `gpu_upload`, `gpu_compute`, `gpu_readback`, `encode`).
- [ ] Ensure all new behavior is covered by real integration/unit tests (no mocks).

## PR Slices

### Slice 1: Renderer Contract + Observability Foundation

Goal: Add explicit backend reporting and execution metadata so each render declares whether CPU or GPU actually rendered the frame.

Checklist:

- [x] Add `backend_used` metadata to render responses.
- [x] Emit backend-used value after fallback resolution (requested GPU but runtime CPU fallback reports CPU).
- [x] Update integration tests to assert backend metadata is present and valid.

Exit criteria:

- [x] Existing render tests pass with new metadata assertions.

### Slice 2: Pixel Pipeline Refactor (No Behavior Change)

Goal: Separate render flow into `data prep` and `pixel pipeline` so CPU and GPU can share decoded inputs.

Checklist:

- [x] Extract chunk fetch/decode/slab extraction into reusable typed prep structs.
- [x] Keep current CPU sampling/compositing as a pixel pipeline implementation.
- [x] Keep rendered pixels and timing behavior equivalent to current baseline.

Exit criteria:

- [x] Full render test suite passes with parity to baseline outputs.

### Slice 3: GPU Runtime for Real Sampling/Compositing

Goal: Replace copy-only WGSL with compute kernels that perform sampling and compositing.

Checklist:

- [ ] Introduce persistent GPU renderer runtime (pipelines, bind group layouts, reusable buffers).
- [ ] Implement WGSL sampling kernels for nearest and linear interpolation.
- [ ] Implement WGSL compose kernels for channel normalization/gamma/color + alpha compositing.
- [ ] Keep runtime fallback to CPU on GPU errors.

Exit criteria:

- [ ] GPU backend can render end-to-end without using CPU sampling/compositing.

### Slice 4: GPU Resource Caching and Budget Enforcement

Goal: Use cache budgets for uploaded GPU resources and reduce per-frame upload overhead.

Checklist:

- [ ] Extend GPU cache entries to hold reusable uploaded resources keyed by chunk/layer characteristics.
- [ ] Enforce `max_gpu_cache_bytes` with measurable evictions.
- [ ] Include cache behavior in render telemetry/debug logs.

Exit criteria:

- [ ] Repeated renders show reduced GPU upload time in timing stages.

### Slice 5: GPU/CPU Parity Test Matrix

Goal: Protect correctness while enabling performance improvements.

Checklist:

- [ ] Add parity tests for nearest vs linear interpolation.
- [ ] Add parity tests for slab modes (`single`, `mip`, `mean`).
- [ ] Add parity tests for channel modes (`single`, `rgb`, `composite`) and gamma/contrast.
- [ ] Add parity tests for multi-layer alpha compositing.

Exit criteria:

- [ ] Parity suite passes in both GPU-enabled and software-only builds.

### Slice 6: Performance Baseline + Regression Gates

Goal: Quantify speedup and prevent performance regressions.

Checklist:

- [ ] Add reproducible render benchmark driver and dataset fixtures.
- [ ] Record baseline CPU timings and new GPU timings.
- [ ] Add CI/perf check script for local gate with clear pass/fail thresholds.

Exit criteria:

- [ ] Documented speedups on representative resolutions/scenes.

### Slice 7: Default Rollout Hardening

Goal: Make GPU sampling/compositing safe as the default path.

Checklist:

- [ ] Verify `auto` backend policy behavior with feature flags and env overrides.
- [ ] Harden fallback warnings and error details for production debugging.
- [ ] Update docs for backend controls, cache tuning, and expected timings.

Exit criteria:

- [ ] End-to-end tests and docs are complete; rollout-ready default behavior.

## Operational Sequence

1. Land Slice 1 first (metadata foundation).
2. Land Slice 2 before any shader migration.
3. Land Slice 3 and Slice 4 together or in immediate succession.
4. Land Slice 5 before enabling broader rollout.
5. Land Slice 6 and Slice 7 for operational confidence and default-path hardening.
