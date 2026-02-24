from __future__ import annotations

import copy

import pytest

from lucida.errors import LucidaError
from lucida.models.view_state import ViewState


def _create_session_bound_view(dataset_service, uri: str) -> tuple[str, str, ViewState]:
    session = dataset_service.create_session()
    opened = dataset_service.open_dataset(uri=uri, session_id=session.session_id)
    created = dataset_service.create_view(
        dataset_id=opened.dataset_summary.dataset_id,
        session_id=session.session_id,
    )
    return session.session_id, opened.dataset_summary.dataset_id, created.view_state


def test_export_viewstate_success(dataset_service, local_omezarr_uri: str) -> None:
    session_id, _, view_state = _create_session_bound_view(dataset_service, local_omezarr_uri)

    exported = dataset_service.export_viewstate(view_id=view_state.view_id, session_id=session_id)

    assert exported.schema_version == 1
    assert exported.export_id.startswith("exp_")
    assert exported.exported_at is not None
    assert exported.source_view_id == view_state.view_id
    assert exported.view_state.model_dump(mode="json") == view_state.model_dump(mode="json")


def test_export_viewstate_session_guards(dataset_service, local_omezarr_uri: str) -> None:
    session_id, _, view_state = _create_session_bound_view(dataset_service, local_omezarr_uri)

    with pytest.raises(LucidaError) as unknown_session_error:
        dataset_service.export_viewstate(view_id=view_state.view_id, session_id="session_missing")
    assert unknown_session_error.value.code == "session_not_found"

    other_session = dataset_service.create_session()
    with pytest.raises(LucidaError) as scoped_missing_error:
        dataset_service.export_viewstate(
            view_id=view_state.view_id,
            session_id=other_session.session_id,
        )
    assert scoped_missing_error.value.code == "view_not_found"

    exported = dataset_service.export_viewstate(view_id=view_state.view_id, session_id=session_id)
    assert exported.source_view_id == view_state.view_id


def test_import_viewstate_success_rebases_identity(dataset_service, local_omezarr_uri: str) -> None:
    session_id, _, source_view = _create_session_bound_view(dataset_service, local_omezarr_uri)
    exported = dataset_service.export_viewstate(view_id=source_view.view_id, session_id=session_id)

    imported = dataset_service.import_viewstate(
        view_state=exported.view_state,
        session_id=session_id,
    )

    assert imported.schema_version == 1
    assert imported.import_id.startswith("imp_")
    assert imported.imported_from_view_id == source_view.view_id
    assert imported.view_state.view_id != source_view.view_id
    assert imported.view_state.session_id == session_id
    assert imported.view_state.state_version == 0
    assert imported.view_state.state_hash
    assert imported.selectors_applied


def test_import_viewstate_compat_session_and_dataset_attach(
    dataset_service, local_omezarr_uri: str
) -> None:
    source_session_id, dataset_id, source_view = _create_session_bound_view(
        dataset_service, local_omezarr_uri
    )
    exported = dataset_service.export_viewstate(view_id=source_view.view_id, session_id=source_session_id)

    target_session = dataset_service.create_session()
    imported_scoped = dataset_service.import_viewstate(
        view_state=exported.view_state,
        session_id=target_session.session_id,
    )
    assert imported_scoped.view_state.session_id == target_session.session_id
    assert dataset_id in dataset_service.sessions_by_id[target_session.session_id].dataset_ids

    imported_compat = dataset_service.import_viewstate(view_state=exported.view_state)
    assert imported_compat.view_state.session_id.startswith("compat_")


def test_import_viewstate_error_contracts(dataset_service, local_omezarr_uri: str) -> None:
    session_id, _, source_view = _create_session_bound_view(dataset_service, local_omezarr_uri)
    exported = dataset_service.export_viewstate(view_id=source_view.view_id, session_id=session_id)

    missing_dataset_payload = exported.view_state.model_dump(mode="json")
    missing_dataset_payload["datasets"][0]["dataset_id"] = "ds_missing"
    for layer in missing_dataset_payload["layers"]:
        if layer.get("dataset_id") is not None:
            layer["dataset_id"] = "ds_missing"
    missing_dataset_view = ViewState.model_validate(missing_dataset_payload)
    with pytest.raises(LucidaError) as missing_dataset_error:
        dataset_service.import_viewstate(view_state=missing_dataset_view, session_id=session_id)
    assert missing_dataset_error.value.code == "dataset_not_found"

    unsupported_mode_payload = exported.view_state.model_dump(mode="json")
    unsupported_mode_payload["mode"] = "3d"
    unsupported_mode_payload["view_3d"] = {}
    unsupported_mode_view = ViewState.model_validate(unsupported_mode_payload)
    with pytest.raises(LucidaError) as unsupported_mode_error:
        dataset_service.import_viewstate(view_state=unsupported_mode_view, session_id=session_id)
    assert unsupported_mode_error.value.code == "unsupported_mode"

    multi_dataset_payload = exported.view_state.model_dump(mode="json")
    multi_dataset_payload["datasets"] = [
        *multi_dataset_payload["datasets"],
        copy.deepcopy(multi_dataset_payload["datasets"][0]),
    ]
    multi_dataset_view = ViewState.model_validate(multi_dataset_payload)
    with pytest.raises(LucidaError) as multi_dataset_error:
        dataset_service.import_viewstate(view_state=multi_dataset_view, session_id=session_id)
    assert multi_dataset_error.value.code == "invalid_viewstate_import"

    layer_mismatch_payload = exported.view_state.model_dump(mode="json")
    layer_mismatch_payload["layers"][0]["dataset_id"] = "ds_other"
    layer_mismatch_view = ViewState.model_validate(layer_mismatch_payload)
    with pytest.raises(LucidaError) as layer_scope_error:
        dataset_service.import_viewstate(view_state=layer_mismatch_view, session_id=session_id)
    assert layer_scope_error.value.code == "invalid_viewstate_import"
