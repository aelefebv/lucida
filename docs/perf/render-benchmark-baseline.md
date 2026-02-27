# Render Benchmark Baseline (Slice 6)

Baseline capture date: February 27, 2026 (UTC)

This baseline uses the new benchmark/gate tooling added in slice 6 and records CPU-preferred vs GPU-preferred raw RGBA renders for a deterministic OME-Zarr fixture.

## Commands

Generate the fixture:

```bash
uv run python scripts/perf/generate_render_fixture.py --overwrite
```

Run daemon on a dedicated benchmark port:

```bash
LUCIDA_DAEMON_ADDR=127.0.0.1:3405 cargo run -p lucida-daemon
```

Capture benchmark report:

```bash
uv run python scripts/perf/benchmark_render_pipeline.py \
  --base-url http://127.0.0.1:3405 \
  --create-fixture \
  --overwrite-fixture \
  --warmup-runs 2 \
  --measured-runs 8 \
  --width 512 \
  --height 512 \
  --output output/perf/render-benchmark.baseline.json
```

Evaluate local perf gate:

```bash
uv run python scripts/perf/check_render_perf_gate.py \
  --report output/perf/render-benchmark.baseline.json \
  --min-cpu-to-gpu-speedup 0.60 \
  --max-gpu-mean-roundtrip-ms 450
```

## Baseline Metrics

Fixture: `output/perf/fixtures/render-bench.zarr`

- `cpu_preferred` mean roundtrip: `236.835 ms`
- `cpu_preferred` p95 roundtrip: `246.003 ms`
- `gpu_preferred` mean roundtrip: `387.118 ms`
- `gpu_preferred` p95 roundtrip: `388.686 ms`
- `cpu_to_gpu_speedup` (cpu/gpu): `0.6118`

## Notes

- This baseline is environment-specific and should be treated as a regression reference, not a universal target.
- The gate thresholds above are intentionally aligned to this measured baseline so local perf checks can fail on regressions rather than hardware differences.
