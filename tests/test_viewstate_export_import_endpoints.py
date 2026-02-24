from __future__ import annotations

import copy


def _create_endpoint_view(api_client, uri: str) -> tuple[str, str, str]:
    session_response = api_client.post("/session/create", json={"schema_version": 1})
    session_id = session_response.json()["session_id"]
    open_response = api_client.post(
        "/dataset/open",
        json={"schema_version": 1, "uri": uri, "session_id": session_id},
    )
    dataset_id = open_response.json()["dataset_summary"]["dataset_id"]
    create_response = api_client.post(
        "/view/create",
        json={
            "schema_version": 1,
            "session_id": session_id,
            "dataset_id": dataset_id,
            "mode": "2d",
        },
    )
    view_id = create_response.json()["view_state"]["view_id"]
    return session_id, dataset_id, view_id


def test_export_import_viewstate_roundtrip_endpoint(api_client, local_omezarr_uri: str) -> None:
    session_id, _, view_id = _create_endpoint_view(api_client, local_omezarr_uri)

    exported = api_client.post(
        "/export/viewstate",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "session_id": session_id,
        },
    )
    assert exported.status_code == 200
    export_payload = exported.json()
    assert export_payload["schema_version"] == 1
    assert export_payload["export_id"].startswith("exp_")
    assert export_payload["source_view_id"] == view_id
    assert export_payload["view_state"]["view_id"] == view_id

    imported = api_client.post(
        "/import/viewstate",
        json={
            "schema_version": 1,
            "session_id": session_id,
            "view_state": export_payload["view_state"],
        },
    )
    assert imported.status_code == 200
    import_payload = imported.json()
    assert import_payload["schema_version"] == 1
    assert import_payload["import_id"].startswith("imp_")
    assert import_payload["imported_from_view_id"] == view_id
    assert import_payload["view_state"]["view_id"] != view_id
    assert import_payload["view_state"]["session_id"] == session_id
    assert import_payload["view_state"]["state_version"] == 0
    assert import_payload["view_state"]["state_hash"]
    assert import_payload["selectors_applied"]


def test_export_viewstate_endpoint_session_guards(api_client, local_omezarr_uri: str) -> None:
    session_id, _, view_id = _create_endpoint_view(api_client, local_omezarr_uri)

    unknown_session = api_client.post(
        "/export/viewstate",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "session_id": "session_missing",
        },
    )
    assert unknown_session.status_code == 404
    assert unknown_session.json()["code"] == "session_not_found"

    other_session_id = api_client.post("/session/create", json={"schema_version": 1}).json()["session_id"]
    scoped_missing = api_client.post(
        "/export/viewstate",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "session_id": other_session_id,
        },
    )
    assert scoped_missing.status_code == 404
    assert scoped_missing.json()["code"] == "view_not_found"

    valid = api_client.post(
        "/export/viewstate",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "session_id": session_id,
        },
    )
    assert valid.status_code == 200


def test_import_viewstate_endpoint_error_contract(api_client, local_omezarr_uri: str) -> None:
    session_id, _, view_id = _create_endpoint_view(api_client, local_omezarr_uri)
    exported_payload = api_client.post(
        "/export/viewstate",
        json={"schema_version": 1, "view_id": view_id, "session_id": session_id},
    ).json()
    source_view_state = exported_payload["view_state"]

    missing_dataset_state = copy.deepcopy(source_view_state)
    missing_dataset_state["datasets"][0]["dataset_id"] = "ds_missing"
    for layer in missing_dataset_state["layers"]:
        if layer.get("dataset_id") is not None:
            layer["dataset_id"] = "ds_missing"
    missing_dataset = api_client.post(
        "/import/viewstate",
        json={"schema_version": 1, "session_id": session_id, "view_state": missing_dataset_state},
    )
    assert missing_dataset.status_code == 404
    assert missing_dataset.json()["code"] == "dataset_not_found"

    unsupported_mode_state = copy.deepcopy(source_view_state)
    unsupported_mode_state["mode"] = "3d"
    unsupported_mode_state["view_3d"] = {}
    unsupported_mode = api_client.post(
        "/import/viewstate",
        json={"schema_version": 1, "session_id": session_id, "view_state": unsupported_mode_state},
    )
    assert unsupported_mode.status_code == 422
    assert unsupported_mode.json()["code"] == "unsupported_mode"

    multi_dataset_state = copy.deepcopy(source_view_state)
    multi_dataset_state["datasets"] = [
        *multi_dataset_state["datasets"],
        copy.deepcopy(multi_dataset_state["datasets"][0]),
    ]
    multi_dataset = api_client.post(
        "/import/viewstate",
        json={"schema_version": 1, "session_id": session_id, "view_state": multi_dataset_state},
    )
    assert multi_dataset.status_code == 422
    assert multi_dataset.json()["code"] == "invalid_viewstate_import"

    layer_mismatch_state = copy.deepcopy(source_view_state)
    layer_mismatch_state["layers"][0]["dataset_id"] = "ds_other"
    layer_mismatch = api_client.post(
        "/import/viewstate",
        json={"schema_version": 1, "session_id": session_id, "view_state": layer_mismatch_state},
    )
    assert layer_mismatch.status_code == 422
    assert layer_mismatch.json()["code"] == "invalid_viewstate_import"


def test_import_viewstate_endpoint_compat_session(api_client, local_omezarr_uri: str) -> None:
    session_id, _, view_id = _create_endpoint_view(api_client, local_omezarr_uri)
    exported_payload = api_client.post(
        "/export/viewstate",
        json={"schema_version": 1, "view_id": view_id, "session_id": session_id},
    ).json()

    imported = api_client.post(
        "/import/viewstate",
        json={"schema_version": 1, "view_state": exported_payload["view_state"]},
    )
    assert imported.status_code == 200
    payload = imported.json()
    assert payload["view_state"]["session_id"].startswith("compat_")
    assert payload["view_state"]["view_id"] != view_id
