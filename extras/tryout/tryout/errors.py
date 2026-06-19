"""Error types for the tryout harness.

A single structured exception type carries a stable ``stage`` tag and an
optional ``detail`` payload. The CLI turns it into the ``{"ok": false,
"error": ...}`` envelope under ``--json`` (and a clear stderr line otherwise),
so every failure path produces the same shape rather than a stack trace.
"""

from __future__ import annotations

from typing import Any


class TryoutError(RuntimeError):
    """A bring-up failure with a machine-readable stage tag.

    ``stage`` names *where* in the bring-up -> report -> teardown lifecycle the
    failure happened (e.g. ``"build"``, ``"boot"``, ``"healthz"``,
    ``"workspace"``, ``"dataset"``, ``"fixture"``, ``"config"``). It is stable
    so callers can branch on it without parsing the message. ``detail`` carries
    any extra structured context (diagnostics from the server, the path that was
    missing, etc.).
    """

    def __init__(self, stage: str, message: str, *, detail: Any | None = None):
        super().__init__(message)
        self.stage = stage
        self.message = message
        self.detail = detail

    def to_error(self) -> dict[str, Any]:
        error: dict[str, Any] = {"stage": self.stage, "message": self.message}
        if self.detail is not None:
            error["detail"] = self.detail
        return error
