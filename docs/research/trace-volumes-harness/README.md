# trace-volumes harness (issue #888)

Measurement tooling for `docs/research/trace-volumes.md`. Not part of the product and not
wired into CI. Reproduces the per-stage event counts at devicePixelRatio 2.

```bash
# 1. build the real large fixtures (~21 GB on disk, ~1 min)
python3 docs/research/trace-volumes-harness/gen_fixtures.py /tmp/tv/fixtures all

# 2. apply the throwaway counter instrumentation and rebuild the web bundle
git apply docs/research/trace-volumes-instrumentation.patch
(cd lucida-core && wasm-pack build --target web --out-dir pkg)
(cd lucida-web && pnpm install --force && pnpm run build)

# 3. run (boots lucida-server from the tree, opens the fixture, drives Chrome at DPR2)
python3 docs/research/trace-volumes-harness/tv_run.py /tmp/tv/run-v  /tmp/tv/fixtures/volume-timeseries.zarr
python3 docs/research/trace-volumes-harness/tv_run.py /tmp/tv/run-c  /tmp/tv/fixtures/wide-collection.zarr

# 4. read it
python3 docs/research/trace-volumes-harness/show.py /tmp/tv/run-c

# 5. put the tree back
git checkout -- lucida-web/src && rm -f lucida-web/src/debug/traceVolumes.ts \
  lucida-web/src/debug/tvTelemetryFloor.test.ts
```

The telemetry-floor microbenchmark ships inside the same patch as
`lucida-web/src/debug/tvTelemetryFloor.test.ts`; run it with
`(cd lucida-web && npx vitest run src/debug/tvTelemetryFloor.test.ts)` and read the
`FLOOR` / `RETAINED` console lines. It intentionally exceeds vitest's 5 s timeout — the
numbers are printed before the failure.

Gotchas that cost time the first run:

- `tv_run.py` drops `GOOGLE_APPLICATION_CREDENTIALS` so an object-store fixture falls through
  to the user ADC rather than a service account with no access.
- The driver picks its drag centre with `document.elementFromPoint` because floating panels
  overlay the canvas; a naive viewport-centre drag records zero events on a collection.
- A drag that lands on a member registers a pick, not a camera move. If a phase reports zero
  ticks, check the phase screenshot before believing the number.
- The counter module lives on `window`, so nothing inside the render worker is captured.
