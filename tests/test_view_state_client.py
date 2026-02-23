from __future__ import annotations

from fastapi.testclient import TestClient

from lucida.client import LucidaClient
from lucida.server.app import create_app
from lucida.service.dataset_service import DatasetService


def test_client_session_view_selector_flow(local_omezarr_uri: str) -> None:
    service = DatasetService()
    app = create_app(dataset_service=service)
    http_client = TestClient(app)

    try:
        client = LucidaClient(client=http_client)

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
    finally:
        http_client.close()
