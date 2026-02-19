"""Typed Lucida protocol errors for the Step 2 in-memory engine."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LucidaError(Exception):
    """Error wrapper that maps directly to the protocol error envelope."""

    code: str
    message: str
    details: dict[str, Any]
    retryable: bool = False
    retry_after_ms: int | None = None

    def envelope(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "details": self.details,
            "retryable": self.retryable,
        }
        if self.retry_after_ms is not None:
            payload["retry_after_ms"] = self.retry_after_ms
        return payload


def invalid_params(message: str, details: dict[str, Any] | None = None) -> LucidaError:
    return LucidaError(
        code="LUCIDA_INVALID_PARAMS",
        message=message,
        details=details or {},
    )


def not_found(message: str, details: dict[str, Any] | None = None) -> LucidaError:
    return LucidaError(
        code="LUCIDA_NOT_FOUND",
        message=message,
        details=details or {},
    )


def conflict(message: str, details: dict[str, Any] | None = None) -> LucidaError:
    return LucidaError(
        code="LUCIDA_CONFLICT",
        message=message,
        details=details or {},
    )


def version_mismatch(message: str, details: dict[str, Any] | None = None) -> LucidaError:
    return LucidaError(
        code="LUCIDA_VERSION_MISMATCH",
        message=message,
        details=details or {},
    )


def unsupported(message: str, details: dict[str, Any] | None = None) -> LucidaError:
    return LucidaError(
        code="LUCIDA_UNSUPPORTED_CAPABILITY",
        message=message,
        details=details or {},
    )


def busy(message: str, details: dict[str, Any] | None = None) -> LucidaError:
    return LucidaError(
        code="LUCIDA_BUSY",
        message=message,
        details=details or {},
    )


def internal(message: str, details: dict[str, Any] | None = None) -> LucidaError:
    return LucidaError(
        code="LUCIDA_INTERNAL",
        message=message,
        details=details or {},
    )
