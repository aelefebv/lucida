# Perf runs

`scripts/perf.py` runs `lucida trace` over datasets × scenarios × device pixel ratios and
prints one table.

```bash
uv run scripts/perf.py                      # the quick suite
uv run scripts/perf.py --suite full
uv run scripts/perf.py --dataset volume --scenario orbit,z-scrub --ratio 2 --repeat 3
uv run scripts/perf.py --list               # datasets, scenarios, suites
uv run scripts/perf.py --suite full --dry-run
uv run scripts/perf.py --network remote --scenario pan-sustained
uv run scripts/perf.py --suite phone        # cold opens on a 390x844 phone at ratio 3
uv run scripts/perf.py --suite four-up      # four-up next to one view, opened and scrubbed
uv run scripts/perf.py --suite hover        # the pointer across one view, alone and with crosshairs elsewhere
uv run scripts/perf.py --repeat 3 --save-baseline   # keep these results as the reference
```

It rebuilds what is stale, generates the datasets it needs, and starts its own server on a
free port with its own database. Each run gets a workspace of its own. On the way out it
stops the server and every browser it started, after Ctrl-C too. The table, `summary.md`
and `summary.json` go to `target/perf/runs/<time>/` beside the run files, and
`lucida trace show <run file>` reads any run deeper, with no server. `--help` lists the
other flags.

Speed numbers need a GPU. CI renders with SwiftShader, which shows whether a view settles
but not how fast. The table's first line names the adapter.

SwiftShader also stands in for a GPU far weaker than a desktop's, such as a phone's.
`LUCIDA_BROWSER_ARGS` adds flags to the browser the CLI starts, so
`LUCIDA_BROWSER_ARGS=--use-webgpu-adapter=swiftshader uv run scripts/perf.py --suite phone`
runs the phone suite on it on any machine. Its runs keep a baseline of their own, under that
adapter.

`--network local,remote` starts a server under each network in turn. A network sets two
server throttles: the source throttle on the server's reads, so a local dataset loads the way
a remote one does, and the link throttle on the session socket, so the page waits for its
chunks the way a page across a network does.

| network | source throttle | link throttle | models |
| --- | --- | --- | --- |
| `local` | off | off | the server, its data and the page on one machine |
| `object-store` | `object-store` | off | a server beside its object store, the page beside it |
| `remote` | `remote` | `broadband` | a server across a continent from its store, the page on an office or home link |
| `deployed` | `object-store` | `broadband` | a deployed viewer: a server beside its store, the page on an office or home link |

The `full` suite runs `local` and `remote`. Without `--network` the runner passes
`LUCIDA_SOURCE_THROTTLE`, `LUCIDA_LINK_THROTTLE` and their companions through to its server,
and with `--server` each run records whatever throttles that server reports. A throttled
table says so on its second line and in its throttle column, and `summary.json` records the
throttles as `sourceThrottle` and `linkThrottle`. The run file's `header.chunkRelay` says
whether the server sent chunks still encoded: by default only to a page on another machine,
or to any page under a link throttle, so a throttled run measures the relay and a local one
does not. `--server-env LUCIDA_CHUNK_RELAY=always` or `never` overrides it.

`--server-env KEY=VALUE`, repeated for more, starts the runner's server with those
settings, such as `LUCIDA_SOURCE_READ_CONCURRENCY=64`, though not a throttle's, which a
network sets. `TOKIO_WORKER_THREADS=2` and `LUCIDA_DECODE_THREADS=2` give it the async
workers and decode threads of a two-core machine. It never passes the caller's own `LUCIDA_`
settings otherwise. The table names them on a line of their own, and `summary.json` records
them as `selection.serverEnv`.

## The table

One row per dataset, scenario, ratio and network. Each column is a field of the run file's
diagnostic, or of its header where it says so. With `--repeat N` a number is the median of
the N runs, followed by half their range when they differ.

