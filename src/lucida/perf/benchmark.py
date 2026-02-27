from __future__ import annotations

import argparse
import json
import statistics
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from lucida.perf.fixture import create_render_perf_fixture


@dataclass(frozen=True, slots=True)
class BenchmarkArgs:
    base_url: str
    fixture_path: Path
    output_path: Path
    create_fixture: bool
    overwrite_fixture: bool
    warmup_runs: int
    measured_runs: int
    width_px: int
    height_px: int
    timeout_s: float


@dataclass(frozen=True, slots=True)
class RenderSample:
    roundtrip_ms: float
    total_ms: float
    io_ms: float
    decode_ms: float
    gpu_upload_ms: float
    render_ms: float
    chunk_fetch_ms: float
    chunk_decode_ms: float
    sample_ms: float
    compose_ms: float
    gpu_compute_ms: float
    gpu_readback_ms: float
    backend_used: str


@dataclass(frozen=True, slots=True)
class ScenarioStats:
    mean_roundtrip_ms: float
    p50_roundtrip_ms: float
    p95_roundtrip_ms: float
    mean_total_ms: float
    mean_gpu_upload_ms: float
    backend_counts: dict[str, int]


@dataclass(frozen=True, slots=True)
class ScenarioResult:
    name: str
    prefer_gpu: bool
    samples: list[RenderSample]
    stats: ScenarioStats


@dataclass(frozen=True, slots=True)
class BenchmarkReport:
    schema_version: int
    generated_at: str
    base_url: str
    fixture_path: str
    gpu_available: bool
    session_id: str
    dataset_id: str
    view_id: str
    scenarios: list[ScenarioResult]
    cpu_to_gpu_speedup: float | None


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (percentile / 100.0) * (len(ordered) - 1)
    lower_index = int(rank)
    upper_index = min(lower_index + 1, len(ordered) - 1)
    weight = rank - lower_index
    return ordered[lower_index] * (1.0 - weight) + ordered[upper_index] * weight


