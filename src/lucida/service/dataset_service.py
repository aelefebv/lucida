from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from lucida.io.omezarr_reader import read_omezarr
from lucida.io.uri import is_remote_uri, normalize_uri
from lucida.models.api import DatasetOpenResponse
from lucida.models.dataset_summary import DatasetHints, DatasetSummary


def generate_dataset_id(normalized_uri: str) -> str:
    digest = hashlib.sha256(normalized_uri.encode("utf-8")).hexdigest()[:16]
    return f"ds_{digest}"


class DatasetService:
    def open_dataset(
        self,
        *,
        uri: str,
        dataset_id: str | None = None,
        include_full_raw_metadata: bool = False,
    ) -> DatasetOpenResponse:
        normalized_uri = normalize_uri(uri)
        resolved_dataset_id = dataset_id or generate_dataset_id(normalized_uri)

        read_result, warnings = read_omezarr(
            uri=normalized_uri,
            include_full_raw_metadata=include_full_raw_metadata,
        )

        hints = DatasetHints(
            is_remote=is_remote_uri(normalized_uri),
            recommended_tile_px=read_result.recommended_tile_px,
        )

        dataset_summary = DatasetSummary(
            dataset_id=resolved_dataset_id,
            uri=normalized_uri,
            opened_at=datetime.now(tz=timezone.utc),
            axes=read_result.axes,
            shape=read_result.shape,
            dtype=read_result.dtype,
            channels=read_result.channels,
            multiscales=read_result.multiscales,
            hints=hints,
            raw_metadata=read_result.raw_metadata,
        )

        return DatasetOpenResponse(dataset_summary=dataset_summary, warnings=warnings)

