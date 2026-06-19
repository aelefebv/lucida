# lucida agent tryout harness

Two commands, both real and end-to-end against a live `lucida-server` brought up
**from the current working tree** (not a mock):

- **`up`** — bring up a live server, report how to reach it as machine-readable
  JSON, capture a server log, then tear it down cleanly.
- **`drive`** — bring up a live server, then **exercise lucida's surfaces the way
  an agent would** — the `lucida` CLI, the `LucidaClient` Python client, and the
  **web** surface (a non-blank screenshot of the real rendered viewer, plus a
  best-effort real-SPA full-page capture + browser console) — capturing every
  step's output, then tear it down.

`up` is the spine; `drive` builds on it and adds the CLI / Python / web surfaces,
each a thin, separable adapter over the same booted server.

## `up`: bring up + tear down

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

## `drive`: exercise the surfaces + capture

```bash
python3 extras/tryout/tryout.py drive --json --out DIR --fixture PATH \
  [--surface cli,python,web,all]
```

Brings the env up (same hermetic spine as `up` — free port, throwaway DB, auth
disabled, fixture opened **read-only**), then runs a representative agent tour of
the requested surface(s) **against the real opened dataset** and captures
everything, then always tears the server down.

- `--surface` — `cli`, `python`, `web`, or `all` (default), comma-separated. Only
  the requested surfaces appear in the result.
- **CLI surface** — a broad tour of the actual `lucida` binary
  (`LUCIDA_TRYOUT_CLI`, else `cargo run -p lucida-cli --`): status/identity,
  workspace list + info, dataset list + info + health, viewer state, a real view
  mutation (`view set-zoom`) and a layer mutation, in **both** human and `--json`
  form. Each command is captured to `DIR/cli/NN-<name>.log` (argv + exit code +
  stdout + stderr).
- **Python surface** — a broad `LucidaClient` session (`from lucida import
  LucidaClient`, driven against the working-tree `lucida-py` source via `uv` — no
  native build): connect, status, select the workspace, list datasets, dataset
  info + health, layer/debug reads, a view mutation and a layer mutation. The
  transcript is captured to `DIR/python/session.log`.
- **Web surface** — captures what lucida *looks like*, in two layers:
  - **Floor (required):** boots the server with `LUCIDA_WEB_DIST` set to a real
    SPA bundle (reuses `LUCIDA_TRYOUT_WEB_DIST` if it has `index.html`, else
    builds it via `wasm-pack` + `pnpm`), then drives the **actual product CLI**
    (`lucida viewer screenshot DIR/web/viewer.png`, and `viewer overview`) which
    renders the real viewer in headless Chrome and writes a **non-blank** PNG.
    The captured workspace **URL** is recorded so a human can re-open the view.
  - **Ceiling (best-effort):** drives the real SPA itself in a browser via
    **Playwright** (provisioned through `npm` into a harness cache, pointed at the
    same system Chrome — no browser download), waits for the same render-readiness
    signal the product uses, then captures a full-page `DIR/web/spa.png` and the
    browser `DIR/web/console.log`. If Playwright or a browser can't be
    provisioned this is recorded as `{captured: false, reason}` and the floor
    still stands.
- The full result is written to `DIR/drive.json` and printed (one JSON object
  under `--json`). `DIR/server.log` is captured too.

A single CLI command (or Python step) returning non-zero is **captured, not
fatal** — the tour continues and records it, because an agent wants to see *what*
failed. The run exits non-zero only if bring-up failed or a *requested surface
could not be exercised at all* (e.g. the CLI binary is missing).

### Result object (`drive`)

One JSON object with at least: `ok` (true iff bring-up succeeded and each
requested surface ran without a harness-level error), `out_dir`, `workspace_id`,
`dataset_id`, `teardown`, and `surfaces`:

```jsonc
{
  "ok": true,
  "workspace_id": "…", "dataset_id": "wds-…", "teardown": "clean",
  "surfaces": {
    "cli": {
      "ran": true, "ok": true, "passed": 16, "total": 16,
      "log_dir": "DIR/cli",
      "commands": [{ "name": "status", "argv": ["…"], "exit_code": 0, "ok": true }, …]
    },
    "python": {
      "ran": true, "ok": true, "log": "DIR/python/session.log",
      "steps": [{ "name": "status", "ok": true, "summary": { … } }, …]
    },
    "web": {
      "ran": true, "ok": true,
      "viewer_png": "DIR/web/viewer.png", "viewer_png_nonblank": true,
      "viewer_url": "http://127.0.0.1:PORT/w/<id>?viewer_profile=default",
      "captures": [
        { "name": "viewer", "png": "DIR/web/viewer.png", "nonblank": true, "ok": true },
        { "name": "overview", "png": "DIR/web/overview.png", "nonblank": true, "ok": true }
      ],
      "real_spa": {
        "captured": true, "reason": "rendered",
        "spa_png": "DIR/web/spa.png", "spa_png_nonblank": true,
        "console_log": "DIR/web/console.log",
        "render": { "ready": true, "frame_count": 2, "dataset_count": 1 }
      }
    }
  }
}
```

