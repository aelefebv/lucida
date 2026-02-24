from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from parity.models import NormalizedCaseResult

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "phase1" / "corpus.json"


def load_fixture_cases(path: Path = FIXTURE_PATH) -> list[NormalizedCaseResult]:
    if not path.exists():
        raise FileNotFoundError(f"Parity fixture corpus was not found: {path}")

    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_cases = payload.get("cases")
    if not isinstance(raw_cases, list):
        raise ValueError("Parity fixture corpus is invalid: 'cases' must be a list.")

    cases: list[NormalizedCaseResult] = []
    for item in raw_cases:
        if not isinstance(item, dict):
            raise ValueError("Parity fixture corpus is invalid: each case must be an object.")
        body = item.get("body")
        if not isinstance(body, dict):
            raise ValueError("Parity fixture corpus is invalid: case body must be an object.")
        cases.append(
            NormalizedCaseResult(
                name=str(item["name"]),
                method=str(item["method"]),
                path=str(item["path"]),
                status_code=int(item["status_code"]),
                body=body,
            )
        )
    return cases


def write_fixture_cases(cases: list[NormalizedCaseResult], path: Path = FIXTURE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized_cases: list[dict[str, Any]] = [
        {
            "name": case.name,
            "method": case.method,
            "path": case.path,
            "status_code": case.status_code,
            "body": case.body,
        }
        for case in cases
    ]
    payload = {
        "schema_version": 1,
        "generated_from": "real_http_responses",
        "cases": serialized_cases,
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=False), encoding="utf-8")
