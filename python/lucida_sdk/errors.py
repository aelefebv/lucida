"""Step 08 SDK exception hierarchy and protocol-error mapping."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

from lucida_core.errors import LucidaError as CoreLucidaError


@dataclass(frozen=True)
class LucidaSdkError(Exception):
    """Base SDK exception that preserves protocol error envelope fields."""

    code: str
    message: str
    details: dict[str, Any]
    retryable: bool = False
    retry_after_ms: int | None = None

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


class _CodeMappedError(LucidaSdkError):
    CODE: ClassVar[str]

    def __init__(
        self,
        message: str,
        details: dict[str, Any] | None = None,
        *,
        retryable: bool = False,
        retry_after_ms: int | None = None,
    ) -> None:
        super().__init__(
            code=self.CODE,
            message=message,
            details=details or {},
            retryable=retryable,
            retry_after_ms=retry_after_ms,
        )


class InvalidParams(_CodeMappedError):
    CODE = "LUCIDA_INVALID_PARAMS"


class NotFound(_CodeMappedError):
    CODE = "LUCIDA_NOT_FOUND"


class Conflict(_CodeMappedError):
    CODE = "LUCIDA_CONFLICT"


class VersionMismatch(_CodeMappedError):
    CODE = "LUCIDA_VERSION_MISMATCH"


class UnsupportedCapability(_CodeMappedError):
    CODE = "LUCIDA_UNSUPPORTED_CAPABILITY"


class Busy(_CodeMappedError):
    CODE = "LUCIDA_BUSY"


class Timeout(_CodeMappedError):
    CODE = "LUCIDA_TIMEOUT"


class Internal(_CodeMappedError):
    CODE = "LUCIDA_INTERNAL"


class IoFailure(_CodeMappedError):
    CODE = "LUCIDA_IO_FAILURE"


class AuthRequired(_CodeMappedError):
    CODE = "LUCIDA_AUTH_REQUIRED"


class AuthDenied(_CodeMappedError):
    CODE = "LUCIDA_AUTH_DENIED"


class EventGapError(LucidaSdkError):
    """Raised when event session sequence continuity is broken."""

    def __init__(
        self,
        *,
        session_id: str,
        subscription_id: str,
        expected_session_seq: int,
        actual_session_seq: int | None,
    ) -> None:
        details = {
            "session_id": session_id,
            "subscription_id": subscription_id,
            "expected_session_seq": expected_session_seq,
            "actual_session_seq": actual_session_seq,
        }
        super().__init__(
            code="LUCIDA_EVENT_GAP",
            message="Event stream continuity check failed",
            details=details,
            retryable=True,
        )


_CODE_TO_ERROR: dict[str, type[_CodeMappedError]] = {
    "LUCIDA_INVALID_PARAMS": InvalidParams,
    "LUCIDA_NOT_FOUND": NotFound,
    "LUCIDA_CONFLICT": Conflict,
    "LUCIDA_VERSION_MISMATCH": VersionMismatch,
    "LUCIDA_UNSUPPORTED_CAPABILITY": UnsupportedCapability,
    "LUCIDA_BUSY": Busy,
    "LUCIDA_TIMEOUT": Timeout,
    "LUCIDA_INTERNAL": Internal,
    "LUCIDA_IO_FAILURE": IoFailure,
    "LUCIDA_AUTH_REQUIRED": AuthRequired,
    "LUCIDA_AUTH_DENIED": AuthDenied,
}


def from_error_envelope(envelope: dict[str, Any]) -> LucidaSdkError:
    code = envelope.get("code")
    message = envelope.get("message")
    details = envelope.get("details")
    retryable = envelope.get("retryable")
    retry_after_ms = envelope.get("retry_after_ms")

    if not isinstance(code, str):
        return Internal(
            "Protocol error envelope is missing code",
            {"envelope": envelope},
        )
    if not isinstance(message, str):
        message = "Protocol error envelope is missing message"
    if not isinstance(details, dict):
        details = {}
    if not isinstance(retryable, bool):
        retryable = False
    if retry_after_ms is not None and not isinstance(retry_after_ms, int):
        retry_after_ms = None

    error_type = _CODE_TO_ERROR.get(code)
    if error_type is None:
        return LucidaSdkError(
            code=code,
            message=message,
            details=details,
            retryable=retryable,
            retry_after_ms=retry_after_ms,
        )
    return error_type(
        message,
        details,
        retryable=retryable,
        retry_after_ms=retry_after_ms,
    )


def from_core_error(error: CoreLucidaError) -> LucidaSdkError:
    return from_error_envelope(error.envelope())

