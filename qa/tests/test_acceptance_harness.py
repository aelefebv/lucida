from __future__ import annotations

import json
import subprocess
from pathlib import Path


def test_acceptance_harness_generates_structured_report(tmp_path: Path) -> None:
    report_path = tmp_path / "report.json"
    subprocess.run(
        [
            "python3",
            "qa/harness/run_s1_acceptance.py",
            "--dry-run",
            "--report-path",
            str(report_path),
        ],
        check=True,
        cwd=Path(__file__).resolve().parents[2],
    )

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["milestone"] == "S1"
    assert report["dry_run"] is True
    assert isinstance(report["steps"], list)
    assert report["steps"][0]["name"] == "generate_fixtures"
    assert all(step["status"] == "skipped" for step in report["steps"])
    assert [case["id"] for case in report["acceptance_cases"]] == [
        "T-M1-01",
        "T-M1-02",
        "T-M1-03",
        "T-M1-04",
        "T-M1-05",
    ]
    assert all(case["status"] == "skipped" for case in report["acceptance_cases"])
    metrics = report["responsiveness_metrics"]
    assert set(metrics.keys()) == {
        "first_paint_latency_ms",
        "refinement_latency_ms",
        "interaction_recovery_latency_ms",
        "tile_request_count",
        "cancellation_count",
    }
    assert isinstance(metrics["first_paint_latency_ms"], (int, float))
    assert isinstance(metrics["refinement_latency_ms"], (int, float))
    assert isinstance(metrics["interaction_recovery_latency_ms"], (int, float))
    assert isinstance(metrics["tile_request_count"], int)
    assert isinstance(metrics["cancellation_count"], int)

    thresholds = report["responsiveness_thresholds"]
    assert set(thresholds.keys()) == {
        "first_paint_latency_ms_max",
        "refinement_latency_ms_max",
        "interaction_recovery_latency_ms_max",
        "tile_request_count_min",
        "cancellation_count_min",
    }
    assert report["responsiveness_thresholds_passed"] is True


def test_acceptance_harness_report_validator_accepts_generated_report(
    tmp_path: Path,
) -> None:
    report_path = tmp_path / "report.json"
    root = Path(__file__).resolve().parents[2]
    subprocess.run(
        [
            "python3",
            "qa/harness/run_s1_acceptance.py",
            "--dry-run",
            "--report-path",
            str(report_path),
        ],
        check=True,
        cwd=root,
    )
    subprocess.run(
        [
            "python3",
            "qa/harness/validate_s1_report.py",
            "--report-path",
            str(report_path),
        ],
        check=True,
        cwd=root,
    )
