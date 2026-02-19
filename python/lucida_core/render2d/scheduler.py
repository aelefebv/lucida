"""Coalescing invalidation scheduler for per-view 2D frame planning."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class InvalidationKind(StrEnum):
    FULL = "full"
    SLICE = "slice"
    STYLE = "style"
    CAMERA = "camera"


_KIND_PRIORITY: dict[InvalidationKind, int] = {
    InvalidationKind.CAMERA: 1,
    InvalidationKind.STYLE: 2,
    InvalidationKind.SLICE: 3,
    InvalidationKind.FULL: 4,
}


@dataclass
class _PendingViewInvalidation:
    kinds: set[InvalidationKind] = field(default_factory=set)
    reasons: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class InvalidationTicket:
    plan_seq: int
    kind: InvalidationKind
    reasons: list[str]


class Render2DInvalidationScheduler:
    """Track and coalesce invalidations to one ticket per view."""

    def __init__(self) -> None:
        self._pending: dict[tuple[str, str], _PendingViewInvalidation] = {}
        self._plan_seq: dict[tuple[str, str], int] = {}

    def mark(
        self,
        *,
        session_id: str,
        view_id: str,
        kind: InvalidationKind,
        reason: str,
    ) -> None:
        key = (session_id, view_id)
        pending = self._pending.setdefault(key, _PendingViewInvalidation())
        pending.kinds.add(kind)
        pending.reasons.add(reason)

    def consume(self, *, session_id: str, view_id: str) -> InvalidationTicket | None:
        key = (session_id, view_id)
        pending = self._pending.pop(key, None)
        if pending is None:
            return None

        top_kind = max(pending.kinds, key=lambda kind: _KIND_PRIORITY[kind])
        seq = self._plan_seq.get(key, 0) + 1
        self._plan_seq[key] = seq
        return InvalidationTicket(
            plan_seq=seq,
            kind=top_kind,
            reasons=sorted(pending.reasons),
        )
