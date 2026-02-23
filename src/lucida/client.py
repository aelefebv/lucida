from __future__ import annotations

from typing import Any

import httpx

from lucida.models.api import ApiError, DatasetOpenRequest, DatasetOpenResponse


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
        include_full_raw_metadata: bool = False,
    ) -> DatasetOpenResponse:
        request = DatasetOpenRequest(
            uri=uri,
            dataset_id=dataset_id,
            include_full_raw_metadata=include_full_raw_metadata,
        )

        response = self._client.post("/dataset/open", json=request.model_dump(mode="json"))
        if response.is_error:
            try:
                api_error = ApiError.model_validate(response.json())
            except Exception:  # pragma: no cover - fallback
                response.raise_for_status()
            raise LucidaClientError(f"{api_error.code}: {api_error.message}") from None

        return DatasetOpenResponse.model_validate(response.json())
