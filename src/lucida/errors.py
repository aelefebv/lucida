from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .models.api import ApiError


@dataclass(slots=True)
class LucidaError(Exception):
    code: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    status_code: int = 400

    def to_api_error(self) -> ApiError:
        return ApiError(code=self.code, message=self.message, details=self.details)


def as_api_error_payload(error: LucidaError) -> dict[str, Any]:
    return error.to_api_error().model_dump(mode="json")

