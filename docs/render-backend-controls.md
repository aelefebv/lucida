# Render Backend Controls

This document describes how Lucida selects CPU vs GPU rendering, how to tune cache budgets, and how to read timing telemetry.

## Backend Selection Policy

Lucida supports three backend modes through `LUCIDA_RENDER_BACKEND`:

- `auto` (default): use GPU when requested and available, but fall back to CPU when no adapter is available or when the detected adapter appears to be software-only.
- `cpu`: always use CPU.
- `gpu`: force GPU when available (even if adapter appears software-only); otherwise fall back to CPU with warning.

Invalid values are ignored and emit `invalid_render_backend_override`.

`ViewState.performance.prefer_gpu` still controls request-level intent under `auto` mode.

## Fallback Warning Codes

When a fallback occurs, warnings include structured details:

- `gpu_unavailable_fallback_cpu`
  - Trigger: GPU requested but no adapter available.
  - Details include `requested_by`, `gpu_hardware_available`, and `gpu_adapter_name`.
- `gpu_software_adapter_fallback_cpu`
  - Trigger: auto policy detected a software adapter and chose CPU.
  - Details include `requested_by`, `gpu_hardware_available`, and `gpu_adapter_name`.
- `gpu_render_failed_fallback_cpu`
  - Trigger: GPU render failed at runtime and request was rerouted to CPU.
  - Details include upstream GPU error fields and explicit `requested_backend`/`fallback_backend`.

Every render response includes `meta.backend_used` so the final backend is unambiguous.

## Cache Budget Tuning

Global cache defaults can be tuned with environment variables:

- `LUCIDA_MAX_CPU_CACHE_BYTES`
- `LUCIDA_MAX_GPU_CACHE_BYTES`

Per-view overrides can be set in `ViewState.performance`:

- `max_cpu_cache_bytes`
- `max_gpu_cache_bytes`

## Timing Fields

`meta.timing_ms` and `meta.timing_ms.stages` expose stage timing breakdown:

- top-level: `total`, `io`, `decode`, `gpu_upload`, `render`
- stage-level: `chunk_fetch`, `chunk_decode`, `sample`, `compose`, `encode`, `gpu_compute`, `gpu_readback`

Use these fields for perf regressions and for validating cache/gpu changes in benchmark runs.

## Feature-Flag Validation

To validate behavior with the software-only build (no GPU feature):

```bash
cargo test -p lucida-daemon --no-default-features --features software --test render_gpu_parity -- --nocapture
```

To validate default GPU-enabled behavior:

```bash
cargo test -p lucida-daemon --test render_gpu_parity -- --nocapture
```
