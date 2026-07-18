from __future__ import annotations

import sys
import tracemalloc
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from lucida.volume import assemble_chunks  # noqa: E402


def test_empty_assembly_is_defined_and_allocates_nothing():
    data, origin = assemble_chunks({}, [], (4, 4, 4), (100, 100, 100), "uint16")
    assert data.shape == (0, 0, 0)
    assert data.nbytes == 0
    assert origin == (0, 0, 0)


def test_sparse_bounding_box_is_rejected_before_allocation(monkeypatch):
    needed = [
        {"key": "first", "z": 0, "y": 0, "x": 0},
        {"key": "last", "z": 999, "y": 999, "x": 999},
    ]
    monkeypatch.setattr(
        np,
        "zeros",
        lambda *args, **kwargs: pytest.fail("allocation happened before budget rejection"),
    )
    tracemalloc.start()
    try:
        with pytest.raises(MemoryError, match="provide crop_zyx"):
            assemble_chunks(
                {},
                needed,
                (32, 32, 32),
                (32_000, 32_000, 32_000),
                "uint16",
                max_bytes=1024,
            )
        _, peak_bytes = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak_bytes < 128 * 1024


def test_explicit_crop_keeps_sparse_request_bounded_and_copies_intersection():
    first = np.ones((4, 4, 4), dtype=np.uint16)
    distant = np.full((4, 4, 4), 9, dtype=np.uint16)
    data, origin = assemble_chunks(
        {"first": first, "distant": distant},
        [
            {"key": "first", "z": 0, "y": 0, "x": 0},
            {"key": "distant", "z": 999, "y": 999, "x": 999},
        ],
        (4, 4, 4),
        (4000, 4000, 4000),
        "uint16",
        crop_zyx=((0, 4), (0, 4), (0, 4)),
        max_bytes=128,
    )
    assert origin == (0, 0, 0)
    assert data.shape == (4, 4, 4)
    assert data.nbytes == 128
    assert np.all(data == 1)


def test_same_dtype_assembly_has_one_output_sized_allocation_peak():
    source = np.ones((64, 128, 128), dtype=np.uint16)
    tracemalloc.start()
    try:
        data, origin = assemble_chunks(
            {"chunk": source},
            [{"key": "chunk", "z": 0, "y": 0, "x": 0}],
            source.shape,
            source.shape,
            source.dtype,
            max_bytes=source.nbytes,
        )
        _, peak_bytes = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert origin == (0, 0, 0)
    assert np.array_equal(data, source)
    assert peak_bytes <= data.nbytes + 128 * 1024
