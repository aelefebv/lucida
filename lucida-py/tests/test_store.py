from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from lucida import PyStore  # noqa: E402


def test_store_opens_and_reads_local_object(tmp_path):
    assert PyStore is not None
    payload = b"trusted-local"
    (tmp_path / "zarr.json").write_bytes(payload)

    store = PyStore.open(str(tmp_path))

    assert store.read_chunk("zarr.json", max_bytes=len(payload)) == payload


def test_store_reads_release_the_gil_and_enforce_the_preallocation_cap(tmp_path):
    assert PyStore is not None
    chunk_size = 32 * 1024 * 1024
    chunk_path = tmp_path / "chunk"
    with chunk_path.open("wb") as chunk:
        chunk.seek(chunk_size - 1)
        chunk.write(b"\0")

    store = PyStore.open(str(tmp_path))
    running = threading.Event()
    stop = threading.Event()
    progress = [0]

    def make_progress() -> None:
        running.set()
        while not stop.is_set():
            progress[0] += 1

    worker = threading.Thread(target=make_progress, daemon=True)
    worker.start()
    assert running.wait(timeout=1)
    before = progress[0]
    old_switch_interval = sys.getswitchinterval()
    sys.setswitchinterval(0.001)
    try:
        data = store.read_chunk("chunk", max_bytes=chunk_size)
    finally:
        sys.setswitchinterval(old_switch_interval)
        stop.set()
        worker.join(timeout=1)

    assert len(data) == chunk_size
    assert progress[0] > before

    with pytest.raises(OSError, match="limit is 1024"):
        store.read_chunk("chunk", max_bytes=1024)


def test_two_stores_have_stable_collision_free_locator_identities(tmp_path):
    assert PyStore is not None
    first_path = tmp_path / "first.zarr"
    second_path = tmp_path / "second.zarr"
    first_path.mkdir()
    second_path.mkdir()

    first = PyStore.open(str(first_path))
    first_again = PyStore.open(str(first_path))
    second = PyStore.open(str(second_path))

    assert first.dataset_id() == first_again.dataset_id()
    assert first.dataset_id() != second.dataset_id()
