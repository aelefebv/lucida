from __future__ import annotations

from typing import Any

import httpx

from lucida.models.api import (
    ApiError,
    DatasetOpenRequest,
    DatasetOpenResponse,
    SessionCreateRequest,
    SessionCreateResponse,
    ViewCreateRequest,
    ViewCreateResponse,
    ViewGetResponse,
    ViewUpdateRequest,
    ViewUpdateResponse,
)


class LucidaClientError(Exception):
    pass


class LucidaClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8000",
        *,
        timeout: float = 30.0,
        client: httpx.Client | None = None,
    ) -> None:
        if client is None:
            self._client = httpx.Client(base_url=base_url, timeout=timeout)
            self._owns_client = True
        else:
            self._client = client
            self._owns_client = False

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "LucidaClient":
        return self

    def __exit__(self, _: Any, __: Any, ___: Any) -> None:
        self.close()

    def open_dataset(
        self,
        uri: str,
        dataset_id: str | None = None,
        session_id: str | None = None,
        include_full_raw_metadata: bool = False,
    ) -> DatasetOpenResponse:
        request = DatasetOpenRequest(
            uri=uri,
            dataset_id=dataset_id,
            session_id=session_id,
            include_full_raw_metadata=include_full_raw_metadata,
        )
        payload = self._post("/dataset/open", request.model_dump(mode="json"))
        return DatasetOpenResponse.model_validate(payload)

    def create_session(self) -> SessionCreateResponse:
        request = SessionCreateRequest()
        payload = self._post("/session/create", request.model_dump(mode="json"))
        return SessionCreateResponse.model_validate(payload)

    def create_view(
        self,
        *,
        dataset_id: str,
        session_id: str | None = None,
        mode: str = "2d",
        multiscale_name: str | None = None,
        viewport: dict[str, Any] | None = None,
        selectors: list[dict[str, Any]] | None = None,
        view_2d: dict[str, Any] | None = None,
    ) -> ViewCreateResponse:
        request = ViewCreateRequest(
            dataset_id=dataset_id,
            session_id=session_id,
            mode=mode,
            multiscale_name=multiscale_name,
            viewport=viewport,
            selectors=selectors,
            view_2d=view_2d,
        )
        payload = self._post("/view/create", request.model_dump(mode="json"))
        return ViewCreateResponse.model_validate(payload)

    def get_view(self, *, view_id: str, session_id: str | None = None) -> ViewGetResponse:
        response = self._client.get(
            f"/view/{view_id}",
            params={"session_id": session_id} if session_id is not None else None,
        )
        payload = self._validate_response(response)
        return ViewGetResponse.model_validate(payload)

    def update_view(
        self,
        *,
        view_id: str,
        patch: list[dict[str, Any]],
        session_id: str | None = None,
    ) -> ViewUpdateResponse:
        request = ViewUpdateRequest(view_id=view_id, patch=patch, session_id=session_id)
        payload = self._post("/view/update", request.model_dump(mode="json"))
        return ViewUpdateResponse.model_validate(payload)

    def set_dim(
        self,
        *,
        view_id: str,
        axis: str,
        index: int,
        session_id: str | None = None,
        clamp: bool = True,
    ) -> ViewUpdateResponse:
        selectors = self._selectors_with_replacement(
            view_id=view_id,
            axis=axis,
            replacement={"axis": axis, "kind": "index", "index": index, "clamp": clamp},
            session_id=session_id,
        )
        return self.update_view(
            view_id=view_id,
            session_id=session_id,
            patch=[{"op": "replace", "path": "/selectors", "value": selectors}],
        )

    def set_axis_range(
        self,
        *,
        view_id: str,
        axis: str,
        start: int,
        end_exclusive: int,
        session_id: str | None = None,
        clamp: bool = True,
    ) -> ViewUpdateResponse:
        selectors = self._selectors_with_replacement(
            view_id=view_id,
            axis=axis,
            replacement={
                "axis": axis,
                "kind": "range",
                "start": start,
                "end_exclusive": end_exclusive,
                "clamp": clamp,
            },
            session_id=session_id,
        )
        return self.update_view(
            view_id=view_id,
            session_id=session_id,
            patch=[{"op": "replace", "path": "/selectors", "value": selectors}],
        )

    def set_axis_set(
        self,
        *,
        view_id: str,
        axis: str,
        indices: list[int],
        session_id: str | None = None,
        clamp: bool = True,
    ) -> ViewUpdateResponse:
        selectors = self._selectors_with_replacement(
            view_id=view_id,
            axis=axis,
            replacement={
                "axis": axis,
                "kind": "set",
                "indices": indices,
                "clamp": clamp,
            },
            session_id=session_id,
        )
        return self.update_view(
            view_id=view_id,
            session_id=session_id,
            patch=[{"op": "replace", "path": "/selectors", "value": selectors}],
        )

    def _selectors_with_replacement(
        self,
        *,
        view_id: str,
        axis: str,
        replacement: dict[str, Any],
        session_id: str | None,
    ) -> list[dict[str, Any]]:
        view = self.get_view(view_id=view_id, session_id=session_id).view_state
        selectors = [selector.model_dump(mode="json") for selector in view.selectors if selector.axis != axis]
        selectors.append(replacement)
        return selectors

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self._client.post(path, json=payload)
        return self._validate_response(response)

    def _validate_response(self, response: httpx.Response) -> dict[str, Any]:
        if response.is_error:
            try:
                api_error = ApiError.model_validate(response.json())
            except Exception:  # pragma: no cover - fallback
                response.raise_for_status()
            raise LucidaClientError(f"{api_error.code}: {api_error.message}") from None
        return response.json()
