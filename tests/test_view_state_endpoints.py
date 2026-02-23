from __future__ import annotations


def test_session_create_endpoint_success(api_client) -> None:
    response = api_client.post("/session/create", json={"schema_version": 1})
    assert response.status_code == 200

    payload = response.json()
    assert payload["schema_version"] == 1
    assert payload["session_id"]
    assert payload["created_at"]


def test_view_end_to_end_create_update_get(api_client, local_omezarr_uri: str) -> None:
    session_response = api_client.post("/session/create", json={"schema_version": 1})
    session_id = session_response.json()["session_id"]

    open_response = api_client.post(
        "/dataset/open",
        json={"schema_version": 1, "uri": local_omezarr_uri, "session_id": session_id},
    )
    assert open_response.status_code == 200
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
    assert create_response.status_code == 200
    create_payload = create_response.json()
    view_id = create_payload["view_state"]["view_id"]
    first_hash = create_payload["view_state"]["state_hash"]

    update_response = api_client.post(
        "/view/update",
        json={
            "schema_version": 1,
            "session_id": session_id,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 2, "clamp": True}],
                }
            ],
        },
    )
    assert update_response.status_code == 200
    update_payload = update_response.json()
    assert update_payload["view_state"]["state_version"] == 1
    assert update_payload["view_state"]["state_hash"] != first_hash
    assert update_payload["selectors_applied"][0]["index"] == 2

    get_response = api_client.get(f"/view/{view_id}", params={"session_id": session_id})
    assert get_response.status_code == 200
    get_payload = get_response.json()
    assert get_payload["view_state"]["view_id"] == view_id
    assert get_payload["view_state"]["state_version"] == 1


def test_view_create_unknown_dataset_error(api_client) -> None:
    response = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": "ds_missing", "mode": "2d"},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "dataset_not_found"


def test_view_create_unsupported_mode_error(api_client, local_omezarr_uri: str) -> None:
    open_response = api_client.post("/dataset/open", json={"schema_version": 1, "uri": local_omezarr_uri})
    dataset_id = open_response.json()["dataset_summary"]["dataset_id"]

    response = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": dataset_id, "mode": "3d"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "unsupported_mode"


def test_view_update_selector_out_of_bounds_error(api_client, local_omezarr_uri: str) -> None:
    open_response = api_client.post("/dataset/open", json={"schema_version": 1, "uri": local_omezarr_uri})
    dataset_id = open_response.json()["dataset_summary"]["dataset_id"]
    create_response = api_client.post(
        "/view/create",
        json={"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"},
    )
    view_id = create_response.json()["view_state"]["view_id"]

    update_response = api_client.post(
        "/view/update",
        json={
            "schema_version": 1,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 999, "clamp": False}],
                }
            ],
        },
    )
    assert update_response.status_code == 422
    assert update_response.json()["code"] == "selector_out_of_bounds"

