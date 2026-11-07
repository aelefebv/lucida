# Recorder cost: the A/B harness

The trace recorder's cost is a set of ceilings asserted in CI, because
recording is unconditional and has no toggle. Three of its four gates
run in `pnpm test` from `lucida-web/src/trace/recorderCost.perf.test.ts`. That
file's header and constants carry the ceilings, the 16× slack and why, and the
derivation of the floor the recorder is compared against (#962).

The fourth gate is a frame throughput A/B of the real sink against a no-op
sink at device pixel ratio 2. It needs a hardware adapter, a release server and
a real fixture, none of which CI has, so it lives here. Re-run it when the
recorder's write path grows.

Each surface that draws while a run is open has its own `*Cost.perf.test.ts`
gate under the same contract.

## Run the CI gates alone

```bash
cd lucida-web && npx vitest run src/trace/recorderCost.perf.test.ts --reporter=verbose
```

The gates assert loose absolute bounds and log the real figures. Read the
`[#928]` and `[#962]` lines in the output for the numbers.

## Run the A/B

There is no runtime switch, by design, so the two arms are two builds of the
same tree. The no-op arm swaps the sink in the module singleton and nothing
else. The branches, the argument evaluation and the seam all stay, which is
the cost a user pays.

```bash
# 0. one release server binary, shared by both arms
cargo build --release -p lucida-server

# 1. arm A, the real sink
(cd lucida-web && pnpm run build:wasm && pnpm install && pnpm run build && mv dist ../dist-real)

# 2. arm B, the no-op sink: edit recorder.ts as below, build, then revert
(cd lucida-web && pnpm run build && mv dist ../dist-noop)
git checkout -- lucida-web/src/trace/recorder.ts

# 3. run both arms against the same fixture
AB_WEB_DIST=$PWD/dist-real python3 docs/perf/recorder-cost/ab_run.py /tmp/ab <fixture>.zarr real
AB_WEB_DIST=$PWD/dist-noop python3 docs/perf/recorder-cost/ab_run.py /tmp/ab <fixture>.zarr noop

# 4. read the verdict
python3 docs/perf/recorder-cost/ab_compare.py /tmp/ab
```

For step 2, open `lucida-web/src/trace/recorder.ts`, add `noopSinkFactory` to
the import from `./sink.ts`, and change the `traceRecorder` singleton at the
end of the file to `new TraceRecorder({ sinkFactory: noopSinkFactory })`.

`ab_run.py` uses the tryout harness in `extras/tryout` to boot and reap the
server, and its docstring lists the environment knobs. `AB_MODE=heap` adds a
post-GC live heap reading over CDP at the end of the drive, for comparing two
trees on memory instead of frames.

Pick a real fixture, such as a multi-GB 3D time series or a wide collection. A
small 2D image exercises almost none of the write path, and an A/B over a page
that records nothing proves nothing.

## Gotchas

- Device pixel ratio 2 is required. At ratio 1 the renderer draws a quarter of
  the pixels and hits a different bottleneck, and ratio-1-only checks have
  hidden whole classes of defects in this project.
- The bundled Playwright Chromium has no WebGPU. `ab_run.py` resolves the
  system Chrome, and exits without one rather than measure a canvas that never
  drew.
- Measure a warm re-open, not a cold open. A cold open is dominated by the
  network, which drowns the thing being measured.
- Drive a slow orbit, not an idle page. The render loop draws only when
  something is dirty, so a still viewer draws nothing and both arms tie at
  zero.
- `ab_run.py` drops `GOOGLE_APPLICATION_CREDENTIALS`, so an object-store
  fixture falls through to the user's application default credentials rather
  than a service account with no access.
- Check `trace_seam_schema` in both arms' run files. A null in the no-op arm
  means the edit removed more than the sink.

## Last result

Frame throughput, 2026-08-11. The same tree twice, differing only by the sink.
Device pixel ratio 2, warm re-open of a 251 MB local OME-Zarr dataset, release
server, system Chrome with WebGPU, M-series laptop.

| Arm | Frames in 10 s | fps | Warm first render |
| --- | --- | --- | --- |
| real sink | 1,133 | 112.9 | 148 ms |
| no-op sink | 1,144 | 114.2 | 207 ms |

The arms are 1.0% apart, inside the 5% band, and both sit within 1.3% of the
1,148 frames #888 measured on the same shape. The recorder does not show in
frame throughput.

Live heap, 2026-08-11, across the debug panel teardown (#919), with
`AB_MODE=heap` and the same drive. This settled the memory half of the
recorder's net obligation: total observability cost no higher than the
floor #888 measured.

| Arm | Live heap, post-GC | Frames in 10 s |
| --- | --- | --- |
| before, panel never opened | 4.693 MB | 1,151 |
| before, panel open | 5.730 MB | 1,150 |
| after | 4.713 MB | 1,153 |
| after, repeat | 4.701 MB | 1,154 |

The panel cost 1.04 MB live while open, about 85 times the 12 kB spread
between repeat runs, and the teardown returned it. The per-tick half of the
obligation is the `[#962] matched-shape tick` gate in CI.

### Not yet re-measured

These changes landed after the last run. Each passed its CI gate, but none has
had the A/B on a hardware adapter.

- #949 removed two calls and two handle lookups per chunk from the write path.
  It can only have moved the real arm toward the no-op arm, so the 1.0% stands
  as an upper bound.
- #1074 added send-side accounting: four integer increments per message the
  bridge sends, and a tick sample 64 bytes wider. No timed gate includes a
  send, so only the A/B would see it.
- #1056 and #1062 widened a lifecycle row from 76 to 92 bytes and added one
  hash probe per row birth. The floor check's live state grew from 663 kB to
  about 822 kB, still under the 1.05 MB floor.
- The dock's live charts (#1064) and the volume overlay (#1063) each gate their
  pure work. The browser's cost of drawing them, shown against hidden, has not
  been measured.
