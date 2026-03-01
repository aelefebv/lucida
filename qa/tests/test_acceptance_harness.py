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
