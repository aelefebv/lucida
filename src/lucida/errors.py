"""Error types and API error serialization helpers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .models.api import ApiError


@dataclass(slots=True)
class LucidaError(Exception):
    """Domain error raised for typed API failures.

    Attributes
    ----------
    code:
        Machine-readable error code.
    message:
        Human-readable message.
    details:
        Optional error context.
    status_code:
        HTTP status code to return.
    """

    code: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    status_code: int = 400

    def to_api_error(self) -> ApiError:
        """Convert this exception into the API error schema.

        Returns
        -------
        ApiError
            Error payload containing `code`, `message`, and `details`.
        """
        return ApiError(code=self.code, message=self.message, details=self.details)


def as_api_error_payload(error: LucidaError) -> dict[str, Any]:
    """Serialize a :class:`LucidaError` into an API response payload.

    Parameters
    ----------
    error:
        Lucida domain error to serialize.
    """
    return error.to_api_error().model_dump(mode="json")
