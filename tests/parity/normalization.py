from __future__ import annotations

import base64
import copy
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any

from PIL import Image

from parity.models import NormalizedCaseResult, RawCaseResult

_TOKENIZED_STRING_KEYS = {
    "dataset_id",
    "session_id",
    "view_id",
    "export_id",
    "import_id",
    "request_id",
    "render_id",
    "source_view_id",
    "imported_from_view_id",
    "state_hash",
    "uri",
}
_TIMESTAMP_KEYS = {"opened_at", "created_at", "exported_at"}
_PATH_KEYS = {"file_path", "output_root"}


@dataclass(slots=True)
class _NormalizationState:
    token_map: dict[str, dict[str, str]] = field(default_factory=dict)

    def token_for(self, key: str, value: str) -> str:
        per_key = self.token_map.setdefault(key, {})
        if value not in per_key:
            per_key[value] = f"<{key}_{len(per_key) + 1}>"
        return per_key[value]


def normalize_cases(cases: list[RawCaseResult]) -> list[NormalizedCaseResult]:
    state = _NormalizationState()
    normalized: list[NormalizedCaseResult] = []
    for case in cases:
        normalized_body = copy.deepcopy(case.body)
        _validate_and_redact_render_images(normalized_body)
        normalized_body = _normalize_value(
            normalized_body,
            parent_key=None,
            path=(),
            state=state,
        )
        normalized.append(
            NormalizedCaseResult(
                name=case.name,
                method=case.method,
                path=case.path,
                status_code=case.status_code,
                body=normalized_body,
            )
        )
    return normalized


def normalize_dataset_open_cases(cases: list[RawCaseResult]) -> list[NormalizedCaseResult]:
    state = _NormalizationState()
    normalized: list[NormalizedCaseResult] = []
    for case in cases:
        normalized_body = copy.deepcopy(case.body)
        normalized_body = _normalize_dataset_open_error_details(normalized_body)
        normalized_body = _normalize_value(
            normalized_body,
            parent_key=None,
            path=(),
            state=state,
        )
        normalized.append(
            NormalizedCaseResult(
                name=case.name,
                method=case.method,
                path=case.path,
                status_code=case.status_code,
                body=normalized_body,
            )
        )
    return normalized


def _normalize_dataset_open_error_details(payload: dict[str, Any]) -> dict[str, Any]:
    if "schema_version" in payload:
        return payload
    if "code" in payload and "message" in payload and "details" in payload:
        normalized = dict(payload)
        normalized["details"] = "<error_details>"
        return normalized
    return payload


def _normalize_value(
    value: Any,
    *,
    parent_key: str | None,
    path: tuple[str, ...],
    state: _NormalizationState,
) -> Any:
    if isinstance(value, dict):
        return {
            key: _normalize_value(
                item,
                parent_key=key,
                path=(*path, key),
                state=state,
            )
            for key, item in value.items()
        }

    if isinstance(value, list):
        return [
            _normalize_value(item, parent_key=parent_key, path=path, state=state)
            for item in value
        ]

    if isinstance(value, str) and parent_key is not None:
        if parent_key in _TOKENIZED_STRING_KEYS:
            return state.token_for(parent_key, value)
        if parent_key in _TIMESTAMP_KEYS:
            return "<timestamp>"
        if parent_key in _PATH_KEYS:
            return "<path>"
        if parent_key == "requested_path":
            return "<requested_path>"

    if _is_timing_value(path=path, value=value):
        return "<timing_ms>"

    return value


def _is_timing_value(*, path: tuple[str, ...], value: Any) -> bool:
    return "timing_ms" in path and isinstance(value, (int, float))


def _validate_and_redact_render_images(payload: dict[str, Any]) -> None:
    images = payload.get("images")
    if not isinstance(images, list):
        return

    for image_payload in images:
        if not isinstance(image_payload, dict):
            raise AssertionError("render image artifact must be a JSON object.")

        delivery = image_payload.get("delivery")
        mime = image_payload.get("mime")
        width_px = image_payload.get("width_px")
        height_px = image_payload.get("height_px")
        if mime != "image/png":
            raise AssertionError("render image artifact must use image/png mime type.")
        if not isinstance(width_px, int) or not isinstance(height_px, int):
            raise AssertionError("render image artifact must expose integer width/height.")

        bytes_base64 = image_payload.get("bytes_base64")
        file_path = image_payload.get("file_path")
        if delivery == "inline_base64":
            if not isinstance(bytes_base64, str):
                raise AssertionError("inline_base64 delivery must include bytes_base64.")
            if file_path is not None:
                raise AssertionError("inline_base64 delivery must not include file_path.")
            opened = Image.open(BytesIO(base64.b64decode(bytes_base64)))
            if opened.format != "PNG":
                raise AssertionError("render inline image must decode as PNG.")
            decoded = opened.convert("RGBA")
            if decoded.size != (width_px, height_px):
                raise AssertionError("decoded inline render dimensions must match response metadata.")
            image_payload["bytes_base64"] = "<image_bytes>"
        elif delivery == "file_path":
            if not isinstance(file_path, str):
                raise AssertionError("file_path delivery must include file_path.")
            if bytes_base64 is not None:
                raise AssertionError("file_path delivery must not include bytes_base64.")
        else:
            raise AssertionError("render image artifact has unsupported delivery value.")

        if isinstance(image_payload.get("sha256"), str):
            image_payload["sha256"] = "<image_sha256>"
