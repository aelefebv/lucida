from __future__ import annotations

import pytest

from lucida.errors import LucidaError


def test_create_session_returns_unique_ids(dataset_service) -> None:
    first = dataset_service.create_session()
    second = dataset_service.create_session()

    assert first.schema_version == 1
    assert second.schema_version == 1
    assert first.session_id != second.session_id
    assert first.created_at is not None
    assert second.created_at is not None


def test_open_dataset_without_session_uses_compat_session(dataset_service, local_omezarr_uri: str) -> None:
    open_response = dataset_service.open_dataset(uri=local_omezarr_uri)
    view_response = dataset_service.create_view(dataset_id=open_response.dataset_summary.dataset_id)

    assert view_response.view_state.mode == "2d"
    assert view_response.view_state.state_version == 0
    assert view_response.view_state.state_hash
    assert view_response.selectors_applied


def test_create_view_unknown_session_error(dataset_service, local_omezarr_uri: str) -> None:
    open_response = dataset_service.open_dataset(uri=local_omezarr_uri)

    with pytest.raises(LucidaError) as error:
        dataset_service.create_view(
            dataset_id=open_response.dataset_summary.dataset_id,
            session_id="session_missing",
        )

    assert error.value.code == "session_not_found"


def test_create_view_rejects_3d_mode(dataset_service, local_omezarr_uri: str) -> None:
    open_response = dataset_service.open_dataset(uri=local_omezarr_uri)

    with pytest.raises(LucidaError) as error:
        dataset_service.create_view(dataset_id=open_response.dataset_summary.dataset_id, mode="3d")

    assert error.value.code == "unsupported_mode"


def test_selector_clamp_and_strict_modes(dataset_service, local_omezarr_uri: str) -> None:
    session = dataset_service.create_session()
    open_response = dataset_service.open_dataset(
        uri=local_omezarr_uri,
        session_id=session.session_id,
    )
    view = dataset_service.create_view(
        dataset_id=open_response.dataset_summary.dataset_id,
        session_id=session.session_id,
    ).view_state

    index_clamped = dataset_service.update_view(
        view_id=view.view_id,
        session_id=session.session_id,
        patch=[
            {
                "op": "replace",
                "path": "/selectors",
                "value": [{"axis": "z", "kind": "index", "index": 999, "clamp": True}],
            }
        ],
    )
    assert index_clamped.selectors_applied[0].index == 3

    range_clamped = dataset_service.update_view(
        view_id=view.view_id,
        session_id=session.session_id,
        patch=[
            {
                "op": "replace",
                "path": "/selectors",
                "value": [{"axis": "z", "kind": "range", "start": 100, "end_exclusive": 200, "clamp": True}],
            }
        ],
    )
    assert range_clamped.selectors_applied[0].start == 3
    assert range_clamped.selectors_applied[0].end_exclusive == 4

    set_clamped = dataset_service.update_view(
        view_id=view.view_id,
        session_id=session.session_id,
        patch=[
            {
                "op": "replace",
                "path": "/selectors",
                "value": [{"axis": "z", "kind": "set", "indices": [-1, 2, 200, 2], "clamp": True}],
            }
        ],
    )
    assert set_clamped.selectors_applied[0].indices == [0, 2, 3]

    with pytest.raises(LucidaError) as strict_index_error:
        dataset_service.update_view(
            view_id=view.view_id,
            session_id=session.session_id,
            patch=[
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 999, "clamp": False}],
                }
            ],
        )
    assert strict_index_error.value.code == "selector_out_of_bounds"

    with pytest.raises(LucidaError) as strict_range_error:
        dataset_service.update_view(
            view_id=view.view_id,
            session_id=session.session_id,
            patch=[
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "range", "start": 5, "end_exclusive": 6, "clamp": False}],
                }
            ],
        )
    assert strict_range_error.value.code == "selector_out_of_bounds"

    with pytest.raises(LucidaError) as strict_set_error:
        dataset_service.update_view(
            view_id=view.view_id,
            session_id=session.session_id,
            patch=[
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "set", "indices": [999], "clamp": False}],
                }
            ],
        )
    assert strict_set_error.value.code == "selector_out_of_bounds"


def test_update_view_invalid_patch_error(dataset_service, local_omezarr_uri: str) -> None:
    open_response = dataset_service.open_dataset(uri=local_omezarr_uri)
    view = dataset_service.create_view(dataset_id=open_response.dataset_summary.dataset_id).view_state

    with pytest.raises(LucidaError) as error:
        dataset_service.update_view(
            view_id=view.view_id,
            patch=[{"op": "replace", "path": "/selectors/100/index", "value": 1}],
        )

    assert error.value.code == "invalid_patch"


def test_state_version_and_hash_change(dataset_service, local_omezarr_uri: str) -> None:
    open_response = dataset_service.open_dataset(uri=local_omezarr_uri)
    created = dataset_service.create_view(dataset_id=open_response.dataset_summary.dataset_id).view_state

    first_update = dataset_service.update_view(
        view_id=created.view_id,
        patch=[
            {
                "op": "replace",
                "path": "/selectors",
                "value": [{"axis": "z", "kind": "index", "index": 1, "clamp": True}],
            }
        ],
    ).view_state
    second_update = dataset_service.update_view(
        view_id=created.view_id,
        patch=[
            {
                "op": "replace",
                "path": "/selectors",
                "value": [{"axis": "z", "kind": "index", "index": 2, "clamp": True}],
            }
        ],
    ).view_state

    assert created.state_version == 0
    assert first_update.state_version == 1
    assert second_update.state_version == 2
    assert created.state_hash != first_update.state_hash
    assert first_update.state_hash != second_update.state_hash

