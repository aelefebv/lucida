from __future__ import annotations

import pytest

from lucida.errors import LucidaError
from lucida.io.uri import normalize_uri
from lucida.service.dataset_service import DatasetService, generate_dataset_id
from conftest import create_sample_omezarr


def test_open_dataset_local_path_success(local_omezarr_uri: str) -> None:
    service = DatasetService()
    response = service.open_dataset(uri=local_omezarr_uri)
    summary = response.dataset_summary

    assert summary.schema_version == 1
    assert summary.uri == normalize_uri(local_omezarr_uri)
    assert summary.dataset_id == generate_dataset_id(summary.uri)
    assert summary.shape == [1, 2, 4, 8, 10]
    assert summary.dtype == "uint16"
    assert [axis.role for axis in summary.axes] == ["t", "c", "z", "y", "x"]
    assert summary.hints is not None
    assert summary.hints.is_remote is False
    assert summary.hints.recommended_tile_px == (64, 64)
    assert len(summary.multiscales) == 1
    assert len(summary.multiscales[0].levels) == 2
    assert response.warnings == []


def test_open_dataset_memory_uri_marks_remote(memory_omezarr_uri: str) -> None:
    service = DatasetService()
    response = service.open_dataset(uri=memory_omezarr_uri)
    summary = response.dataset_summary

    assert summary.uri == memory_omezarr_uri
    assert summary.hints is not None
    assert summary.hints.is_remote is True
    assert summary.dataset_id == generate_dataset_id(memory_omezarr_uri)


def test_open_dataset_tolerant_fallback_emits_warnings(tolerant_omezarr_uri: str) -> None:
    service = DatasetService()
    response = service.open_dataset(uri=tolerant_omezarr_uri)
    warning_codes = {warning.code for warning in response.warnings}

    assert response.dataset_summary.multiscales[0].name == "multiscale_0"
    assert "multiscale_name_inferred" in warning_codes
    assert "downsample_factors_inferred" in warning_codes
    assert "channel_index_inferred" in warning_codes


def test_raw_metadata_policy_subset_and_full(tmp_path_factory: pytest.TempPathFactory) -> None:
    dataset_path = tmp_path_factory.mktemp("raw-meta") / "sample.zarr"
    uri = create_sample_omezarr(str(dataset_path), extra_root_attrs={"custom_attr": "present"})
    service = DatasetService()

    default_response = service.open_dataset(uri=uri, include_full_raw_metadata=False)
    full_response = service.open_dataset(uri=uri, include_full_raw_metadata=True)

    default_root = default_response.dataset_summary.raw_metadata["root"]
    full_root = full_response.dataset_summary.raw_metadata["root"]

    assert "custom_attr" not in default_root
    assert "custom_attr" in full_root
    assert "multiscales" in default_root
    assert "omero" in default_root


def test_open_dataset_invalid_metadata_error(invalid_omezarr_uri: str) -> None:
    service = DatasetService()

    with pytest.raises(LucidaError) as error:
        service.open_dataset(uri=invalid_omezarr_uri)

    assert error.value.code == "invalid_omezarr"
    assert error.value.message
    assert "uri" in error.value.details