| column | field |
| --- | --- |
| throttle | the profile in `header.sourceThrottle`, then `link-` and the one in `header.linkThrottle`; `-` when neither |
| first frame | `load.firstFrameMs` |
| settle | `load.settleMs`: the view has its wanted set drawn, prefetch left out |
| prefetch | `load.prefetchMs`: the last prefetched chunk decoded |
| fetched, chunks | `load.received.bytes`, `load.received.requests`: the chunks' bytes decoded |
| wire | `load.received.wireBytes`: what the wire carried, less than fetched for chunks sent still encoded |
| evicted | the `evictions` entry of `coverage.notHealthSignals` |
| short | `load.coverageLossChunks`: wanted chunks not resident at the close |
| top limiter | `attribution.cause` and `.confidence` |
| first input to frame, input to frame p95, longest task, dropped | `lag.firstInputMs`, `lag.inputToFrame.p95Ms`, `lag.longTasks.longestMs`, `lag.frames.dropped` |
| errors | the `header.errors` the allow list does not name, repeats counted |
| verdict | `verdict.kind`; `bound` is a run that spent most of its chain in one phase and failed nothing |

Times count from the run's start. A scenario with steps reports the run its last step
opened, and a row for each step follows, from its record in `header.script.steps`, which
carries that run's own load reading, attribution and lag. Its `duration` is the step run's
`durationUs`, which includes the quiescence hold that settle leaves out. A step with no
verdict says why, and the table lists it underneath.

## Baselines

`--save-baseline` keeps the results as the baseline for their adapter and device pixel
ratio, cell by cell; a cell with a failed run is not kept. A throttled cell has a key of its
own, such as `volume.orbit@remote+link-broadband`, and is never compared with an entry saved
under other throttles. So does a cell under server settings, such as
`collection.cold-open@remote+link-broadband[LUCIDA_SOURCE_READ_CONCURRENCY=64]`. Baselines
live in `perf-baselines/` in the clone's git directory, which every worktree shares and
`cargo clean` leaves alone. `--baseline DIR` keeps them elsewhere.

Every invocation compares against its adapter's baseline, if one was saved. A `vs baseline`
column names what moved by more than the noise allowance in `METRICS` in `scripts/perf.py`,
and regressions sort first. A regression, a view that no longer settles included, exits 1,
as a failed run does. A baseline from another adapter is never compared: a file that names
one exits 2, as a setup error does.

`--knob NAME=VALUE` passes a Dev controls knob to every run; `--knob max-fetches=1` is a
slowdown the comparison flags. A device override goes the same way: `--knob cores=4` drives
the page as a 4-core machine, and `--knob device-memory=4` as one with 4 GiB.

## Selection

A suite in `scripts/perf/suites.json` names datasets, scenarios, ratios and, optionally,
networks. `--dataset`, `--scenario`, `--ratio` and `--network` replace that part of the
suite. With no suite, whatever the flags leave open means every dataset, every scenario,
ratios 1 and 2, and the server as the environment sets it. `--network` alone runs the quick
suite under it. A scenario never runs on a dataset it does not apply to.

## Datasets

`scripts/perf/datasets.json` lists generated datasets by their
`extras/synthetic_ome_zarr.py` options. The runner caches them in `target/perf/datasets/`,
or `--data`, under a key made of those options and the generator's own bytes.

Real datasets go in `scripts/perf/datasets.local.json`, which git ignores. Each needs a
`url`, an absolute path or a URL the server can read, and its `traits`:

```json
{ "datasets": { "big-volume": { "url": "/srv/data/big.ome.zarr", "traits": ["volume", "channels"] } } }
```

The traits are `volume`, `time`, `channels`, `collection`, `labels` and `physical`, a
dataset that declares length units and so lines up with another over the same region.

## Scenarios

`scripts/perf/scenarios/` holds one file per interaction. A file has `steps` in the trace
script format, the `camera` that frames the dataset, the traits it `requires`, and an
optional `width` and `height`. `"mobile": true` drives the page as a phone, with a mobile
layout, touch input and a mobile user agent (`lucida trace --mobile`). `"fullUi": true` loads
the full viewer page instead of the chrome-free capture surface (`lucida trace --full-ui`), so
the run also checks that the top bar and a phone's bottom sheet sit wholly on screen. The
`phone` suite runs `phone-cold-open`, `phone-full-ui` and `phone-settle-then-orbit` at ratio 3. The runner hands the file
to `lucida trace --script` unchanged, except that an add or remove step's
`"url": "dataset:<name>"` becomes that catalog dataset's location. A scenario never runs on the dataset it adds.

