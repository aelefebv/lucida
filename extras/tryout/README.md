# lucida agent tryout harness

One command that brings up a live `lucida-server` **from the current working
tree**, reports how to reach it as machine-readable JSON, captures a server log
for human verification, then tears the server down cleanly. It is the spine the
later CLI / Python / web tryout surfaces build on.

This is real and end-to-end: it boots an actual server and talks to it through
the maintained Python client. It is not a mock.

## Usage

```bash
python3 extras/tryout/tryout.py up --once --json --out DIR [--fixture PATH]
```

- `--out DIR` — where `server.log` and `up.json` are written (created if absent).
- `--fixture PATH` — an OME-Zarr dataset to open **read-only** (or set
  `LUCIDA_TRYOUT_FIXTURE`). Omit it to just bring up an empty workspace.
- `--json` — print one JSON object to stdout (the machine-readable result). With
  it, **stdout is pure JSON** and all human chatter goes to stderr, so you can
  pipe straight into `json.load`. Without it you get a human summary; `up.json`
  and `server.log` are still written.
- `--once` — capture, then tear the server down and exit.

`python3 extras/tryout/tryout.py --help` and `… up --help` describe every flag.

### Result object

One JSON object with at least: `ok`, `base_url` (`http://127.0.0.1:PORT`),
`ws_url`, `workspace_id`, `out_dir`, `server_log`, `db_path`, `pid`, `fixture`,
`dataset_id`, `healthz`, `teardown` (`"clean"`). The same record is written to
`DIR/up.json`. On failure, `ok` is `false` and an `error` object carries a
`stage` tag and message (plus the server's structured diagnostic when a dataset
open fails), and the process exits non-zero.

## What it does, and the guarantees it keeps

Lifecycle: **build (or reuse) → boot → health-gate → create workspace / open
fixture → report → teardown.**

- **Reflects your working tree.** By default it runs `cargo build -p
  lucida-server` so uncommitted changes are in play, then uses the produced
  binary. The workspace/dataset calls go through the working-tree Python client
  source (`lucida-py/python`).
- **Fast path for the test/agent loop.** Set `LUCIDA_TRYOUT_SERVER_BIN` to a
  prebuilt `lucida-server` to skip the build. `LUCIDA_TRYOUT_CLI` is honored for
  a prebuilt `lucida` CLI (reserved for the CLI surface).
- **Safe by construction.** Binds a free ephemeral port on loopback (never
  assumes `9876`), uses a throwaway temp DB under a temp dir, sets
  `LUCIDA_AUTH=disabled`. It never touches the repo's real `lucida.db` and never
  writes outside `DIR` / its temp dir. Fixtures are opened read-only.
- **Always reaps the server.** Success, failure, exception, or signal — the
  server child (and its process group) is torn down; no orphaned processes, no
  leaked ports, temp DB removed. A hang is treated as a failure (health and
  dataset-open both have timeouts).

## Environment variables

| Variable | Effect |
| --- | --- |
| `LUCIDA_TRYOUT_SERVER_BIN` | Reuse this prebuilt `lucida-server`; skip the build. |
| `LUCIDA_TRYOUT_CLI` | Reuse this prebuilt `lucida` CLI binary. |
| `LUCIDA_TRYOUT_FIXTURE` | Default `--fixture` path. |
| `LUCIDA_TRYOUT_UV` | `uv` binary used to drive the `lucida-py` client. |
| `LUCIDA_TRYOUT_PY` | Override the whole interpreter prefix for the client driver (e.g. `"uv run --project lucida-py python"`). |

## Layout

```
extras/tryout/
  tryout.py            # thin entrypoint (path shim -> tryout.cli)
  tryout/
    cli.py             # argv, output, exit codes, signal handling
    bringup.py         # bring-up -> report -> teardown lifecycle
    server.py          # boot / health-gate / reap the throwaway server
    surfaces/
      python_client.py # workspace create + dataset open via LucidaClient
    capture.py         # up.json record + artifacts
    netutil.py         # free-port allocation, /healthz polling
    errors.py          # staged TryoutError
```

The `surfaces/` package is where later CLI and web surfaces slot in alongside
the Python one; each is a thin adapter over the same booted server.

## Fast self-test

```bash
LUCIDA_TRYOUT_SERVER_BIN=target/debug/lucida-server \
  python3 extras/tryout/tryout.py up --once --json \
  --out /tmp/tryout-check --fixture /path/to/dataset.ome.zarr
```

Expect exit 0, a JSON object on stdout with a `127.0.0.1:PORT` base URL (not
9876) and real `workspace_id` / `dataset_id`, a non-empty `/tmp/tryout-check/server.log`,
and `/tmp/tryout-check/up.json`.
