"""Deterministic metadata/chunk cache primitives for Step 3."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CacheCounters:
    chunk_hits: int = 0
    chunk_misses: int = 0
    metadata_hits: int = 0
    metadata_misses: int = 0
    evictions: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "chunk_hits": self.chunk_hits,
            "chunk_misses": self.chunk_misses,
            "metadata_hits": self.metadata_hits,
            "metadata_misses": self.metadata_misses,
            "evictions": self.evictions,
        }


@dataclass
class ChunkCacheLRU:
    capacity_bytes: int = 64 * 1024 * 1024
    _entries: OrderedDict[str, int] = field(default_factory=OrderedDict)
    _used_bytes: int = 0

    def touch(self, key: str, size_bytes: int) -> bool:
        """Mark a chunk access and enforce LRU eviction by byte budget."""
        if size_bytes < 0:
            raise ValueError("size_bytes must be non-negative")
        hit = key in self._entries
        if hit:
            old_size = self._entries.pop(key)
            self._used_bytes -= old_size
        self._entries[key] = size_bytes
        self._used_bytes += size_bytes
        return hit

    def evict_until_fit(self) -> int:
        evicted = 0
        while self._used_bytes > self.capacity_bytes and self._entries:
            _, size = self._entries.popitem(last=False)
            self._used_bytes -= size
            evicted += 1
        return evicted

    @property
    def used_bytes(self) -> int:
        return self._used_bytes


@dataclass
class MetadataCache:
    _entries: dict[str, Any] = field(default_factory=dict)

    def get(self, key: str) -> Any | None:
        return self._entries.get(key)

    def set(self, key: str, value: Any) -> None:
        self._entries[key] = value

    def size(self) -> int:
        return len(self._entries)


@dataclass
class CacheManager:
    chunk_capacity_bytes: int = 64 * 1024 * 1024
    counters: CacheCounters = field(default_factory=CacheCounters)
    chunks: ChunkCacheLRU = field(init=False)
    metadata: MetadataCache = field(default_factory=MetadataCache)

    def __post_init__(self) -> None:
        self.chunks = ChunkCacheLRU(capacity_bytes=self.chunk_capacity_bytes)

    def metadata_get(self, key: str) -> Any | None:
        value = self.metadata.get(key)
        if value is None:
            self.counters.metadata_misses += 1
            return None
        self.counters.metadata_hits += 1
        return value

    def metadata_set(self, key: str, value: Any) -> None:
        self.metadata.set(key, value)

    def touch_chunk(self, key: str, size_bytes: int) -> None:
        hit = self.chunks.touch(key, size_bytes)
        if hit:
            self.counters.chunk_hits += 1
        else:
            self.counters.chunk_misses += 1
        self.counters.evictions += self.chunks.evict_until_fit()

    def snapshot(self) -> dict[str, Any]:
        return {
            "chunk_capacity_bytes": self.chunks.capacity_bytes,
            "chunk_used_bytes": self.chunks.used_bytes,
            "metadata_entries": self.metadata.size(),
            "counters": self.counters.as_dict(),
        }
