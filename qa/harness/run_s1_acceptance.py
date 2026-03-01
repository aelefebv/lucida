#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT_PATH = REPO_ROOT / "qa" / "reports" / "s1_acceptance_report.json"


@dataclass(frozen=True)
class AcceptanceStep:
    name: str
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
        AcceptanceStep(
            name="engine_checks",
            command=[
                "sh",
                "-c",
                "cd engine && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test --all-targets --all-features",
            ],
            cwd=REPO_ROOT,
        ),
        AcceptanceStep(
            name="client_checks",
            command=[
                "sh",
                "-c",
                "cd client-web && npm run typecheck && npm run test",
            ],
            cwd=REPO_ROOT,
        ),
        AcceptanceStep(
            name="python_checks",
            command=["sh", "-c", "cd python-client && python3 -m pytest -q"],
            cwd=REPO_ROOT,
        ),
        AcceptanceStep(
            name="engine_demo",
            command=["sh", "-c", "cd engine && cargo run --bin s0_demo"],
            cwd=REPO_ROOT,
        ),
    ]


def run_harness(dry_run: bool, report_path: Path) -> dict[str, Any]:
    started_at = time.time()
    steps_report: list[dict[str, Any]] = []
    success = True

    for step in build_steps():
        step_started_at = time.time()
        if dry_run:
            steps_report.append(
                {
                    "name": step.name,
                    "status": "skipped",
                    "duration_seconds": 0.0,
                    "command": step.command,
                }
            )
            continue

        completed = subprocess.run(
            step.command,
            cwd=step.cwd,
            capture_output=True,
            text=True,
        )
        status = "passed" if completed.returncode == 0 else "failed"
        if status == "failed":
            success = False

        steps_report.append(
            {
                "name": step.name,
                "status": status,
                "duration_seconds": round(time.time() - step_started_at, 3),
                "command": step.command,
                "stdout_tail": completed.stdout[-2000:],
                "stderr_tail": completed.stderr[-2000:],
            }
        )
        if completed.returncode != 0:
            break

    report = {
        "milestone": "S1",
        "generated_at_unix": int(time.time()),
        "duration_seconds": round(time.time() - started_at, 3),
        "dry_run": dry_run,
        "success": success,
        "steps": steps_report,
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
