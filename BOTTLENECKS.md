# Bottlenecks in Lucida Daemon

Date: 2026-02-25
Scope: Static analysis of Rust daemon hot paths (`render_cpu`, `render_cache`, `usage_capture`, `usage`).

## Highest-impact bottlenecks (priority order)

### 1) Per-pixel allocations in inner extraction loop
- Location: `crates/lucida-daemon/src/render_cpu.rs:739`
- Current behavior: allocates `Vec<usize>` indices for every pixel in `extract_channel_stack`.
- Why this is a bottleneck: allocator churn and extra branch/index overhead in the hottest loop.
- Expected impact: high CPU overhead, especially at larger output sizes and multiple channels/slabs.

Recommended fix:
- Precompute axis positions and constant offsets once per channel/slab.
- Replace per-pixel index vector creation with direct linear-offset arithmetic.
- Reuse scratch buffers across channels/planes.

### 2) Percentile normalization does full sort per channel
- Location: `crates/lucida-daemon/src/render_cpu.rs:1226`
- Current behavior: percentile calls clone/filter/sort channel data (`O(n log n)`) each render.
- Why this is a bottleneck: repeated full-data sorts for p-low/p-high dominate normalization time.
- Expected impact: significant CPU spikes for large frames and many channels.

Recommended fix:
- Use selection (`select_nth_unstable`) for exact percentiles in `O(n)` average time.
- Or use histogram/approximate quantiles for bounded-time behavior.
- Cache contrast windows keyed by `(dataset_id, level, channel, selector/slab)` and invalidate on relevant state changes.

### 3) Synchronous thumbnail generation in request middleware
- Location: `crates/lucida-daemon/src/usage_capture.rs:64`, `:165`
- Current behavior: `/render/image` telemetry path decodes base64 image, resizes, PNG-encodes, writes thumbnail before returning response.
- Why this is a bottleneck: extra CPU + I/O on critical request path increases tail latency.
- Expected impact: noticeable slowdown for high render throughput.

Recommended fix:
- Move thumbnail generation to async background worker queue.
- Skip thumbnail creation when delivery is not `inline_base64`.
- Add sampling/rate-limit knobs for thumbnail generation.

### 4) LRU touch path is linear-time per cache hit
- Location: `crates/lucida-daemon/src/render_cache.rs:149`
- Current behavior: cache hit does `VecDeque::position` + remove + push-back.
- Why this is a bottleneck: `O(n)` touch cost per hit becomes expensive with many cached entries.
- Expected impact: avoidable CPU overhead under active cache workloads.

Recommended fix:
- Replace with O(1) LRU bookkeeping (linked hash map style structure).
- Keep key->node map and doubly-linked usage list semantics.

### 5) Telemetry prune path runs on every event insert
- Location: `crates/lucida-daemon/src/usage.rs:218`, `:461`
- Current behavior: each inserted event triggers pruning checks (age/count/size; optional checkpoint loop).
- Why this is a bottleneck: repeated maintenance work in steady-state ingestion path.
- Expected impact: throughput degradation as event rate grows.

Recommended fix:
- Prune on interval (e.g., every N seconds) or every M inserts.
- Keep hard safety guard, but avoid full prune cycle per insert.

## Suggested implementation order

1. Remove per-pixel allocations and use direct stride math.
2. Optimize percentile/contrast pipeline.
3. Offload thumbnail work from request path.
4. Upgrade LRU bookkeeping to O(1) touch/evict.
5. Batch telemetry pruning.

## Validation plan for performance changes

- Add criterion/benchmark harnesses for:
  - render latency (`p50`, `p95`) at fixed output sizes and representative datasets.
  - CPU time spent in decode/sampling/composition.
  - cache hit/miss behavior under pan/zoom sequences.
- Add regression thresholds in CI for representative local datasets.
- Capture before/after metrics for each optimization phase, not only final combined result.

## Notes

- Findings are from first-principles static analysis; no runtime profiling was executed in this run.
- Most gains will come from changing the render dataflow so work scales with viewport, not dataset volume.
