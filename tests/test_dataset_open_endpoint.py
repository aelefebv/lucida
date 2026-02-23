from __future__ import annotations

from fastapi.testclient import TestClient

from lucida.server.app import create_app


def test_dataset_open_endpoint_success(local_omezarr_uri: str) -> None:
    client = TestClient(create_app())
    response = client.post(
        "/dataset/open",
        json={"schema_version": 1, "uri": local_omezarr_uri},
    )
    assert response.status_code == 200

    payload = response.json()
    assert payload["schema_version"] == 1
    assert payload["dataset_summary"]["schema_version"] == 1
    assert payload["dataset_summary"]["uri"].startswith("file://")
    assert payload["dataset_summary"]["multiscales"][0]["levels"][0]["path"] == "0"
    assert "warnings" in payload


def test_dataset_open_endpoint_invalid_metadata_error(invalid_omezarr_uri: str) -> None:
    client = TestClient(create_app())
    response = client.post(
        "/dataset/open",
        json={"schema_version": 1, "uri": invalid_omezarr_uri},
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == "invalid_omezarr"
    assert payload["message"]
    assert "details" in payload


def test_dataset_open_endpoint_invalid_request_error(local_omezarr_uri: str) -> None:
    client = TestClient(create_app())
    response = client.post(
        "/dataset/open",
        json={"schema_version": 1, "uri": local_omezarr_uri, "dataset_id": ""},
    )

    assert response.status_code == 422
    payload = response.json()
    assert payload["code"] == "invalid_request"
    assert payload["message"] == "Request validation failed."
    assert "details" in payload
