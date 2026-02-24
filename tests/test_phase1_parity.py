from __future__ import annotations

import os
from pathlib import Path

import pytest

from parity.data_setup import build_phase1_dataset_uris
from parity.fixtures_io import FIXTURE_PATH, load_fixture_cases, write_fixture_cases
from parity.harness import create_backend_adapter, run_phase1_cases
from parity.models import NormalizedCaseResult
from parity.normalization import normalize_cases


def _case_to_dict(case: NormalizedCaseResult) -> dict[str, object]:
    return {
        "name": case.name,
        "method": case.method,
        "path": case.path,
        "status_code": case.status_code,
        "body": case.body,
    }


@pytest.mark.parametrize("fixture_path", [FIXTURE_PATH])
def test_phase1_parity_corpus(fixture_path: Path, tmp_path: Path) -> None:
    backend = os.getenv("LUCIDA_TEST_BACKEND", "python").strip().lower()
    base_url = os.getenv("LUCIDA_TEST_BASE_URL")
    regenerate = os.getenv("LUCIDA_REGEN_PARITY_FIXTURES") == "1"

    adapter = create_backend_adapter(backend, base_url=base_url)
    try:
        dataset_uris = build_phase1_dataset_uris(tmp_path / "datasets")
        output_root = Path(__file__).resolve().parents[1] / "output"
        raw_cases = run_phase1_cases(
            adapter=adapter,
            dataset_uris=dataset_uris,
            output_root=output_root,
        )
    finally:
        adapter.close()

    normalized_cases = normalize_cases(raw_cases)

    if regenerate:
        if backend != "python":
            raise AssertionError("Fixture regeneration is only supported for backend=python.")
        write_fixture_cases(normalized_cases, fixture_path)

    expected_cases = load_fixture_cases(fixture_path)
    assert len(normalized_cases) == len(expected_cases)

    for actual, expected in zip(normalized_cases, expected_cases, strict=True):
        assert actual.name == expected.name
        assert _case_to_dict(actual) == _case_to_dict(expected)
