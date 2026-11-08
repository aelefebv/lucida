# Perf runs

`scripts/perf.py` runs `lucida trace` over datasets × scenarios × device pixel ratios and
prints one table.

```bash
uv run scripts/perf.py                      # the quick suite
uv run scripts/perf.py --suite full
uv run scripts/perf.py --dataset volume --scenario orbit,z-scrub --ratio 2 --repeat 3
uv run scripts/perf.py --list               # datasets, scenarios, suites
uv run scripts/perf.py --suite full --dry-run
uv run scripts/perf.py --repeat 3 --save-baseline   # keep these results as the reference
```

It rebuilds what is stale, generates the datasets it needs, and starts its own server on a
free port with its own database. Each run gets a workspace of its own. On the way out it
stops the server and every browser it started, after Ctrl-C too. The table, `summary.md`
and `summary.json` go to `target/perf/runs/<time>/` beside the run files, and
`lucida trace show <run file>` reads any run deeper. `--help` lists the other flags.

Speed numbers need a GPU. CI renders with SwiftShader, which shows whether a view settles
but not how fast. The table's first line names the adapter.

## The table

One row per dataset, scenario and ratio. Each column is a field of the run file's
diagnostic. With `--repeat N` a number is the median of the N runs, followed by half their
range when they differ.

| column | field |
| --- | --- |
| first frame | `load.firstFrameMs` |
| settle | `load.settleMs` |
| fetched, chunks | `load.received.bytes`, `load.received.requests` |
| evicted | the `evictions` entry of `coverage.notHealthSignals` |
| top limiter | `attribution.cause` and `.confidence` |
| verdict | `verdict.kind` |
| steps | each script step's verdict, from `header.script` |

Times count from the run's start. A scenario with steps reports the run its last step
opened, so the steps column is where an earlier step's stall shows.

## Baselines

`--save-baseline` keeps the results as the baseline for their adapter and device pixel
ratio, cell by cell; a cell with a failed run is not kept. Baselines live in
`perf-baselines/` in the clone's git directory, which every worktree shares and
`cargo clean` leaves alone. `--baseline DIR` keeps them elsewhere.

Every invocation compares against its adapter's baseline, if one was saved. A `vs baseline`
column names what moved by more than the noise allowance in `METRICS` in `scripts/perf.py`,
and regressions sort first. A regression, a view that no longer settles included, exits 1,
as a failed run does. A baseline from another adapter is never compared: a file that names
one exits 2, as a setup error does.

`--knob NAME=VALUE` passes a Dev controls knob to every run; `--knob max-fetches=1` is a
slowdown the comparison flags.

## Selection

A suite in `scripts/perf/suites.json` names datasets, scenarios and ratios. `--dataset`,
`--scenario` and `--ratio` replace that part of the suite. With no suite, whatever the
flags leave open means every dataset, every scenario, and ratios 1 and 2. A scenario never
runs on a dataset it does not apply to.

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
unchanged.

## Builds

Cargo decides whether the server and CLI are current. The runner rebuilds the wasm package
and the web bundle when the files git sees in their sources, or the built output itself,
differ from what it last built. A failed build stops the invocation before any run.

The server stays up for the whole invocation, so only a dataset's first run meets a cold
server. Every browser starts cold. Each run file's `header.serverWarmth` says which case it
was.

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
