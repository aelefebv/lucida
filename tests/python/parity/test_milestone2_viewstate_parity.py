from __future__ import annotations

import copy
from pathlib import Path

from parity.data_setup import build_phase1_dataset_uris
from parity.fixtures_io import load_fixture_cases
from parity.harness import create_backend_adapter, run_milestone2_cases
from parity.models import NormalizedCaseResult
from parity.normalization import normalize_cases

MILESTONE2_FIXTURE_PATH = (
    Path(__file__).resolve().parent
    / "fixtures"
    / "milestone2"
    / "viewstate_corpus.json"
)


def _case_to_dict(case: NormalizedCaseResult) -> dict[str, object]:
    body = copy.deepcopy(case.body)
    if body.get("code") == "invalid_patch" and isinstance(body.get("details"), dict):
        if "reason" in body["details"]:
            body["details"]["reason"] = "<invalid_patch_reason>"
    return {
        "name": case.name,
        "method": case.method,
        "path": case.path,
        "status_code": case.status_code,
        "body": body,
    }


def test_milestone2_viewstate_parity(tmp_path: Path, rust_daemon_base_url: str) -> None:
    adapter = create_backend_adapter("rust", base_url=rust_daemon_base_url)
    try:
        dataset_uris = build_phase1_dataset_uris(tmp_path / "datasets")
        raw_cases = run_milestone2_cases(adapter=adapter, dataset_uris=dataset_uris)
    finally:
        adapter.close()

    normalized_cases = normalize_cases(raw_cases)
    expected_cases = load_fixture_cases(MILESTONE2_FIXTURE_PATH)
    assert len(normalized_cases) == len(expected_cases)
    for actual, expected in zip(normalized_cases, expected_cases, strict=True):
        assert actual.name == expected.name
        assert _case_to_dict(actual) == _case_to_dict(expected)
