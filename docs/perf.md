# Perf runs

`scripts/perf.py` runs `lucida trace` over datasets × scenarios × device pixel ratios and
prints one table.

```bash
uv run scripts/perf.py                      # the quick suite
uv run scripts/perf.py --suite full
uv run scripts/perf.py --dataset volume --scenario orbit,z-scrub --ratio 2 --repeat 3
uv run scripts/perf.py --list               # datasets, scenarios, suites
uv run scripts/perf.py --suite full --dry-run
```

It rebuilds what is stale, generates the datasets it needs, and starts its own server on a
free port with its own database. Each run gets a workspace of its own. On the way out it
stops the server and every browser it started, after Ctrl-C too. The table, `summary.md`
and `summary.json` go to `target/perf/runs/<time>/` beside the run files, and
`lucida trace show <run file>` reads any run deeper. `--help` lists the other flags.

Speed numbers need a GPU. CI renders with SwiftShader, which shows whether a view settles
but not how fast. The table's first line names the adapter.

The runner passes `LUCIDA_SOURCE_THROTTLE` and its companions through to its server, so a
local dataset can load like a remote one. A throttled table says so on its second line, and
`summary.json` records the throttle as `sourceThrottle`.

## The table

One row per run. Each column is a field of the run file's diagnostic.

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
