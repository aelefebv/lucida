# GPU Render Performance Remediation Plan

## Context

Current GPU sampling/compositing correctness is in place, but measured latency regressed versus CPU on the benchmark fixture.

Baseline (February 27, 2026):

- CPU mean roundtrip: `236.84 ms`
- GPU mean roundtrip: `387.12 ms`
- CPU/GPU ratio (`cpu_to_gpu_speedup`): `0.612`

Release smoke (512x512):

- CPU mean roundtrip: `11.90 ms`
- GPU mean roundtrip: `23.60 ms`
- CPU/GPU ratio: `0.504`

## Root-Cause Summary

1. **GPU readback path is too heavy**
   - Current pipeline reads back a `vec4<f32>` canvas (`16 B/pixel`) and performs per-pixel `f32 -> u8` conversion on CPU.

2. **Per-pixel shader work is over-expensive**
   - Composite shader performs expensive operations per channel/pixel (including `pow`) even for common `gamma=1.0` cases.
   - Coordinate transforms are recomputed inside channel sampling logic instead of hoisted.

3. **Per-frame setup overhead remains high**
   - Canvas is initialized by uploading full float background buffer from CPU each frame.
   - Per-layer uniforms/bind resources create avoidable CPU/GPU overhead.

4. **CPU-side payload prep has avoidable overhead**
   - Layer payload byte packing/hashing currently uses expensive conversion/hashing choices for cache keys.

## Success Criteria

- GPU mean roundtrip must be **strictly below** CPU mean roundtrip on benchmark fixture at `512x512` in release mode.
- `cpu_to_gpu_speedup` must be `> 1.00` on the benchmark fixture.
- Output parity tests must remain green.
- Fallback semantics and metadata contracts must remain backward-compatible.

## PR Slices

### Slice A: Profiling + Plan Artifact (this doc)

Deliverables:

- Baseline measurements and root-cause breakdown.
- Ordered remediation plan with pass/fail gates.

Gate:

- Plan doc reviewed and committed.

### Slice B: GPU Pipeline Dataflow Optimization

Changes:

- Replace CPU-side float canvas initialization upload with GPU clear pass.
- Add GPU pack pass to convert float canvas -> RGBA8 on device before readback.
- Read back RGBA8 (`4 B/pixel`) instead of float canvas (`16 B/pixel`).

Expected impact:

- Lower `gpu_upload` and `gpu_readback` time.
- Lower total PCIe/unified-memory traffic and CPU conversion cost.

Gate:

- Render/parity tests pass.
- Benchmark shows measurable GPU latency reduction vs baseline.

### Slice C: Shader Compute Optimization

Changes:

- Hoist invariant coordinate/scaling math out of per-channel sampling path.
- Skip `pow` when `gamma ~= 1.0`.
- Keep correctness and interpolation behavior intact.

Expected impact:

- Lower `gpu_compute` stage cost.

Gate:

- Render/parity tests pass.
- Benchmark shows further reduction in `gpu_compute` and total GPU latency.

### Slice D: CPU Payload Prep/Cache-Key Optimization

Changes:

- Replace expensive layer payload hashing path with faster deterministic non-crypto hash.
- Tighten byte packing path to reduce CPU prep overhead.

Expected impact:

- Lower per-frame CPU prep overhead for GPU path.

Gate:

- Render/parity tests pass.
- Benchmark confirms reduction in end-to-end GPU path overhead.

### Slice E: Benchmark Gate Update + Final Validation

Changes:

- Re-run benchmark using release daemon.
- Update baseline/perf docs with post-fix metrics.
- Tighten perf gate threshold after improvements land.

Gate:

- `cpu_to_gpu_speedup > 1.00` on benchmark fixture.
- All relevant tests and perf gate pass.

## Validation Matrix

For each implementation PR:

- `cargo fmt --all`
- `cargo test -p lucida-daemon render_image -- --nocapture`
- `cargo test -p lucida-daemon --test render_gpu_parity -- --nocapture`
- `cargo test -p lucida-daemon --no-default-features --features software --test render_gpu_parity -- --nocapture`
- `uv run pytest tests/python/scripts/test_render_perf_tooling.py`

For perf validation:

- release daemon benchmark run via `scripts/perf/benchmark_render_pipeline.py`
- perf gate via `scripts/perf/check_render_perf_gate.py`

## Risks

- GPU pack/clear passes can introduce parity drift if clamping/rounding differs from existing behavior.
- Shader simplifications can subtly alter interpolation at boundaries.
- Faster non-crypto hash introduces collision risk; mitigate by including payload sizes/channel count in hash input and preserving cache correctness checks.

## Rollback Strategy

- Keep CPU fallback intact for all failures.
- Land each slice independently so any regression can be reverted at a single-PR boundary.
