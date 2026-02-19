"""Simple deterministic IO scheduler with timeout/retry policy."""

from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Callable, TypeVar


T = TypeVar("T")


class SchedulerTimeout(TimeoutError):
    """Operation exceeded the configured timeout."""


class CancelledError(RuntimeError):
    """Operation was cancelled before completion."""


@dataclass
class CancelToken:
    cancelled: bool = False

    def cancel(self) -> None:
        self.cancelled = True


@dataclass
class IOScheduler:
    default_timeout_ms: int = 5000
    default_max_retries: int = 1

    def execute(
        self,
        operation: Callable[[], T],
        *,
        timeout_ms: int | None = None,
        max_retries: int | None = None,
        cancel_token: CancelToken | None = None,
    ) -> T:
        timeout_budget = self.default_timeout_ms if timeout_ms is None else int(timeout_ms)
        retries = self.default_max_retries if max_retries is None else int(max_retries)

        if timeout_budget <= 0:
            raise SchedulerTimeout("timeout budget must be positive")
        if retries < 0:
            retries = 0

        last_error: Exception | None = None
        for attempt in range(retries + 1):
            if cancel_token is not None and cancel_token.cancelled:
                raise CancelledError("operation cancelled")

            started = time.perf_counter()
            try:
                result = operation()
            except Exception as exc:  # pragma: no cover - narrow exceptions are handled by callers
                last_error = exc
                if attempt == retries:
                    raise
                continue

            elapsed_ms = (time.perf_counter() - started) * 1000
            if elapsed_ms > timeout_budget:
                last_error = SchedulerTimeout(
                    f"operation exceeded timeout budget ({int(elapsed_ms)}ms > {timeout_budget}ms)"
                )
                if attempt == retries:
                    raise last_error
                continue
            return result

        if last_error is None:
            raise RuntimeError("scheduler reached invalid state")
        raise last_error
