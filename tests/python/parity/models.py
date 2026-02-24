from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class RawCaseResult:
    name: str
    method: str
    path: str
    status_code: int
    body: dict[str, Any]


@dataclass(frozen=True, slots=True)
class NormalizedCaseResult:
    name: str
    method: str
    path: str
    status_code: int
    body: dict[str, Any]
