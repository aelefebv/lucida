#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


REQUIRED_METRIC_KEYS = {
    "first_paint_latency_ms",
    "refinement_latency_ms",
    "interaction_recovery_latency_ms",
    "tile_request_count",
    "cancellation_count",
}

REQUIRED_THRESHOLD_KEYS = {
    "first_paint_latency_ms_max",
    "refinement_latency_ms_max",
    "interaction_recovery_latency_ms_max",
    "tile_request_count_min",
    "cancellation_count_min",
}


def load_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    metrics = report.get("responsiveness_metrics")
    thresholds = report.get("responsiveness_thresholds")
    thresholds_passed = report.get("responsiveness_thresholds_passed")

    if not isinstance(metrics, dict):
        errors.append("missing or invalid `responsiveness_metrics` object")
    else:
        missing_metric_keys = REQUIRED_METRIC_KEYS - set(metrics.keys())
        if missing_metric_keys:
            errors.append(
                "missing responsiveness metric keys: "
                + ", ".join(sorted(missing_metric_keys))
            )

    if not isinstance(thresholds, dict):
        errors.append("missing or invalid `responsiveness_thresholds` object")
    else:
        missing_threshold_keys = REQUIRED_THRESHOLD_KEYS - set(thresholds.keys())
        if missing_threshold_keys:
            errors.append(
                "missing responsiveness threshold keys: "
                + ", ".join(sorted(missing_threshold_keys))
            )

    if thresholds_passed is not True:
        errors.append("`responsiveness_thresholds_passed` must be true")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--report-path",
        type=Path,
        required=True,
        help="path to acceptance report JSON",
    )
    args = parser.parse_args()
    report = load_report(args.report_path)
    errors = validate_report(report)
    if errors:
        for error in errors:
            print(f"error: {error}")
        return 1
    print("S1 acceptance report schema and thresholds are valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