Keep a scenario to a few steps. The recorder drops its oldest runs to stay under its memory
cap, so a long script on a large volume can lose an early step's run before the export.

## Builds

Cargo decides whether the server and CLI are current. The runner rebuilds the wasm package
and the web bundle when the files git sees in their sources, or the built output itself,
differ from what it last built. A failed build stops the invocation before any run.

The server stays up for the whole invocation, or for each network in turn, so only a
dataset's first run meets a cold server. Under a network with a source throttle every run
gets a server of its own, since a warm source cache would serve the later runs past the
throttle. Every browser starts cold. Each run file's `header.serverWarmth` says which case
it was.

`--cli` runs a CLI that is already built, and `--server` drives a running server instead of
starting one. With both, the runner builds nothing. The server opens datasets by the path
the runner names, so it has to see `--data` at the same absolute path.

## The trace gate

The `gate` suite is what CI's "Trace gate" check runs under SwiftShader, through
`scripts/trace_gate.sh`. It passes `--gate`, so a run that stalls, never settles, or ends on
a failing verdict (`fail`, `steady-state` or `unsettled`) fails, and a `bound` one passes. It
passes `--bundle`, so each run also leaves the bundle `lucida trace replay` reads. The runner
names the failed runs and exits non-zero. The script's header lists the variables it reads;
with none set, it builds and runs the whole suite locally:

```bash
scripts/trace_gate.sh
LUCIDA_GATE_CLI=target/release/lucida LUCIDA_GATE_SERVER=http://127.0.0.1:9876 scripts/trace_gate.sh
```

In a GitHub Actions job the runner also groups each run's text in the log, annotates each
failed run, and writes the table to the job summary. Each job keeps its run files as an
artifact for 14 days, and its bundles too when it fails.

## Ceilings

A ceiling in `lucida-web/src/trace/diagnose/ruleset.ts` is the p95 at which a person would
notice the delay a phase makes, not a margin over an old baseline. These four were set that
way and checked against the runs listed below the table; the rest are still provisional.

| rule | p95 ceiling | the delay a person would see | worst healthy p95 measured |
| --- | --- | --- | --- |
| `io.wire` | 1,000 ms, was 1,500 | A region stays coarse until its chunks land, and past a second the person stops watching it fill in and waits. | idle 316 ms local, 984 ms for a 2D image over `remote`; shared 633 ms; SwiftShader 351 ms |
| `compute.upload` | 100 ms | A chunk already decoded trails a scrub or a switch of layout or mode, and past 100 ms the region visibly lags the input. | idle 82 ms, four views at ratio 2; the gate never judges it, since a cold open's upload is first paint |
| `server.dispatch` | 100 ms, was 10 | Every chunk's detail trails the move that brought it into view by this much, and past 100 ms that shows. | idle 3.9 ms; shared 33 ms; SwiftShader 3.3 ms, and 61 ms on 0.27.1 |
| `server.cache-lookup` | 100 ms, was 10 | The same as dispatch. | idle 16 ms for a deep volume's scrub, under 5 ms otherwise; shared 51 ms; SwiftShader 0.2 ms |

A busy machine stalls every request in flight at the same moment, so it moves a run's p95,
not just its tail. No other percentile or minimum row count separates that from a slow
phase. A ceiling at a person's scale stays clear of it, where the old 10 ms server ceilings
failed gate runs on it.

- **idle**: an RTX A6000 on Windows with nothing else running, 2026-11-12, `main` at
  5e0b6c98 and 7b7d69f5. 120 run files, 240 runs counting script steps, from the `gate`,
  `quick`, `four-up` and `hover` suites, `volume` gestures and `deep-volume` scrubs. Plus 34
  run files over the `remote` and `deployed` networks.
- **shared**: the same machine while other perf jobs ran on it, 2026-11-11 to 11-12, builds
  of `main` and branches off it. 2,414 run files, 4,536 runs.
- **SwiftShader**: CI's trace gate. 10 runs of a passing gate, 2026-11-12, build 0.39.2. 72
  run files kept by failed jobs, 2026-11-08 to 11-09, builds 0.24.0 to 0.27.1.
  610 runs in 61 workflow runs, 2026-11-11 to 11-12, whose logs show none of the four over
  its old ceiling.
