"""Event subscription helpers for polling and strict sequence validation."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
import time
from typing import Any

from .errors import EventGapError, InvalidParams


PollEventsFn = Callable[[str, str, int], list[dict[str, Any]]]


@dataclass
class EventSubscription:
    """Client-side event handle backed by daemon poll operations."""

    session_id: str
    subscription_id: str
    topics: list[str]
    transport_uri: str
    _poll_events_fn: PollEventsFn = field(repr=False)
    _last_session_seq: int | None = field(default=None, init=False, repr=False)

    def poll(self, *, limit: int = 256) -> list[dict[str, Any]]:
        if limit <= 0:
            raise InvalidParams("limit must be a positive integer", {"limit": limit})
        events = self._poll_events_fn(self.session_id, self.subscription_id, limit)
        self._validate_session_sequence(events)
        return events

    def iter_events(
        self,
        *,
        limit: int = 256,
        poll_interval_s: float = 0.05,
        max_idle_polls: int = 1,
    ) -> Iterator[dict[str, Any]]:
        if max_idle_polls <= 0:
            raise InvalidParams(
                "max_idle_polls must be a positive integer",
                {"max_idle_polls": max_idle_polls},
            )
        if poll_interval_s < 0:
            raise InvalidParams(
                "poll_interval_s must be non-negative",
                {"poll_interval_s": poll_interval_s},
            )

        idle_polls = 0
        while idle_polls < max_idle_polls:
            batch = self.poll(limit=limit)
            if batch:
                idle_polls = 0
                for event in batch:
                    yield event
                continue

            idle_polls += 1
            if idle_polls < max_idle_polls and poll_interval_s > 0:
                time.sleep(poll_interval_s)

    def _validate_session_sequence(self, events: list[dict[str, Any]]) -> None:
        for event in events:
            session_seq = event.get("session_seq")
            expected_session_seq = session_seq if self._last_session_seq is None else self._last_session_seq + 1
            if not isinstance(session_seq, int) or session_seq != expected_session_seq:
                raise EventGapError(
                    session_id=self.session_id,
                    subscription_id=self.subscription_id,
                    expected_session_seq=expected_session_seq,
                    actual_session_seq=session_seq if isinstance(session_seq, int) else None,
                )
            self._last_session_seq = session_seq