def _post_json(client: httpx.Client, url: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = client.post(url, json=payload)
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise RuntimeError(f"unexpected JSON payload type from {url}: {type(data)!r}")
    return data


def _render_once(
    client: httpx.Client,
    base_url: str,
    view_id: str,
    width_px: int,
    height_px: int,
) -> RenderSample:
    render_payload = {
        "schema_version": 1,
        "view_id": view_id,
        "output": {
            "format": "raw_rgba",
            "delivery": "inline_base64",
            "width_px": width_px,
            "height_px": height_px,
        },
    }
    start = time.perf_counter()
    response = client.post(f"{base_url}/render/image", json=render_payload)
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("render/image returned unexpected payload")

    timing = payload.get("meta", {}).get("timing_ms", {})
    stages = timing.get("stages", {}) if isinstance(timing, dict) else {}
    return RenderSample(
        roundtrip_ms=elapsed_ms,
        total_ms=float(timing.get("total", 0.0)),
        io_ms=float(timing.get("io", 0.0)),
        decode_ms=float(timing.get("decode", 0.0)),
        gpu_upload_ms=float(timing.get("gpu_upload", 0.0)),
        render_ms=float(timing.get("render", 0.0)),
        chunk_fetch_ms=float(stages.get("chunk_fetch", 0.0)),
        chunk_decode_ms=float(stages.get("chunk_decode", 0.0)),
        sample_ms=float(stages.get("sample", 0.0)),
        compose_ms=float(stages.get("compose", 0.0)),
        gpu_compute_ms=float(stages.get("gpu_compute", 0.0)),
        gpu_readback_ms=float(stages.get("gpu_readback", 0.0)),
        backend_used=str(payload.get("meta", {}).get("backend_used", "unknown")),
    )


def _run_scenario(
    client: httpx.Client,
    *,
    base_url: str,
    view_id: str,
    prefer_gpu: bool,
    warmup_runs: int,
    measured_runs: int,
    width_px: int,
    height_px: int,
) -> ScenarioResult:
    update_payload = {
        "schema_version": 1,
        "view_id": view_id,
        "patch": [
            {
                "op": "replace",
                "path": "/performance",
                "value": {
                    "prefer_gpu": prefer_gpu,
                    "lod_mode": "fixed",
                    "fixed_level": 0,
                },
            },
            {
                "op": "replace",
                "path": "/view_2d/orthogonal_views_enabled",
                "value": False,
            },
        ],
    }
    _post_json(client, f"{base_url}/view/update", update_payload)

    for _ in range(warmup_runs):
        _render_once(client, base_url, view_id, width_px, height_px)

    samples: list[RenderSample] = []
    for _ in range(measured_runs):
        samples.append(_render_once(client, base_url, view_id, width_px, height_px))

    roundtrip_values = [sample.roundtrip_ms for sample in samples]
    total_values = [sample.total_ms for sample in samples]
    gpu_upload_values = [sample.gpu_upload_ms for sample in samples]
    backend_counts: dict[str, int] = {}
    for sample in samples:
        backend_counts[sample.backend_used] = backend_counts.get(sample.backend_used, 0) + 1

    scenario_name = "gpu_preferred" if prefer_gpu else "cpu_preferred"
    return ScenarioResult(
        name=scenario_name,
        prefer_gpu=prefer_gpu,
        samples=samples,
        stats=ScenarioStats(
            mean_roundtrip_ms=statistics.fmean(roundtrip_values),
            p50_roundtrip_ms=_percentile(roundtrip_values, 50.0),
            p95_roundtrip_ms=_percentile(roundtrip_values, 95.0),
            mean_total_ms=statistics.fmean(total_values),
            mean_gpu_upload_ms=statistics.fmean(gpu_upload_values),
            backend_counts=backend_counts,
        ),
    )


def run_benchmark(args: BenchmarkArgs) -> BenchmarkReport:
    fixture_path = args.fixture_path.expanduser().resolve()
    if args.create_fixture and not fixture_path.exists():
        create_render_perf_fixture(fixture_path, overwrite=args.overwrite_fixture)

    if not fixture_path.exists():
        raise FileNotFoundError(f"benchmark fixture does not exist: {fixture_path}")

    with httpx.Client(timeout=args.timeout_s) as client:
        capabilities = client.get(f"{args.base_url}/capabilities")
        capabilities.raise_for_status()
        capabilities_payload = capabilities.json()
        if not isinstance(capabilities_payload, dict):
            raise RuntimeError("/capabilities returned unexpected payload")
        gpu_available = bool(capabilities_payload.get("gpu", {}).get("available", False))

        session = _post_json(client, f"{args.base_url}/session/create", {"schema_version": 1})
        session_id = str(session.get("session_id", ""))
        if not session_id:
            raise RuntimeError("session/create did not return session_id")

        opened = _post_json(
            client,
            f"{args.base_url}/dataset/open",
            {
                "schema_version": 1,
                "session_id": session_id,
                "uri": str(fixture_path),
            },
        )
        dataset_id = str(opened.get("dataset_summary", {}).get("dataset_id", ""))
        if not dataset_id:
            raise RuntimeError("dataset/open did not return dataset_summary.dataset_id")

        created = _post_json(
            client,
            f"{args.base_url}/view/create",
            {
                "schema_version": 1,
                "session_id": session_id,
                "dataset_id": dataset_id,
                "mode": "2d",
            },
        )
        view_id = str(created.get("view_state", {}).get("view_id", ""))
        if not view_id:
            raise RuntimeError("view/create did not return view_state.view_id")

        cpu_result = _run_scenario(
            client,
            base_url=args.base_url,
            view_id=view_id,
            prefer_gpu=False,
            warmup_runs=args.warmup_runs,
            measured_runs=args.measured_runs,
            width_px=args.width_px,
            height_px=args.height_px,
        )
        gpu_result = _run_scenario(
            client,
            base_url=args.base_url,
            view_id=view_id,
            prefer_gpu=True,
            warmup_runs=args.warmup_runs,
            measured_runs=args.measured_runs,
            width_px=args.width_px,
            height_px=args.height_px,
        )

    gpu_mean = gpu_result.stats.mean_roundtrip_ms
    cpu_mean = cpu_result.stats.mean_roundtrip_ms
    cpu_to_gpu_speedup = (cpu_mean / gpu_mean) if gpu_mean > 0 else None

    return BenchmarkReport(
        schema_version=1,
        generated_at=datetime.now(UTC).isoformat(),
        base_url=args.base_url,
        fixture_path=str(fixture_path),
        gpu_available=gpu_available,
        session_id=session_id,
        dataset_id=dataset_id,
        view_id=view_id,
        scenarios=[cpu_result, gpu_result],
        cpu_to_gpu_speedup=cpu_to_gpu_speedup,
    )


def _parse_args() -> BenchmarkArgs:
    parser = argparse.ArgumentParser(description="Benchmark Lucida CPU/GPU render pipeline.")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000", help="Daemon base URL.")
    parser.add_argument(
        "--fixture-path",
        type=Path,
        default=_repo_root() / "output" / "perf" / "fixtures" / "render-bench.zarr",
        help="OME-Zarr benchmark fixture path.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_repo_root() / "output" / "perf" / "render-benchmark.json",
        help="Output JSON report path.",
    )
    parser.add_argument("--create-fixture", action="store_true", help="Create fixture when missing.")
    parser.add_argument("--overwrite-fixture", action="store_true", help="Overwrite fixture path if it exists.")
    parser.add_argument("--warmup-runs", type=int, default=2, help="Warmup renders per scenario.")
    parser.add_argument("--measured-runs", type=int, default=8, help="Measured renders per scenario.")
    parser.add_argument("--width", type=int, default=512, help="Render width in pixels.")
    parser.add_argument("--height", type=int, default=512, help="Render height in pixels.")
    parser.add_argument("--timeout-s", type=float, default=30.0, help="HTTP request timeout seconds.")
    parsed = parser.parse_args()

    if parsed.warmup_runs < 0:
        raise SystemExit("--warmup-runs must be >= 0")
    if parsed.measured_runs <= 0:
        raise SystemExit("--measured-runs must be > 0")
    if parsed.width <= 0 or parsed.height <= 0:
        raise SystemExit("--width/--height must be > 0")

    return BenchmarkArgs(
        base_url=str(parsed.base_url).rstrip("/"),
        fixture_path=parsed.fixture_path,
        output_path=parsed.output,
        create_fixture=bool(parsed.create_fixture),
        overwrite_fixture=bool(parsed.overwrite_fixture),
        warmup_runs=int(parsed.warmup_runs),
        measured_runs=int(parsed.measured_runs),
        width_px=int(parsed.width),
        height_px=int(parsed.height),
        timeout_s=float(parsed.timeout_s),
    )


def main() -> int:
    args = _parse_args()
    report = run_benchmark(args)
    output_path = args.output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
