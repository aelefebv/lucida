# merged-range-reads harness (issue #1012)

Measurement tooling for `docs/research/merged-range-reads.md`. Not part of the
product and not wired into CI.

It reuses the remote-rates driver (`docs/research/remote-rates-harness/`, the
cold / idle / pan / zoom / warm phases at device pixel ratio 2) and replaces
the `gs://` fixture with a synthetic sharded dataset served by a local stand-in
that answers Range requests, delays every response by a fixed latency, and
logs every request. The before and after are read from that log, bucketed by
the driver's phase windows. Nothing here needs bucket credentials.

## Run it

1. Build the web dist and the server the way CI does, and keep the binary you
   want to measure somewhere the build will not overwrite:

   ```bash
   (cd lucida-core && wasm-pack build --target web --out-dir pkg)
   (cd lucida-web && pnpm install --frozen-lockfile && pnpm run build)
   cargo build -p lucida-server && cp target/debug/lucida-server /tmp/mrr/lucida-server-after
   ```

   For a before binary, build the same tree with the merge switched off (the
   `mergeable` binding in `lucida-store/src/cache.rs` set to `false`) and copy
   it aside the same way. Same tree, one line apart, is what makes the two
   columns comparable.

2. Write the dataset:

   ```bash
   uv run extras/synthetic_ome_zarr.py /tmp/mrr/data/merge-sharded.ome.zarr \
     --size 4096,4096 --chunk 64 --shard 512 --levels 4 --seed 3
   ```

3. Run each variant, alternating so no variant owns a stretch of machine
   weather:

   ```bash
   H=docs/research/merged-range-reads-harness
   bash $H/run_one.sh /tmp/mrr/runs/before-1 /tmp/mrr/lucida-server-before /tmp/mrr/data merge-sharded.ome.zarr 80
   bash $H/run_one.sh /tmp/mrr/runs/after-1  /tmp/mrr/lucida-server-after  /tmp/mrr/data merge-sharded.ome.zarr 80
   ```

4. Read them:

   ```bash
   python3 $H/analyse.py /tmp/mrr/runs/before-1 /tmp/mrr/runs/after-1
   python3 $H/concurrency.py /tmp/mrr/runs/after-1 80
   ```

`analyse.py` prints, per phase, the chunk range requests the stand-in saw,
the distinct shard objects, the bytes, and requests per second, then the
request-size distribution. `concurrency.py` prints a floor on how many reads
were in flight at once, which says whether the permit cap was binding at all.

## What to check before trusting a run

- `ready(cold)` and `ready(warm)` must both read `rendered`, and `cold.png`
  must be 3200 × 2000 for the driver's 1600 × 1000 viewport, or the run was
  not at device pixel ratio 2.
- The no-merge and contiguous-merge runs must move the same bytes. The wanted
  set is deterministic for one dist and one dataset, so a byte difference
  means the two runs did not see the same view.
- The stand-in's latency is the only latency. `range_server.py` runs on the
  loopback, so a request's time is the injected delay plus the transfer, and
  requests per second is bounded by the permit cap over that delay.
