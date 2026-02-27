from __future__ import annotations

import json
from pathlib import Path

from lucida.perf.fixture import FixtureSpec, create_render_perf_fixture
from lucida.perf.gate import GateThresholds, evaluate_gate


def test_create_render_perf_fixture_writes_expected_layout(tmp_path: Path) -> None:
    fixture_path = tmp_path / "bench.zarr"
    create_render_perf_fixture(
        fixture_path,
        spec=FixtureSpec(
            level0_shape=(1, 1, 1, 4, 4),
            level1_shape=(1, 1, 1, 2, 2),
            level0_chunk=(1, 1, 1, 2, 2),
            level1_chunk=(1, 1, 1, 2, 2),
        ),
    )

    assert (fixture_path / "zarr.json").exists()
    assert (fixture_path / "0" / "zarr.json").exists()
    assert (fixture_path / "1" / "zarr.json").exists()

    root_meta = json.loads((fixture_path / "zarr.json").read_text(encoding="utf-8"))
    assert root_meta["attributes"]["multiscales"][0]["name"] == "primary"
    assert root_meta["attributes"]["omero"]["channels"][0]["label"] == "c0"

    chunk_bytes = (fixture_path / "0" / "c" / "0" / "0" / "0" / "0" / "0").read_bytes()
    assert len(chunk_bytes) == 8
    first_value = int.from_bytes(chunk_bytes[0:2], byteorder="little", signed=False)
    assert first_value == 0


def test_create_render_perf_fixture_requires_overwrite(tmp_path: Path) -> None:
    fixture_path = tmp_path / "bench.zarr"
    create_render_perf_fixture(fixture_path)

    raised = False
    try:
        create_render_perf_fixture(fixture_path)
    except FileExistsError:
        raised = True

    assert raised is True


def test_evaluate_gate_passes_when_thresholds_are_met() -> None:
    report = {
        "cpu_to_gpu_speedup": 1.25,
        "cpu_to_auto_speedup": 1.03,
        "scenarios": [
            {
                "name": "cpu_preferred",
                "stats": {
                    "mean_roundtrip_ms": 40.0,
                    "backend_counts": {"cpu": 8},
                },
            },
            {
                "name": "gpu_preferred",
                "stats": {
                    "mean_roundtrip_ms": 32.0,
                    "backend_counts": {"gpu": 8},
                },
            },
            {
                "name": "auto_default",
                "stats": {
                    "mean_roundtrip_ms": 38.8,
                    "backend_counts": {"cpu": 8},
                },
            },
        ],
    }

    failures = evaluate_gate(
        report,
        GateThresholds(min_cpu_to_auto_speedup=1.0, min_cpu_to_gpu_speedup=1.2),
    )
    assert failures == []


def test_evaluate_gate_fails_for_speedup_and_gpu_backend() -> None:
    report = {
        "cpu_to_gpu_speedup": 1.01,
        "cpu_to_auto_speedup": 0.89,
        "scenarios": [
            {
                "name": "cpu_preferred",
                "stats": {
                    "mean_roundtrip_ms": 30.0,
                    "backend_counts": {"cpu": 8},
                },
            },
            {
                "name": "gpu_preferred",
                "stats": {
                    "mean_roundtrip_ms": 29.7,
                    "backend_counts": {"cpu": 8},
                },
            },
            {
                "name": "auto_default",
                "stats": {
                    "mean_roundtrip_ms": 33.6,
                    "backend_counts": {"cpu": 8},
                },
            },
        ],
    }

    failures = evaluate_gate(
        report,
        GateThresholds(min_cpu_to_auto_speedup=0.95, min_cpu_to_gpu_speedup=1.1),
    )
    assert len(failures) == 3
    assert any(
        failure == "gpu_preferred scenario did not execute on GPU backend"
        for failure in failures
    )
