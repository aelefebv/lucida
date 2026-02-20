from __future__ import annotations

from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core.errors import LucidaError
from lucida_sdk.errors import (
    AuthDenied,
    AuthRequired,
    Busy,
    Conflict,
    Internal,
    InvalidParams,
    IoFailure,
    LucidaSdkError,
    NotFound,
    Timeout,
    UnsupportedCapability,
    VersionMismatch,
    from_core_error,
    from_error_envelope,
)


class Step8ErrorMappingTests(unittest.TestCase):
    def test_core_errors_map_to_expected_sdk_subclasses(self) -> None:
        matrix: list[tuple[str, type[LucidaSdkError]]] = [
            ("LUCIDA_INVALID_PARAMS", InvalidParams),
            ("LUCIDA_NOT_FOUND", NotFound),
            ("LUCIDA_CONFLICT", Conflict),
            ("LUCIDA_VERSION_MISMATCH", VersionMismatch),
            ("LUCIDA_UNSUPPORTED_CAPABILITY", UnsupportedCapability),
            ("LUCIDA_BUSY", Busy),
            ("LUCIDA_TIMEOUT", Timeout),
            ("LUCIDA_INTERNAL", Internal),
            ("LUCIDA_IO_FAILURE", IoFailure),
            ("LUCIDA_AUTH_REQUIRED", AuthRequired),
            ("LUCIDA_AUTH_DENIED", AuthDenied),
        ]
        for code, expected_type in matrix:
            with self.subTest(code=code):
                source = LucidaError(
                    code=code,
                    message=f"msg:{code}",
                    details={"a": 1},
                    retryable=True,
                    retry_after_ms=25,
                )
                mapped = from_core_error(source)
                self.assertIsInstance(mapped, expected_type)
                self.assertEqual(mapped.code, code)
                self.assertEqual(mapped.details["a"], 1)
                self.assertTrue(mapped.retryable)
                self.assertEqual(mapped.retry_after_ms, 25)

    def test_unknown_envelope_code_falls_back_to_base_sdk_error(self) -> None:
        mapped = from_error_envelope(
            {
                "code": "LUCIDA_CUSTOM",
                "message": "custom",
                "details": {"k": "v"},
                "retryable": False,
            }
        )
        self.assertIsInstance(mapped, LucidaSdkError)
        self.assertEqual(mapped.code, "LUCIDA_CUSTOM")
        self.assertEqual(mapped.details, {"k": "v"})


if __name__ == "__main__":
    unittest.main()

