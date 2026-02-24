"""Deterministic dataset identifier helpers."""

from __future__ import annotations

import hashlib


def generate_dataset_id(normalized_uri: str) -> str:
    """Build a deterministic dataset identifier from a normalized URI."""
    digest = hashlib.sha256(normalized_uri.encode("utf-8")).hexdigest()[:16]
    return f"ds_{digest}"
