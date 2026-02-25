from __future__ import annotations

import pytest

from lucida.client import LucidaClient, LucidaClientError


def test_client_session_view_selector_flow(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    with LucidaClient(base_url=rust_daemon_base_url) as client:
        session = client.create_session()
        opened = client.open_dataset(uri=local_omezarr_uri, session_id=session.session_id)
        created = client.create_view(
            dataset_id=opened.dataset_summary.dataset_id,
            session_id=session.session_id,
            mode="2d",
        )

        assert created.view_state.state_version == 0
        assert created.view_state.state_hash

        updated_index = client.set_dim(
            view_id=created.view_state.view_id,
            axis="z",
            index=2,
            session_id=session.session_id,
            clamp=True,
        )
        assert updated_index.view_state.state_version == 1
        z_selector = next(item for item in updated_index.selectors_applied if item.axis == "z")
        assert z_selector.index == 2

        updated_range = client.set_axis_range(
            view_id=created.view_state.view_id,
            axis="z",
            start=1,
            end_exclusive=4,
            session_id=session.session_id,
            clamp=True,
        )
        assert updated_range.view_state.state_version == 2
        z_range_selector = next(item for item in updated_range.selectors_applied if item.axis == "z")
        assert z_range_selector.start == 1
        assert z_range_selector.end_exclusive == 4

        updated_set = client.set_axis_set(
            view_id=created.view_state.view_id,
            axis="z",
            indices=[0, 2, 2, 3],
            session_id=session.session_id,
            clamp=True,
        )
        assert updated_set.view_state.state_version == 3
        z_set_selector = next(item for item in updated_set.selectors_applied if item.axis == "z")
        assert z_set_selector.indices == [0, 2, 3]

        fetched = client.get_view(view_id=created.view_state.view_id, session_id=session.session_id)
        assert fetched.view_state.state_version == 3


def test_client_update_view_expected_state_version_conflict(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    with LucidaClient(base_url=rust_daemon_base_url) as client:
        opened = client.open_dataset(uri=local_omezarr_uri)
        created = client.create_view(dataset_id=opened.dataset_summary.dataset_id, mode="2d")

        first = client.update_view(
            view_id=created.view_state.view_id,
            expected_state_version=0,
            patch=[
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 1, "clamp": True}],
                }
            ],
        )
        assert first.view_state.state_version == 1

        with pytest.raises(LucidaClientError) as excinfo:
            client.update_view(
                view_id=created.view_state.view_id,
                expected_state_version=0,
                patch=[
                    {
                        "op": "replace",
                        "path": "/selectors",
                        "value": [{"axis": "z", "kind": "index", "index": 2, "clamp": True}],
                    }
                ],
            )
        assert "state_conflict" in str(excinfo.value)
