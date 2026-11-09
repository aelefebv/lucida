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

`--network local,remote` starts a server under each source throttle profile in turn, so a
local dataset loads the way a remote one does; the `full` suite runs both. Without it the
runner passes `LUCIDA_SOURCE_THROTTLE` and its companions through to its server, and with
`--server` each run records whatever throttle that server reports. A throttled table says so
on its second line and in its throttle column, and `summary.json` records the throttle as
`sourceThrottle`.

`--server-env KEY=VALUE`, repeated for more, starts the runner's server with those
settings, such as `LUCIDA_SOURCE_READ_CONCURRENCY=64`. It never passes the caller's own
`LUCIDA_` settings otherwise. The table names them on a line of their own, and
`summary.json` records them as `selection.serverEnv`.

## The table

One row per dataset, scenario, ratio and network. Each column is a field of the run file's
diagnostic, or of its header where it says so. With `--repeat N` a number is the median of
the N runs, followed by half their range when they differ.

| column | field |
| --- | --- |
| throttle | the profile in `header.sourceThrottle`; `-` when unthrottled |
| first frame | `load.firstFrameMs` |
| settle | `load.settleMs`: the view has its wanted set drawn, prefetch left out |
| prefetch | `load.prefetchMs`: the last prefetched chunk decoded |
| fetched, chunks | `load.received.bytes`, `load.received.requests` |
| evicted | the `evictions` entry of `coverage.notHealthSignals` |
| short | `load.coverageLossChunks`: wanted chunks not resident at the close |
| top limiter | `attribution.cause` and `.confidence` |
| input to frame p95, longest task, dropped | `lag.inputToFrame.p95Ms`, `lag.longTasks.longestMs`, `lag.frames.dropped` |
| errors | the `header.errors` the allow list does not name, repeats counted |
| verdict | `verdict.kind` |

Times count from the run's start. A scenario with steps reports the run its last step
opened, and a row for each step follows, from its record in `header.script.steps`, which
carries that run's own load reading, attribution and lag. Its `duration` is the step run's
`durationUs`, which includes the quiescence hold that settle leaves out. A step with no
verdict says why, and the table lists it underneath.

## Baselines

`--save-baseline` keeps the results as the baseline for their adapter and device pixel
ratio, cell by cell; a cell with a failed run is not kept. A throttled cell has a key of its
own, such as `volume.orbit@remote`, and is never compared with an entry saved under another
throttle. So does a cell under server settings, such as
`collection.cold-open@remote[LUCIDA_SOURCE_READ_CONCURRENCY=64]`. Baselines live in `perf-baselines/` in the clone's git directory, which every
worktree shares and `cargo clean` leaves alone. `--baseline DIR` keeps them elsewhere.

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

The traits are `volume`, `time`, `channels` and `collection`.

## Scenarios

`scripts/perf/scenarios/` holds one file per interaction. A file has `steps` in the trace
script format, the `camera` that frames the dataset, the traits it `requires`, and an
optional `width` and `height`. The runner hands the file to `lucida trace --script`
unchanged, except that an add or remove step's `"url": "dataset:<name>"` becomes that
catalog dataset's location. A scenario never runs on the dataset it adds.

Keep a scenario to a few steps. The recorder drops its oldest runs to stay under its memory
cap, so a long script on a large volume can lose an early step's run before the export.

## Builds

Cargo decides whether the server and CLI are current. The runner rebuilds the wasm package
and the web bundle when the files git sees in their sources, or the built output itself,
differ from what it last built. A failed build stops the invocation before any run.

The server stays up for the whole invocation, or for each network in turn, so only a
dataset's first run meets a cold server. Under a throttled network every run gets a server of
its own, since a warm source cache would serve the later runs past the throttle. Every browser
starts cold. Each run file's `header.serverWarmth` says which case it was.

`--cli` runs a CLI that is already built, and `--server` drives a running server instead of
starting one. With both, the runner builds nothing. The server opens datasets by the path
the runner names, so it has to see `--data` at the same absolute path.

## The trace gate

The `gate` suite is what CI's "Trace gate" check runs under SwiftShader, through
`scripts/trace_gate.sh`. It passes `--gate`, so a run that stalls, never settles, or ends on
a failing verdict fails, and `--bundle`, so each run also leaves the bundle `lucida trace
replay` reads. The runner names the failed runs and exits non-zero. The script's header
lists the variables it reads; with none set, it builds and runs the whole suite locally:

```bash
scripts/trace_gate.sh
LUCIDA_GATE_CLI=target/release/lucida LUCIDA_GATE_SERVER=http://127.0.0.1:9876 scripts/trace_gate.sh
```

In a GitHub Actions job the runner also groups each run's text in the log, annotates each
failed run, and writes the table to the job summary.
