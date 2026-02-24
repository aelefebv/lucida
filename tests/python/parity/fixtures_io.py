from __future__ import annotations

import json
from pathlib import Path

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
