from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx
from fastapi.testclient import TestClient

from lucida.runtime_config import DEFAULT_RUST_BASE_URL
from lucida.server.app import create_app
from lucida.service.dataset_service import DatasetService
from parity.data_setup import Phase1DatasetUris
from parity.models import RawCaseResult


class BackendAdapter(Protocol):
    def request(
        self,
        *,
        method: str,
        path: str,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        ...

    def close(self) -> None:
        ...


@dataclass(slots=True)
class PythonBackendAdapter:
    _client: TestClient

    @classmethod
    def create(cls) -> "PythonBackendAdapter":
        service = DatasetService()
        app = create_app(dataset_service=service)
        return cls(_client=TestClient(app))

    def request(
        self,
        *,
        method: str,
        path: str,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        response = self._client.request(method, path, json=json_body, params=params)
        payload = response.json()
        if not isinstance(payload, dict):
            raise AssertionError(f"Expected JSON object response for {method} {path}.")
        return response.status_code, payload

    def close(self) -> None:
        self._client.close()


@dataclass(slots=True)
class RustBackendAdapter:
    _client: httpx.Client

    @classmethod
    def create(cls, base_url: str | None = None) -> "RustBackendAdapter":
        return cls(
            _client=httpx.Client(
                base_url=base_url or DEFAULT_RUST_BASE_URL,
                timeout=30.0,
            )
        )

    def request(
        self,
        *,
        method: str,
        path: str,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        response = self._client.request(method, path, json=json_body, params=params)
        payload = response.json()
        if not isinstance(payload, dict):
            raise AssertionError(f"Expected JSON object response for {method} {path}.")
        return response.status_code, payload

    def close(self) -> None:
        self._client.close()


def create_backend_adapter(backend: str, *, base_url: str | None = None) -> BackendAdapter:
    normalized = backend.strip().lower()
    if normalized == "python":
        return PythonBackendAdapter.create()
    if normalized == "rust":
        return RustBackendAdapter.create(base_url=base_url)
    raise ValueError("Unsupported backend. Expected one of: python, rust.")


def run_dataset_open_cases(
    *,
    adapter: BackendAdapter,
    dataset_uris: Phase1DatasetUris,
) -> list[RawCaseResult]:
    cases: list[RawCaseResult] = []

    def record(
        *,
        name: str,
        json_body: dict[str, Any],
    ) -> None:
        status_code, body = adapter.request(
            method="POST",
            path="/dataset/open",
            json_body=json_body,
        )
        cases.append(
            RawCaseResult(
                name=name,
                method="POST",
                path="/dataset/open",
                status_code=status_code,
                body=body,
            )
        )

    record(
        name="dataset_open_success",
        json_body={"schema_version": 1, "uri": dataset_uris.local_uri},
    )
    record(
        name="dataset_open_invalid_metadata_error",
        json_body={"schema_version": 1, "uri": dataset_uris.invalid_uri},
    )
    record(
        name="dataset_open_invalid_request_error",
        json_body={"schema_version": 1, "uri": dataset_uris.local_uri, "dataset_id": ""},
    )
    record(
        name="dataset_open_unknown_session_error",
        json_body={
            "schema_version": 1,
            "uri": dataset_uris.local_uri,
            "session_id": "session_missing",
        },
    )
    record(
        name="dataset_open_tolerant_warnings_success",
        json_body={"schema_version": 1, "uri": dataset_uris.tolerant_uri},
    )
    record(
        name="dataset_open_raw_metadata_curated_success",
        json_body={
            "schema_version": 1,
            "uri": dataset_uris.raw_metadata_uri,
            "include_full_raw_metadata": False,
        },
    )
    record(
        name="dataset_open_raw_metadata_full_success",
        json_body={
            "schema_version": 1,
            "uri": dataset_uris.raw_metadata_uri,
            "include_full_raw_metadata": True,
        },
    )
    return cases


def run_phase1_cases(
    *,
    adapter: BackendAdapter,
    dataset_uris: Phase1DatasetUris,
    output_root: Path,
) -> list[RawCaseResult]:
    cases: list[RawCaseResult] = []
    created_output_paths: list[Path] = []

    def record(
        *,
        name: str,
        method: str,
        case_path: str,
        request_path: str | None = None,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        status_code, body = adapter.request(
            method=method,
            path=request_path or case_path,
            json_body=json_body,
            params=params,
        )
        cases.append(
            RawCaseResult(
                name=name,
                method=method,
                path=case_path,
                status_code=status_code,
                body=body,
            )
        )
        return body

    try:
        dataset_open_success = record(
            name="dataset_open_success",
            method="POST",
            case_path="/dataset/open",
            json_body={"schema_version": 1, "uri": dataset_uris.local_uri},
        )
        dataset_id = str(dataset_open_success["dataset_summary"]["dataset_id"])

        record(
            name="dataset_open_invalid_metadata_error",
            method="POST",
            case_path="/dataset/open",
            json_body={"schema_version": 1, "uri": dataset_uris.invalid_uri},
        )

        record(
            name="dataset_open_invalid_request_error",
            method="POST",
            case_path="/dataset/open",
            json_body={"schema_version": 1, "uri": dataset_uris.local_uri, "dataset_id": ""},
        )

        session_create_success = record(
            name="session_create_success",
            method="POST",
            case_path="/session/create",
            json_body={"schema_version": 1},
        )
        session_id = str(session_create_success["session_id"])

        record(
            name="dataset_open_unknown_session_error",
            method="POST",
            case_path="/dataset/open",
            json_body={
                "schema_version": 1,
                "uri": dataset_uris.local_uri,
                "session_id": "session_missing",
            },
        )

        dataset_open_session_success = record(
            name="dataset_open_with_session_success",
            method="POST",
            case_path="/dataset/open",
            json_body={"schema_version": 1, "uri": dataset_uris.local_uri, "session_id": session_id},
        )
        session_dataset_id = str(dataset_open_session_success["dataset_summary"]["dataset_id"])

        view_create_success = record(
            name="view_create_success",
            method="POST",
            case_path="/view/create",
            json_body={
                "schema_version": 1,
                "session_id": session_id,
                "dataset_id": session_dataset_id,
                "mode": "2d",
            },
        )
        view_id = str(view_create_success["view_state"]["view_id"])

        record(
            name="view_get_success",
            method="GET",
            case_path="/view/{view_id}",
            request_path=f"/view/{view_id}",
            params={"session_id": session_id},
        )

        record(
            name="view_update_success",
            method="POST",
            case_path="/view/update",
            json_body={
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

        record(
            name="view_create_unknown_dataset_error",
            method="POST",
            case_path="/view/create",
            json_body={"schema_version": 1, "dataset_id": "ds_missing", "mode": "2d"},
        )

        record(
            name="view_create_unsupported_mode_error",
            method="POST",
            case_path="/view/create",
            json_body={"schema_version": 1, "dataset_id": dataset_id, "mode": "3d"},
        )

        record(
            name="view_update_selector_out_of_bounds_error",
            method="POST",
            case_path="/view/update",
            json_body={
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

        export_viewstate_success = record(
            name="export_viewstate_success",
            method="POST",
            case_path="/export/viewstate",
            json_body={
                "schema_version": 1,
                "view_id": view_id,
                "session_id": session_id,
            },
        )
        exported_view_state = export_viewstate_success["view_state"]

        record(
            name="export_viewstate_unknown_session_error",
            method="POST",
            case_path="/export/viewstate",
            json_body={
                "schema_version": 1,
                "view_id": view_id,
                "session_id": "session_missing",
            },
        )

        record(
            name="import_viewstate_success",
            method="POST",
            case_path="/import/viewstate",
            json_body={
                "schema_version": 1,
                "session_id": session_id,
                "view_state": exported_view_state,
            },
        )

        unsupported_import_view_state = copy.deepcopy(exported_view_state)
        unsupported_import_view_state["mode"] = "3d"
        unsupported_import_view_state["view_3d"] = {}
        record(
            name="import_viewstate_unsupported_mode_error",
            method="POST",
            case_path="/import/viewstate",
            json_body={
                "schema_version": 1,
                "session_id": session_id,
                "view_state": unsupported_import_view_state,
            },
        )

        render_dataset_open = record(
            name="render_dataset_open_success",
            method="POST",
            case_path="/dataset/open",
            json_body={"schema_version": 1, "uri": dataset_uris.render_uri},
        )
        render_dataset_id = str(render_dataset_open["dataset_summary"]["dataset_id"])

        render_view_create = record(
            name="render_view_create_success",
            method="POST",
            case_path="/view/create",
            json_body={"schema_version": 1, "dataset_id": render_dataset_id, "mode": "2d"},
        )
        render_view_id = str(render_view_create["view_state"]["view_id"])

        render_view_get = record(
            name="render_view_get_success",
            method="GET",
            case_path="/view/{view_id}",
            request_path=f"/view/{render_view_id}",
        )
        render_view_state = render_view_get["view_state"]

        record(
            name="render_image_success_stateful_inline",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_id": render_view_id,
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 64,
                    "height_px": 48,
                },
            },
        )

        record(
            name="render_image_invalid_patch_error",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_id": render_view_id,
                "overrides_json_patch": [
                    {"op": "replace", "path": "/selectors/100/index", "value": 1}
                ],
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 64,
                    "height_px": 48,
                },
            },
        )

        record(
            name="render_image_session_not_found_error",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_id": render_view_id,
                "session_id": "session_missing",
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 64,
                    "height_px": 48,
                },
            },
        )

        record(
            name="render_image_output_too_large_error",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_id": render_view_id,
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 5000,
                    "height_px": 48,
                },
            },
        )

        record(
            name="render_image_stateless_inline_success",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_state": render_view_state,
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 40,
                    "height_px": 30,
                },
            },
        )

        render_file_path = f"snapshots/parity-{uuid.uuid4().hex}.png"
        render_file_delivery = record(
            name="render_image_file_delivery_success",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_id": render_view_id,
                "output": {
                    "format": "png",
                    "delivery": "file_path",
                    "file_path": render_file_path,
                    "width_px": 40,
                    "height_px": 30,
                },
            },
        )
        artifact_file_path = render_file_delivery.get("images", [{}])[0].get("file_path")
        if isinstance(artifact_file_path, str):
            created_output_paths.append(Path(artifact_file_path))

        record(
            name="render_image_invalid_request_both_view_and_state",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_id": render_view_id,
                "view_state": render_view_state,
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 32,
                    "height_px": 24,
                },
            },
        )

        record(
            name="render_image_invalid_request_neither_view_nor_state",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 32,
                    "height_px": 24,
                },
            },
        )

        record(
            name="render_image_output_path_invalid_error",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_id": render_view_id,
                "output": {
                    "format": "png",
                    "delivery": "file_path",
                    "file_path": "../bad.png",
                    "width_px": 32,
                    "height_px": 24,
                },
            },
        )

        missing_dataset_state = copy.deepcopy(render_view_state)
        missing_dataset_state["datasets"] = [dict(render_view_state["datasets"][0])]
        missing_dataset_state["datasets"][0]["dataset_id"] = "ds_missing"
        record(
            name="render_image_stateless_missing_dataset_error",
            method="POST",
            case_path="/render/image",
            json_body={
                "schema_version": 1,
                "view_state": missing_dataset_state,
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 32,
                    "height_px": 24,
                },
            },
        )
    finally:
        for output_path in created_output_paths:
            if output_path.exists():
                try:
                    output_path.relative_to(output_root)
                except ValueError:
                    continue
                output_path.unlink()

    return cases
