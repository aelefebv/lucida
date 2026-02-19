from __future__ import annotations

from pathlib import Path
import sys
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_core.io.cache import CacheManager
from lucida_core.io.scheduler import CancelToken, CancelledError, IOScheduler, SchedulerTimeout


class Step3CacheSchedulerTests(unittest.TestCase):
    def test_chunk_lru_eviction_is_deterministic_by_capacity(self) -> None:
        cache = CacheManager(chunk_capacity_bytes=8)

        cache.touch_chunk("chunk-a", 5)
        cache.touch_chunk("chunk-b", 5)

        snapshot = cache.snapshot()
        self.assertEqual(snapshot["chunk_used_bytes"], 5)
        self.assertEqual(snapshot["counters"]["evictions"], 1)
        self.assertEqual(snapshot["counters"]["chunk_misses"], 2)

    def test_cache_hit_miss_counters_are_observable(self) -> None:
        cache = CacheManager(chunk_capacity_bytes=16)

        cache.metadata_set("dataset://a", {"shape": [1, 1, 1]})
        self.assertIsNotNone(cache.metadata_get("dataset://a"))
        self.assertIsNone(cache.metadata_get("dataset://missing"))

        cache.touch_chunk("chunk-a", 8)
        cache.touch_chunk("chunk-a", 8)

        snapshot = cache.snapshot()
        counters = snapshot["counters"]
        self.assertEqual(counters["metadata_hits"], 1)
        self.assertEqual(counters["metadata_misses"], 1)
        self.assertEqual(counters["chunk_hits"], 1)
        self.assertEqual(counters["chunk_misses"], 1)

    def test_scheduler_retries_then_succeeds(self) -> None:
        scheduler = IOScheduler(default_timeout_ms=100, default_max_retries=1)
        attempts = {"count": 0}

        def flaky() -> str:
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise RuntimeError("transient")
            return "ok"

        result = scheduler.execute(flaky)
        self.assertEqual(result, "ok")
        self.assertEqual(attempts["count"], 2)

    def test_scheduler_override_retries_zero_fails_fast(self) -> None:
        scheduler = IOScheduler(default_timeout_ms=100, default_max_retries=3)
        attempts = {"count": 0}

        def always_fail() -> str:
            attempts["count"] += 1
            raise RuntimeError("nope")

        with self.assertRaises(RuntimeError):
            scheduler.execute(always_fail, max_retries=0)
        self.assertEqual(attempts["count"], 1)

    def test_scheduler_timeout_budget_is_enforced(self) -> None:
        scheduler = IOScheduler(default_timeout_ms=1, default_max_retries=0)

        def slow() -> str:
            time.sleep(0.02)
            return "late"

        with self.assertRaises(SchedulerTimeout):
            scheduler.execute(slow)

    def test_scheduler_honors_cancel_token(self) -> None:
        scheduler = IOScheduler(default_timeout_ms=100, default_max_retries=0)
        token = CancelToken(cancelled=True)

        with self.assertRaises(CancelledError):
            scheduler.execute(lambda: "never", cancel_token=token)


if __name__ == "__main__":
    unittest.main()
