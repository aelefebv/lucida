#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${LUCIDA_PERF_BASE_URL:-http://127.0.0.1:3000}"
FIXTURE_PATH="${LUCIDA_PERF_FIXTURE_PATH:-output/perf/fixtures/render-bench.zarr}"
REPORT_PATH="${LUCIDA_PERF_REPORT_PATH:-output/perf/render-benchmark.latest.json}"
MIN_CPU_TO_GPU_SPEEDUP="${LUCIDA_PERF_MIN_CPU_TO_GPU_SPEEDUP:-0.60}"
MAX_GPU_MEAN_ROUNDTRIP_MS="${LUCIDA_PERF_MAX_GPU_MEAN_ROUNDTRIP_MS:-450}"
WARMUP_RUNS="${LUCIDA_PERF_WARMUP_RUNS:-1}"
MEASURED_RUNS="${LUCIDA_PERF_MEASURED_RUNS:-4}"
WIDTH_PX="${LUCIDA_PERF_WIDTH_PX:-512}"
HEIGHT_PX="${LUCIDA_PERF_HEIGHT_PX:-512}"

uv run python scripts/perf/benchmark_render_pipeline.py \
  --base-url "${BASE_URL}" \
  --fixture-path "${FIXTURE_PATH}" \
  --create-fixture \
  --warmup-runs "${WARMUP_RUNS}" \
  --measured-runs "${MEASURED_RUNS}" \
  --width "${WIDTH_PX}" \
  --height "${HEIGHT_PX}" \
  --output "${REPORT_PATH}"

uv run python scripts/perf/check_render_perf_gate.py \
  --report "${REPORT_PATH}" \
  --min-cpu-to-gpu-speedup "${MIN_CPU_TO_GPU_SPEEDUP}" \
  --max-gpu-mean-roundtrip-ms "${MAX_GPU_MEAN_ROUNDTRIP_MS}"
