"""Request and idempotency ID helpers."""

from __future__ import annotations

import secrets
import time
import uuid


def uuid7_str() -> str:
    """Return a UUIDv7 string, with a fallback for runtimes without uuid.uuid7."""
    native_uuid7 = getattr(uuid, "uuid7", None)
    if callable(native_uuid7):
        return str(native_uuid7())

    timestamp_ms = int(time.time_ns() // 1_000_000) & ((1 << 48) - 1)
    random_a = secrets.randbits(12)
    random_b = secrets.randbits(62)
    value = (timestamp_ms << 80) | (0x7 << 76) | (random_a << 64) | (0b10 << 62) | random_b
    return str(uuid.UUID(int=value))


def make_idempotency_key(prefix: str = "idem") -> str:
    return f"{prefix}:{uuid7_str()}"

