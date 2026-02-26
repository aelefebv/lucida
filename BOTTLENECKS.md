# Bottlenecks

1. Per-pixel chunk lookup path allocates and recomputes index vectors inside the hottest loop (`crates/lucida-daemon/src/render_cpu.rs:1636`, `crates/lucida-daemon/src/render_cpu.rs:2538`).
   - Why this is a bottleneck: `extract_channel_stack` calls `value_at` for every sampled pixel. `value_at` rebuilds `chunk_index` and `local_index` `Vec`s on each call, then computes chunk-local linear offsets repeatedly. This adds heavy CPU and allocator pressure on large frames.
   - Improve: switch to chunk-window iteration. For each intersecting chunk, decode once, then copy/decode contiguous spans into the output plane via precomputed strides and fixed offsets. Keep per-axis math outside pixel loops.

2. Chunk-source metadata is reopened and reparsed for each layer render (`crates/lucida-daemon/src/render_cpu.rs:372`, `crates/lucida-daemon/src/render_cpu.rs:2487`).
   - Why this is a bottleneck: `open_level_chunk_source` reads `zarr.json`, parses JSON, and rebuilds storage metadata every render/layer even when dataset+level are unchanged.
   - Improve: cache immutable `LevelChunkSource` metadata by `(dataset_id, multiscale, level.path)` in session state and reuse across renders. Invalidate on dataset close.

3. Triptych mode performs three full plane renders sequentially (`crates/lucida-daemon/src/render_cpu.rs:572`).
   - Why this is a bottleneck: orthogonal rendering executes full extract/sample/compose cycles for XY, XZ, and YZ one after another, increasing latency nearly linearly with panel count.
   - Improve: parallelize plane renders with bounded worker tasks (or rayon), share decoded chunk cache across planes, and deduplicate common selector/chunk planning.

4. Contrast normalization computes percentiles by full sorting for each channel (`crates/lucida-daemon/src/render_cpu.rs:2420`, `crates/lucida-daemon/src/render_cpu.rs:2452`).
   - Why this is a bottleneck: percentile mode clones finite values and performs `O(n log n)` sort per channel per render, even when view/layer settings are unchanged.
   - Improve: replace full sort with selection (`select_nth_unstable`) or histogram-based quantiles, and cache `(min,max)` windows keyed by `(render scope, channel, contrast params, source revision)`.

5. Layer composition repeatedly allocates full-frame intermediate buffers (`crates/lucida-daemon/src/render_cpu.rs:313`, `crates/lucida-daemon/src/render_cpu.rs:470`, `crates/lucida-daemon/src/render_cpu.rs:2300`).
   - Why this is a bottleneck: each layer creates separate `sampled_stack`, `sample_alpha`, `layer_rgb`, and `layer_alpha` vectors before blending into canvas, multiplying memory bandwidth and allocation churn.
   - Improve: stream composition directly into the destination canvas with reusable scratch buffers from a pool sized per output resolution.

6. Usage capture middleware fully buffers request/response bodies and rebuilds responses (`crates/lucida-daemon/src/usage_capture.rs:231`, `crates/lucida-daemon/src/usage_capture.rs:245`, `crates/lucida-daemon/src/usage_capture.rs:253`).
   - Why this is a bottleneck: `to_bytes` + body reconstruction copies payloads on every instrumented request. Render responses can be large, amplifying memory traffic and latency.
   - Improve: capture metadata-only by default (status, latency, ids), and only sample/parse JSON for a small configured subset. For large bodies, parse headers and skip body materialization.

7. Thumbnail generation decodes and re-encodes images on the single usage worker thread (`crates/lucida-daemon/src/usage_capture.rs:341`, `crates/lucida-daemon/src/usage_capture.rs:361`).
   - Why this is a bottleneck: PNG decode, resize, encode, hashing, and disk write run synchronously per sampled render event; backlog growth delays telemetry inserts and can stall live streams.
   - Improve: split telemetry insert from thumbnail pipeline, use a bounded thumbnail worker pool, and apply adaptive backpressure (drop thumbnails when queue is saturated).

8. Retention pruning performs expensive DB-size checks and checkpoints during insert path (`crates/lucida-daemon/src/usage.rs:471`, `crates/lucida-daemon/src/usage.rs:522`, `crates/lucida-daemon/src/usage.rs:534`).
   - Why this is a bottleneck: insert-triggered pruning can call `usage_db_total_size` and repeated `wal_checkpoint(TRUNCATE)` loops, causing periodic latency spikes under heavy telemetry volume.
   - Improve: move size-based pruning to a background maintenance interval, and bound per-cycle work (time/rows). Keep insert path to enqueue-only behavior.
