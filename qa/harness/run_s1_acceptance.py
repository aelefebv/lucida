#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT_PATH = REPO_ROOT / "qa" / "reports" / "s1_acceptance_report.json"
RESPONSIVENESS_THRESHOLDS = {
    "first_paint_latency_ms_max": 20_000.0,
    "refinement_latency_ms_max": 20_000.0,
    "interaction_recovery_latency_ms_max": 20_000.0,
    "tile_request_count_min": 0,
    "cancellation_count_min": 0,
}


@dataclass(frozen=True)
class AcceptanceStep:
    name: str
    command: list[str]
    cwd: Path


@dataclass(frozen=True)
class AcceptanceCase:
    test_id: str
    description: str
    command: list[str]
    cwd: Path


def build_steps() -> list[AcceptanceStep]:
    return [
        AcceptanceStep(
            name="generate_fixtures",
            command=[
                "python3",
                "qa/fixtures/generate_synthetic_corpus.py",
                "--output-root",
                "qa/fixtures/corpus",
            ],
            cwd=REPO_ROOT,
        ),
    ]


def build_acceptance_cases() -> list[AcceptanceCase]:
    return [
        AcceptanceCase(
            test_id="T-M1-01",
            description="Attach + snapshot + ordered event stream",
            command=[
                "sh",
                "-c",
                "cd engine && cargo test --test runtime_integration runtime_supports_attach_command_events_and_reconnect -- --exact",
            ],
            cwd=REPO_ROOT,
        ),
        AcceptanceCase(
            test_id="T-M1-02",
            description="Runtime-backed source open plus source-derived preview/refinement payloads",
            command=[
                "sh",
                "-c",
                "cd engine && cargo test --test runtime_integration runtime_open_source_emits_progress_and_serves_source_derived_preview_and_tile -- --exact",
            ],
            cwd=REPO_ROOT,
        ),
        AcceptanceCase(
            test_id="T-M1-03",
            description="Interactive pan/zoom/z/t/channel loop with client isolation",
            command=[
                "sh",
                "-c",
                "cd client-web && npm run test -- test/viewer-runtime-interaction.test.ts -t \"keeps interactions scoped to the initiating client\"",
            ],
            cwd=REPO_ROOT,
        ),
        AcceptanceCase(
            test_id="T-M1-04",
            description="Reconnect snapshot/event rehydration recovery",
            command=[
                "sh",
                "-c",
                "cd client-web && npm run test -- test/viewer-runtime-interaction.test.ts -t \"reconnects and rehydrates authoritative state after transport drop\"",
            ],
            cwd=REPO_ROOT,
        ),
        AcceptanceCase(
            test_id="T-M1-05",
            description="No mixed-generation frame behavior in 2D loop",
            command=[
                "sh",
                "-c",
                "cd client-web && npm run test -- test/generation-consistency.test.ts",
            ],
            cwd=REPO_ROOT,
        ),
    ]


def run_command(
    name: str,
    command: list[str],
    cwd: Path,
    dry_run: bool,
) -> dict[str, Any]:
    if dry_run:
        return {
            "name": name,
            "status": "skipped",
            "duration_seconds": 0.0,
            "command": command,
        }

    started_at = time.time()
    completed = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    status = "passed" if completed.returncode == 0 else "failed"
    return {
        "name": name,
        "status": status,
        "duration_seconds": round(time.time() - started_at, 3),
        "command": command,
        "stdout_tail": completed.stdout[-2000:],
        "stderr_tail": completed.stderr[-2000:],
    }


def duration_milliseconds_by_case(
    case_report: list[dict[str, Any]],
    case_id: str,
) -> float:
    for case in case_report:
        if case.get("id") == case_id:
            return round(float(case.get("duration_seconds", 0.0)) * 1000.0, 3)
    return 0.0


def count_case_output_matches(
    case_report: list[dict[str, Any]],
    pattern: re.Pattern[str],
) -> int:
    total = 0
    for case in case_report:
        stdout_tail = str(case.get("stdout_tail", ""))
        stderr_tail = str(case.get("stderr_tail", ""))
        total += len(pattern.findall(stdout_tail))
        total += len(pattern.findall(stderr_tail))
    return total


def build_responsiveness_metrics(case_report: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "first_paint_latency_ms": duration_milliseconds_by_case(case_report, "T-M1-02"),
        "refinement_latency_ms": duration_milliseconds_by_case(case_report, "T-M1-03"),
        "interaction_recovery_latency_ms": duration_milliseconds_by_case(
            case_report, "T-M1-04"
        ),
        "tile_request_count": count_case_output_matches(
            case_report,
            re.compile(r"tile2d|/v1/tile2d/", re.IGNORECASE),
        ),
        "cancellation_count": count_case_output_matches(
            case_report,
            re.compile(r"cancel|abort|invalidat|supersed", re.IGNORECASE),
        ),
    }


def responsiveness_thresholds_pass(
    metrics: dict[str, Any],
    thresholds: dict[str, float | int],
) -> bool:
    return (
        float(metrics["first_paint_latency_ms"])
        <= float(thresholds["first_paint_latency_ms_max"])
        and float(metrics["refinement_latency_ms"])
        <= float(thresholds["refinement_latency_ms_max"])
        and float(metrics["interaction_recovery_latency_ms"])
        <= float(thresholds["interaction_recovery_latency_ms_max"])
        and int(metrics["tile_request_count"]) >= int(thresholds["tile_request_count_min"])
        and int(metrics["cancellation_count"]) >= int(thresholds["cancellation_count_min"])
    )


def run_harness(dry_run: bool, report_path: Path) -> dict[str, Any]:
    started_at = time.time()
    steps_report: list[dict[str, Any]] = []
    case_report: list[dict[str, Any]] = []
    success = True

    for step in build_steps():
        result = run_command(step.name, step.command, step.cwd, dry_run)
        steps_report.append(result)
        if result["status"] == "failed":
            success = False
            break

    if success:
        for case in build_acceptance_cases():
            result = run_command(case.test_id, case.command, case.cwd, dry_run)
            case_report.append(
                {
                    "id": case.test_id,
                    "description": case.description,
                    **result,
                }
            )
            if result["status"] == "failed":
                success = False

    case_statuses = [case["status"] for case in case_report]
    passed_cases = sum(1 for status in case_statuses if status == "passed")
    failed_cases = sum(1 for status in case_statuses if status == "failed")
    skipped_cases = sum(1 for status in case_statuses if status == "skipped")
    responsiveness_metrics = build_responsiveness_metrics(case_report)
    responsiveness_thresholds_passed = responsiveness_thresholds_pass(
        responsiveness_metrics,
        RESPONSIVENESS_THRESHOLDS,
    )
    success = success and responsiveness_thresholds_passed

    report = {
        "milestone": "S1",
        "generated_at_unix": int(time.time()),
        "duration_seconds": round(time.time() - started_at, 3),
        "dry_run": dry_run,
        "success": success,
        "steps": steps_report,
        "acceptance_cases": case_report,
        "acceptance_summary": {
            "total": len(case_report),
            "passed": passed_cases,
            "failed": failed_cases,
            "skipped": skipped_cases,
        },
        "responsiveness_metrics": responsiveness_metrics,
        "responsiveness_thresholds": RESPONSIVENESS_THRESHOLDS,
        "responsiveness_thresholds_passed": responsiveness_thresholds_passed,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--report-path",
        type=Path,
        default=DEFAULT_REPORT_PATH,
        help="path to write acceptance report JSON",
    )
    args = parser.parse_args()
    report = run_harness(dry_run=args.dry_run, report_path=args.report_path)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
