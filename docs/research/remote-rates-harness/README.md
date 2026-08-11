# remote-rates harness (issue #899)

Measurement tooling for `docs/research/remote-rates.md`. Not part of the product and not wired
into CI. Reproduces the remote-object-storage rate table **and** the per-request latency
distributions at devicePixelRatio 2.

Derived from `docs/research/trace-volumes-harness/` (#888) — read that README first; its gotchas
still apply. What is new here: the fixture is a `gs://` URL, and the instrumentation reaches the
**server**, where the object-store I/O actually happens.

```bash
# 1. apply the throwaway instrumentation (superset of #888's counters)
git apply docs/research/remote-rates-instrumentation.patch

# 2. rebuild everything the instrumentation touches
(cd lucida-core && wasm-pack build --target web --out-dir pkg)
(cd lucida-web && pnpm install --force && pnpm run build)
CARGO_TARGET_DIR=/tmp/rr-target cargo build --release -p lucida-server

# 3. run (boots the server, opens the REMOTE dataset, drives Chrome at DPR2)
python3 docs/research/remote-rates-harness/rr_run.py /tmp/rr/run-1 \
  gs://calico-ylm-zarr-01/processed_zarrs/20260626_Guk1_BY_DHY.v1319.processed_catchers.zarr

# 4. read it (joins client counters to the server's per-read lines, bucketed per phase)
python3 docs/research/remote-rates-harness/rr_show.py /tmp/rr/run-1

# 5. put the tree back
git checkout -- . && git clean -fd lucida-web/src lucida-store/src
```

`rr_run.py` sets `LUCIDA_RR_TRACE=1`, which makes the patched `lucida-store` emit one line per
source read into `server.log`:

```text
RRGET <epoch_us> <hit|miss|coalesce|orphan> <total_us> <bytes>
RRBAK <epoch_us> <permit_us> <ttfb_us> <body_us> <bytes> <inflight_at_start> <ok|err>
RRSRV <epoch_us> <store_us> <decode_us> <total_us> <bytes>
```

`RRBAK` is the one that matters: it splits a remote read into **our own semaphore queueing**
(`permit_us`), **network first byte** (`ttfb_us`) and **payload transfer** (`body_us`).

Gotchas this run paid for, on top of #888's:

- **Wait out the 3 s last-view debounce before reloading.** `useSavedViewSync` persists the moved
  camera on a 3 s debounce; reloading sooner means the warm re-open lands on the opening view and
  silently measures the *cheap* case. `rr_driver.cjs` holds 8 s. This is the single easiest way to
  get a wrong answer out of this harness.
- **Do not trust `readyProbe`'s canvas size for DPR.** `document.querySelector('canvas')` finds an
  auxiliary 300 × 150 canvas. Verify DPR2 from the screenshot's real pixel dimensions
  (3200 × 2000 for a 1600 × 1000 viewport).
- **Dataset open bypasses `CachedStore`**, so no `RR*` line is emitted before the viewer navigates,
  even though open can take seconds against a many-member remote collection.
- Use a private `CARGO_TARGET_DIR`; the repo's own `target/` is very large and shared.
- `timeout(1)` does not exist on macOS — the runner and driver carry their own deadlines.
