from __future__ import annotations

from lucida.client import LucidaClient


def test_client_export_import_viewstate(
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

        exported = client.export_viewstate(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
        )
        assert exported.export_id.startswith("exp_")
        assert exported.source_view_id == created.view_state.view_id
        assert exported.view_state.view_id == created.view_state.view_id

        imported_model = client.import_viewstate(
            view_state=exported.view_state,
            session_id=session.session_id,
        )
        assert imported_model.import_id.startswith("imp_")
        assert imported_model.imported_from_view_id == created.view_state.view_id
        assert imported_model.view_state.view_id != created.view_state.view_id
        assert imported_model.view_state.session_id == session.session_id
        assert imported_model.view_state.state_version == 0
        assert imported_model.view_state.state_hash

        imported_dict = client.import_viewstate(
            view_state=exported.view_state.model_dump(mode="json"),
        )
        assert imported_dict.view_state.view_id not in {
            created.view_state.view_id,
            imported_model.view_state.view_id,
        }
        assert imported_dict.view_state.session_id.startswith("compat_")
