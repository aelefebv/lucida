from __future__ import annotations

import copy
import os
from pathlib import Path

from parity.data_setup import build_phase1_dataset_uris
from parity.fixtures_io import load_fixture_cases, write_fixture_cases
from parity.harness import create_backend_adapter, run_milestone2_cases
from parity.models import NormalizedCaseResult
from parity.normalization import normalize_cases

MILESTONE2_FIXTURE_PATH = (
    Path(__file__).resolve().parent
    / "parity"
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


def test_milestone2_viewstate_parity(tmp_path: Path, request) -> None:
    backend = os.getenv("LUCIDA_TEST_BACKEND", "rust").strip().lower()
    base_url = os.getenv("LUCIDA_TEST_BASE_URL")
    if backend == "rust" and not base_url:
        base_url = request.getfixturevalue("rust_daemon_base_url")
    regenerate = os.getenv("LUCIDA_REGEN_MILESTONE2_FIXTURES") == "1"

    adapter = create_backend_adapter(backend, base_url=base_url)
    try:
        dataset_uris = build_phase1_dataset_uris(tmp_path / "datasets")
        raw_cases = run_milestone2_cases(adapter=adapter, dataset_uris=dataset_uris)
    finally:
        adapter.close()

    normalized_cases = normalize_cases(raw_cases)

    if regenerate:
        if backend != "python":
            raise AssertionError("Fixture regeneration is only supported for backend=python.")
        write_fixture_cases(normalized_cases, MILESTONE2_FIXTURE_PATH)

    expected_cases = load_fixture_cases(MILESTONE2_FIXTURE_PATH)
    assert len(normalized_cases) == len(expected_cases)
    for actual, expected in zip(normalized_cases, expected_cases, strict=True):
        assert actual.name == expected.name
        assert _case_to_dict(actual) == _case_to_dict(expected)
