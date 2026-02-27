from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class GateThresholds:
    min_cpu_to_auto_speedup: float = 0.98
    min_cpu_to_gpu_speedup: float | None = None
    max_gpu_mean_roundtrip_ms: float | None = None
    max_auto_mean_roundtrip_ms: float | None = None
    require_gpu_backend: bool = True


def _scenario_lookup(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    scenarios = report.get("scenarios", [])
    if not isinstance(scenarios, list):
        return {}
    lookup: dict[str, dict[str, Any]] = {}
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        name = scenario.get("name")
        if isinstance(name, str):
            lookup[name] = scenario
    return lookup


def evaluate_gate(report: dict[str, Any], thresholds: GateThresholds) -> list[str]:
    failures: list[str] = []
    lookup = _scenario_lookup(report)
    cpu = lookup.get("cpu_preferred")
    gpu = lookup.get("gpu_preferred")
    auto = lookup.get("auto_default")
    if cpu is None or gpu is None or auto is None:
        return ["benchmark report is missing cpu_preferred, gpu_preferred, or auto_default scenarios"]

    cpu_mean = float(cpu.get("stats", {}).get("mean_roundtrip_ms", 0.0))
    gpu_mean = float(gpu.get("stats", {}).get("mean_roundtrip_ms", 0.0))
    auto_mean = float(auto.get("stats", {}).get("mean_roundtrip_ms", 0.0))
    cpu_to_gpu_speedup = float(report.get("cpu_to_gpu_speedup") or 0.0)
    cpu_to_auto_speedup = float(report.get("cpu_to_auto_speedup") or 0.0)

    if thresholds.require_gpu_backend:
        backend_counts = gpu.get("stats", {}).get("backend_counts", {})
        gpu_backend_count = 0
        if isinstance(backend_counts, dict):
            gpu_backend_count = int(backend_counts.get("gpu", 0))
        if gpu_backend_count <= 0:
            failures.append("gpu_preferred scenario did not execute on GPU backend")

    if cpu_to_auto_speedup < thresholds.min_cpu_to_auto_speedup:
        failures.append(
            "cpu_to_auto_speedup below threshold: "
            f"actual={cpu_to_auto_speedup:.3f} expected>={thresholds.min_cpu_to_auto_speedup:.3f} "
            f"(cpu_mean={cpu_mean:.3f}ms auto_mean={auto_mean:.3f}ms)"
        )

    if (
        thresholds.min_cpu_to_gpu_speedup is not None
        and cpu_to_gpu_speedup < thresholds.min_cpu_to_gpu_speedup
    ):
        failures.append(
            "cpu_to_gpu_speedup below threshold: "
            f"actual={cpu_to_gpu_speedup:.3f} expected>={thresholds.min_cpu_to_gpu_speedup:.3f} "
            f"(cpu_mean={cpu_mean:.3f}ms gpu_mean={gpu_mean:.3f}ms)"
        )

    if thresholds.max_gpu_mean_roundtrip_ms is not None and gpu_mean > thresholds.max_gpu_mean_roundtrip_ms:
        failures.append(
            "gpu mean roundtrip above threshold: "
            f"actual={gpu_mean:.3f}ms expected<={thresholds.max_gpu_mean_roundtrip_ms:.3f}ms"
        )

    if thresholds.max_auto_mean_roundtrip_ms is not None and auto_mean > thresholds.max_auto_mean_roundtrip_ms:
        failures.append(
            "auto mean roundtrip above threshold: "
            f"actual={auto_mean:.3f}ms expected<={thresholds.max_auto_mean_roundtrip_ms:.3f}ms"
        )

    return failures


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate render benchmark report against perf thresholds.")
    parser.add_argument(
        "--report",
        type=Path,
        required=True,
        help="Path to benchmark report JSON produced by benchmark_render_pipeline.py",
    )
    parser.add_argument(
        "--min-cpu-to-auto-speedup",
        type=float,
        default=0.98,
        help="Minimum required CPU/auto roundtrip speedup ratio.",
    )
    parser.add_argument(
        "--min-cpu-to-gpu-speedup",
        type=float,
        default=None,
        help="Optional minimum required CPU/GPU roundtrip speedup ratio.",
    )
    parser.add_argument(
        "--max-gpu-mean-roundtrip-ms",
        type=float,
        default=None,
        help="Optional upper bound for GPU mean roundtrip latency.",
    )
    parser.add_argument(
        "--max-auto-mean-roundtrip-ms",
        type=float,
        default=None,
        help="Optional upper bound for auto mean roundtrip latency.",
    )
    parser.add_argument(
        "--allow-cpu-fallback",
        action="store_true",
        help="Allow passing when GPU backend is unavailable in gpu_preferred scenario.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report_path = args.report.expanduser().resolve()
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if not isinstance(report, dict):
        raise SystemExit("benchmark report root must be a JSON object")

    thresholds = GateThresholds(
        min_cpu_to_auto_speedup=float(args.min_cpu_to_auto_speedup),
        min_cpu_to_gpu_speedup=(
            float(args.min_cpu_to_gpu_speedup)
            if args.min_cpu_to_gpu_speedup is not None
            else None
        ),
        max_gpu_mean_roundtrip_ms=(
            float(args.max_gpu_mean_roundtrip_ms)
            if args.max_gpu_mean_roundtrip_ms is not None
            else None
        ),
        max_auto_mean_roundtrip_ms=(
            float(args.max_auto_mean_roundtrip_ms)
            if args.max_auto_mean_roundtrip_ms is not None
            else None
        ),
        require_gpu_backend=not bool(args.allow_cpu_fallback),
    )
    failures = evaluate_gate(report, thresholds)
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1

    print("PASS: render perf gate satisfied")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