The web surface's `ok` requires a **non-blank** `viewer.png` (the required
floor); a failed `overview` or a skipped real-SPA ceiling is captured but never
flips `ok`. `real_spa.captured: false` carries a `reason` (e.g. Playwright/Chrome
not provisionable) — the floor still stands.

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
| `LUCIDA_TRYOUT_WEB_DIST` | Reuse this prebuilt `lucida-web/dist` (must contain `index.html`) for the web surface; else it is built from the working tree. |
| `LUCIDA_TRYOUT_PLAYWRIGHT_DIR` | A `node_modules`-parent dir where Playwright is provisioned/cached for the real-SPA ceiling (default: `~/.cache/lucida-tryout/playwright`). |
| `LUCIDA_BROWSER` | Browser executable used by both the floor (product CLI) and the real-SPA ceiling; defaults to the platform's Chrome/Chromium/Edge. |

## Layout

```
extras/tryout/
  tryout.py            # thin entrypoint (path shim -> tryout.cli)
  tryout/
    cli.py             # argv, output, exit codes, signal handling (up + drive)
    bringup.py         # `up`: bring-up -> report -> teardown lifecycle
    drive.py           # `drive`: bring-up -> exercise surfaces -> capture -> teardown
    server.py          # boot / health-gate / reap the throwaway server (the spine)
    web.py             # resolve (or build) the SPA bundle the server serves (web)
    surfaces/
      python_client.py # workspace create + dataset open via LucidaClient (bring-up)
      cli_surface.py   # drive the real `lucida` CLI tour, capture each command
      python_surface.py# broad LucidaClient read/mutate tour, capture transcript
      web_surface.py   # non-blank viewer screenshot (CLI) + real-SPA Playwright capture
    capture.py         # shared record shape + on-disk artifacts (up.json/drive.json)
    netutil.py         # free-port allocation, /healthz polling
    errors.py          # staged TryoutError
```

The `surfaces/` package is where each way of driving the server lives, each a
thin adapter over the same booted server. `drive` reuses the `server.py` spine
and the `python_client.py` bring-up wholesale rather than re-implementing the
lifecycle; the web surface additionally points the server at a SPA bundle
(`web.py`) before boot so the real viewer can be rendered.

## Fast self-test

```bash
# up: bring up + tear down
LUCIDA_TRYOUT_SERVER_BIN=target/debug/lucida-server \
  python3 extras/tryout/tryout.py up --once --json \
  --out /tmp/tryout-check --fixture /path/to/dataset.ome.zarr

# drive: bring up, exercise ALL surfaces (cli + python + web), capture, tear down
LUCIDA_TRYOUT_SERVER_BIN=target/debug/lucida-server \
LUCIDA_TRYOUT_CLI=target/debug/lucida \
LUCIDA_TRYOUT_WEB_DIST=lucida-web/dist \
  python3 extras/tryout/tryout.py drive --surface all --json \
  --out /tmp/tryout-drive --fixture /path/to/dataset.ome.zarr

# verify the web screenshot is a real, content-bearing render:
python3 scripts/assert_png_nonblank.py /tmp/tryout-drive/web/viewer.png
```

For `up`: expect exit 0, a JSON object on stdout with a `127.0.0.1:PORT` base URL
(not 9876) and real `workspace_id` / `dataset_id`, a non-empty
`/tmp/tryout-check/server.log`, and `/tmp/tryout-check/up.json`.

For `drive`: expect exit 0, `surfaces.cli` with several captured commands (each
with an `exit_code`), `surfaces.python.ran` true, and `surfaces.web.ok` true with
a **non-blank** `/tmp/tryout-drive/web/viewer.png` and a recorded `viewer_url`
(plus `web/spa.png` + `web/console.log` when the real-SPA ceiling is available);
non-empty `/tmp/tryout-drive/cli/*.log` and `/tmp/tryout-drive/python/session.log`,
`/tmp/tryout-drive/drive.json`, `teardown: "clean"`, and no orphaned
`lucida-server` (or headless browser).
