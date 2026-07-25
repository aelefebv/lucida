# lucida agent tryout harness

Three commands, all real and end-to-end against a live `lucida-server` brought up
**from the current working tree** (not a mock):

- **`up`** — bring up a live server, report how to reach it as machine-readable
  JSON, capture a server log, then tear it down cleanly.
- **`drive`** — bring up a live server, then **exercise lucida's surfaces the way
  an agent would** — the `lucida` CLI, the `LucidaClient` Python client, and the
  **web** surface (a non-blank screenshot of the real rendered viewer, plus the
  real SPA driven in a real browser at `deviceScaleFactor` 2 *and* 1, gating on
  the retina one actually presenting a content frame) — capturing every
  step's output, then tear it down.
- **`report`** — the capstone: run **every** surface (it reuses `drive --surface
  all`) and emit a single, **self-contained `report.html`** (plus a `report.md`
  mirror) that a human opens to verify lucida works — screenshots embedded inline,
  a CLI command table with exit codes, the Python steps, run metadata, and an
  obvious overall **PASS/FAIL**. With no `--out`, the evidence lands in a
  gitignored, timestamped `<repo>/.tmp/tryout/<ts>/`.

`up` is the spine; `drive` builds on it and adds the CLI / Python / web surfaces,
each a thin, separable adapter over the same booted server; `report` builds on
`drive` and consolidates one full cross-surface run into a portable report.

## TL;DR for an agent

```bash
# One command, full verification. With prebuilt artifacts (fast, no rebuild):
LUCIDA_TRYOUT_SERVER_BIN=target/debug/lucida-server \
LUCIDA_TRYOUT_CLI=target/debug/lucida \
LUCIDA_TRYOUT_WEB_DIST=lucida-web/dist \
  python3 extras/tryout/tryout.py report --json --fixture /path/to/dataset.ome.zarr

# Verify ONE feature like a user (seed -> drive the UI by testid -> screenshots):
  python3 extras/tryout/tryout.py drive --scenario mentions --json \
  --out /tmp/scn --fixture /path/to/dataset.ome.zarr   # add --email to bundle shots (dry-run)
```

Read the printed JSON's `report_html` and open it: a PASS/FAIL banner, the three
surfaces, and the rendered-viewer screenshots inline. With no `--out` the report
+ raw artifacts land under a gitignored `<repo>/.tmp/tryout/<ts>/` (the JSON's
`out_dir`). A **scenario** instead verifies one feature end-to-end and saves named
shots under `DIR/<scenario>/` (`drive --scenario list` lists them). `--help`,
`up --help`, `drive --help`, and `report --help` describe every flag.

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
  - **Ceiling — the DPR render matrix (the retina arm *gates*):** drives the real
    SPA itself in a browser via **Playwright** (provisioned through `npm` into a
    harness cache, pointed at the same system Chrome — no browser download) at
    `deviceScaleFactor` **2 and 1**, waits for the same render-readiness signal
    the product uses, and then judges each arm on **whether a content frame
    actually presented into the main canvas**. If the DPR 2 arm runs and the
    canvas is blank, the web surface **fails**. If Playwright or a browser can't
    be provisioned, no arm runs, this is recorded as `{captured: false, reason}`
    with an explicitly *unenforced* gate, and the floor still stands. See
    [the retina render gate](#the-retina-render-gate-dpr-2) below.
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
      // The one verdict that can flip the web surface besides the floor.
      // `gated: false` means the DPR 2 arm never ran — NOT that it passed.
      "render_gate": {
        "ok": true, "gated": true, "required": false, "device_scale_factor": 2,
        "reason": "a content frame presented",
        "checks": { "ready": true, "device_scale_factor": true, "content_frame": true }
      },
      "real_spa": {
        "captured": true, "reason": "drove the SPA at deviceScaleFactor 2 and 1",
        "scale_factors": [2, 1],
        "arms": [
          {
            "device_scale_factor": 2, "gating": true, "ran": true, "ok": true,
            "reason": "a content frame presented",
            "checks": { "ready": true, "device_scale_factor": true, "content_frame": true },
            "render": { "ready": true, "frame_count": 148, "dataset_count": 1 },
            "metrics": { "device_pixel_ratio": 2, "css_width": 1160, "backing_width": 2320 },
            "content": {
              "width": 2320, "height": 1660,
              "centre": { "distinct_colors": 1459, "modal_fraction": 0.0198, "nonblack_fraction": 1.0 }
            },
            "spa_png": "DIR/web/spa-dpr2.png", "canvas_png": "DIR/web/canvas-dpr2.png",
            "console_log": "DIR/web/console-dpr2.log", "duration_s": 9.0
          },
          { "device_scale_factor": 1, "gating": false, "ran": true, "ok": true, "…": "…" }
        ],
        "gate": { "…": "same object as web.render_gate" }
      }
    }
  }
}
```

The web surface's `ok` is the **floor**, unchanged: a non-blank `viewer.png` from
the required capture. A failed `overview`, a non-gating DPR 1 arm, or a *skipped*
ceiling is captured but never flips it. `real_spa.captured: false` carries a
`reason` (e.g. Playwright/Chrome not provisionable) — the floor still stands.

The retina gate is reported separately, in `render_gate`, and it is the half that
fails the **run**: a failed gate makes `drive` report `ok: false` and exit
non-zero. Keeping the two apart is deliberate — the run verdict reads the
surface's declared `render_gate`, not its `ok`, so ordinary per-command and
per-step failures keep their existing non-fatal semantics.

Because `ok` is only half the answer, every place a human reads a verdict word —
the `--human` summaries, and the web section headings in `report.html` and
`report.md` — reflects **both**: a failing gate reads `FAIL` beside its reason
even though the floor held. (The JSON is unchanged; this is a display rule, and
its whole point is never to print a reassuring word beside a failure in a run
that exits non-zero.)

### The retina render gate (DPR 2)

Headless browsers default to `deviceScaleFactor` 1. A canvas's backing store is
CSS pixels × DPR, so retina makes the GPU fill **4× the pixels per frame** — and
there is a class of lucida render defects that only appears there. Those defects
are **silent**: no exception, no console message, the frame counter still
climbing, and `window.__lucidaCaptureReady` still reporting `ready: true`
(it is published from the JS side of a WebGPU submit, before the GPU has
presented anything). The viewer is simply, permanently black. See
[`wiki/gotchas/retina-dpr2-render-verification.md`](../../wiki/gotchas/retina-dpr2-render-verification.md).

So the ceiling runs **both** scale factors on every run and the retina one
decides. Each arm must satisfy four checks:

| Check | What it asserts | Why it is not enough on its own |
| --- | --- | --- |
| `attempt_completed` | the arm reached its measurements at all (it did not time out or lose its renderer) | an arm that threw has no measurements, so the rest fail closed behind it |
| `ready` | the product's own `window.__lucidaCaptureReady` says it rendered a frame with a dataset loaded | **the defect satisfies this** — it is a JS-side signal, not proof of presentation |
| `device_scale_factor` | the page observed the `devicePixelRatio` we asked for, *and* the captured canvas image is that many times its CSS box | a retina arm that silently degraded to DPR 1 is not evidence about retina |
| `content_frame` | the **centre 60% × 60%** of the main canvas is not one flat colour (≥ 2 distinct sampled colours, and the modal colour is ≤ 98% of samples) | this is the one that catches the defect |

Why the *centre of the canvas*, and not the page or the whole canvas:

- the **full page** is useless — the SPA chrome (sidebar, toolbar, text) renders
  perfectly while the viewer is black, so a full-page "non-blank" check passes on
  a completely dead viewer;
- the **whole canvas box** is nearly as bad — an element-clipped canvas shot
  composites the DOM overlaid on the canvas (the FPS badge, the orientation cube,
  the minimap), which are corner- and edge-anchored, so they supply a spurious
  "second colour". Measured against a black stand-in viewer: the canvas crop had
  **27 distinct colours** and the repo's own `scripts/assert_png_nonblank.py`
  passed it, while the centre had **1**.

The "main canvas" is the largest by CSS area (the SPA also mounts small minimap
and thumbnail canvases, so "the first `<canvas>` in the DOM" is not it).

**A gate that cannot answer does not answer "pass".** One state is tolerated as
*not enforced*: **no arm was attempted at all**, because this host has no node,
no Playwright, no browser — or has a browser that will not start (missing system
libraries, or a sandbox it cannot enter). That is an environment fact, it is
reported as `gated: false` (never as a quiet pass), and
`LUCIDA_TRYOUT_REQUIRE_DPR2=1` makes it fatal. Everything else **fails**: a
retina arm that was attempted and threw (a navigation timeout, a renderer or GPU
process death under the 4× backing store — a very plausible retina
manifestation), a driver that died without printing a result, or the whole matrix
timing out.

The discriminator is each arm's `ran` flag, and only that. The driver sets `ran`
*before* it does an arm's work, precisely so an arm that then throws is still
marked attempted; `capture_real_spa` synthesises a placeholder arm (`ran: false`,
carrying the driver's reason) for every requested scale factor the driver
returned no record for. So "some arm ran" means the browser was genuinely up.
The *length* of `arms` proves nothing — a host whose browser cannot launch still
gets a full-length list of placeholders, and that host must skip, not fail.

Artifacts, per arm: `DIR/web/spa-dpr{N}.png` (full page), `DIR/web/canvas-dpr{N}.png`
(the judged canvas region), `DIR/web/console-dpr{N}.log`. The whole matrix runs in
one node process and one browser (a context per arm), so the second scale factor
costs a page load, not another launch — roughly **+4s** on the ceiling in
practice.

The Node driver only *measures*; the pass/fail policy is pure Python in
`tryout/surfaces/web_surface.py` (`judge_render_arm`, `build_render_gate`) and is
tested without a browser by `make -C extras/tryout test`. Be precise about what
that buys: **CI runs the policy tests only.** No CI job launches a browser or
renders anything, so the driver's region maths, canvas geometry and DPR-fidelity
measurement are not exercised there, and a green CI run is *not* evidence that
lucida renders at retina. That evidence still comes from a human — or a runner
with a browser — invoking `tryout drive`.

Scenario UI shots (`drive --scenario`) default to `deviceScaleFactor` 2 for the
same reason; pass `device_scale_factor=1` to `drive_ui_program` for the DPR 1
rendering.

## `report`: one run, one portable verification report

```bash
python3 extras/tryout/tryout.py report [--json] [--out DIR] [--fixture PATH] \
  [--surface all]
```

The capstone. It runs the **full cross-surface session** (it *reuses* `drive
--surface all` — CLI + Python + web, same hermetic spine, same raw artifacts:
`server.log`, `cli/*.log`, `python/session.log`, `web/viewer.png` (+ the DPR
render matrix's `web/spa-dpr{2,1}.png` / `canvas-dpr{2,1}.png`),
`drive.json`) and then consolidates that one run into two artifacts a human opens
to verify lucida works **without re-running**:

- **`report.html`** — a *truly* self-contained single file: the web screenshots
  are **embedded inline as base64 data-URIs**, so you can email/attach/open it
  anywhere with the renders still showing — no sibling files needed. It has a
  clear **PASS/FAIL** banner, run metadata (lucida version + git commit,
  `base_url`, workspace/dataset ids), a per-surface section each (the CLI command
  **table** with exit codes, the Python **steps**, the web **screenshots inline**
  with the re-openable viewer URL), and a `server.log` excerpt. Each embedded shot
  is still captioned with its `web/*.png` filename so the on-disk artifact is
  named, not hidden.
- **`report.md`** — a Markdown mirror of the same facts (relative image links,
  since the raw PNGs sit alongside), for terminals / PR comments / diffs.

- **Default output is gitignored.** With **no `--out`**, the report and raw
  artifacts are written to a timestamped `<repo>/.tmp/tryout/<ts>/` (`.tmp/` is
  gitignored). The chosen path is reported as `out_dir`, so an agent can just run
  `report` and know where the evidence landed.
- **The report is written on a failed run too** (a bad fixture, a surface
  that errored) — it *shows* what failed (the failing rows/steps, a blank/missing
  screenshot placeholder, the error envelope). (An operator `Ctrl-C` mid-run still
  reaps the server cleanly but may skip the report write.) Exit is non-zero iff the run
  wasn't fully ok.
- **Hermetic + always-reaped**, because the run *is* `drive`: free port,
  throwaway DB, `LUCIDA_AUTH=disabled`, fixture opened read-only, prebuilt
  artifacts reused when offered, server reaped on every path.

### Result object (`report`)

One JSON object with at least: `ok`, `out_dir`, `report_html` (path), `report_md`
(path), a `surfaces` summary (`cli`/`python`/`web`, each with `ran`/`ok` and a
pass count or `viewer_png_nonblank` + the retina render gate's verdict),
`workspace_id`, `dataset_id`, plus
`base_url`, `versions`, and `drive_json` (a pointer to the full raw detail).

```jsonc
{
  "ok": true,
  "out_dir": ".../.tmp/tryout/20260101-120000",
  "report_html": ".../report.html", "report_md": ".../report.md",
  "workspace_id": "…", "dataset_id": "wds-…",
  "base_url": "http://127.0.0.1:PORT", "teardown": "clean",
  "versions": { "server": "lucida-server 0.2.0", "cli": "lucida 0.2.0", "commit": "abc1234" },
  "surfaces": {
    "cli":    { "ran": true, "ok": true, "passed": 16, "total": 16 },
    "python": { "ran": true, "ok": true, "passed": 12, "total": 12 },
    // `render_gate_enforced: false` means the DPR 2 arm never ran — not that it passed.
    "web":    { "ran": true, "ok": true, "viewer_png_nonblank": true, "real_spa_captured": true,
                "render_gate_enforced": true, "render_gate_ok": true, "scale_factors": [2, 1] }
  },
  "drive_json": ".../drive.json"
}
```

## `drive --scenario`: verify ONE feature like a user → screenshots → email

```bash
python3 extras/tryout/tryout.py drive --scenario <name> [--json] --out DIR \
  [--fixture PATH] [--email] [--email-send]
python3 extras/tryout/tryout.py drive --scenario list   # list available scenarios
```

Where a *surface* answers "does lucida's CLI/Python/web layer work at all?", a
**scenario** answers "does this specific feature behave correctly end-to-end?" —
it **seeds** some collaborative state, **drives the real SPA by `data-testid`**
like a person, **captures named screenshots**, and (optionally) **emails** them.
One repeatable command instead of a bespoke script each time.

- **Registry, like surfaces.** Each scenario is a small module registered under
  `tryout/scenarios/` (`Scenario(name, description, run)`); `--scenario <name>`
  dispatches, `--scenario list` prints the names + descriptions, an unknown name
  is a clean error (exit 1). Adding a scenario is *one registration* — the
  framework carries seed/page/capture; the scenario is just the steps.
- **Captures land in `DIR/<scenario>/<name>.png`** and each is checked non-blank
  via `scripts/assert_png_nonblank.py` (the same checker the web surface uses).
  `DIR/<scenario>/scenario.json` holds the scenario result and the top-level
  `drive.json` carries it under `scenario`.
- **`--email` bundles the shots + a summary and hands them to
  [courier](../../). DRY-RUN BY DEFAULT** — it builds and previews the message and
  lists the attachments but **sends nothing**; only `--email-send` actually sends.
  Courier is located via `LUCIDA_TRYOUT_COURIER` (a path to `courier.py`) or the
  installed skill on `PATH`; if courier isn't found, the run records
  `email.{attempted: true, sent: false, reason}` and the scenario is **not**
  failed.
- **Hermetic + always-reaped**, reusing the same spine: free port, throwaway DB,
  `LUCIDA_AUTH=disabled`, fixture opened read-only, prebuilt artifacts reused. The
  server is reaped on every path; the browser driver runs in its own process
  group with a hard timeout, so neither the server nor any browser child is
  orphaned. A scenario error is graceful (recorded, whatever shots exist are kept,
  non-zero exit).

### The `mentions` scenario

`mentions` verifies lucida's @-mention flow (the feature first verified by hand,
now one command). It pins the browser identity in `localStorage`
(`lucida.annotation.author = tryout-verifier`) **before load**, computes the
handle the SPA derives for "me", seeds a pin + a comment by `alice-9f2` mentioning
me + a comment mentioning `@Alice`/`@Bob` over WS, then drives the UI by testid:
the **mentions-of-me badge** → **panel** → click the mention row to open the
**thread** (rendered `@`-chips) → type `@` in the composer for the **collaborator
autocomplete** — capturing `mentions-badge`, `mentions-panel`, `thread-chips`,
`autocomplete`. (The mention feature needs a mentions-bearing build; the harness
drives whatever `LUCIDA_TRYOUT_WEB_DIST`/`_SERVER_BIN`/`_CLI` point at, so the
scenario is build-agnostic — CI/runtime supplies the build.)

### Result object (`drive --scenario`)

```jsonc
{
  "ok": true,
  "mode": "scenario",
  "workspace_id": "…", "dataset_id": "wds-…",
  "scenario": {
    "name": "mentions", "ok": true,
    "shots": [
      { "name": "mentions-badge", "path": ".../mentions/mentions-badge.png", "nonblank": true },
      { "name": "mentions-panel", "path": "…", "nonblank": true },
      { "name": "thread-chips",   "path": "…", "nonblank": true },
      { "name": "autocomplete",   "path": "…", "nonblank": true }
    ],
    "notes": ["seeded 3 document command(s)", "UI program: completed"]
  },
  "email": {
    "attempted": true, "dry_run": true, "sent": false,
    "attachments": [".../mentions-badge.png", "…"]
  },
  "teardown": "clean"
}
```

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
| `LUCIDA_TRYOUT_SCALE_FACTORS` | The ceiling's DPR render matrix, e.g. `2,1` (default) or `2`. An unparseable value falls back to the default, so a typo can never silently drop the retina arm. |
| `LUCIDA_TRYOUT_REQUIRE_DPR2` | `1` makes a *skipped* retina arm (no node, no Playwright, no browser) fail the run instead of being tolerated. Set it wherever a missing browser would be a misconfiguration rather than a fact of life. Nothing in this repository sets it today, because no CI job runs `tryout drive` — see below. |
| `LUCIDA_TRYOUT_COURIER` | Path to courier's `courier.py` for `drive --scenario --email`; else a `courier` on `PATH` is used, else email is recorded as skipped (never fatal). |

## Layout

```
extras/tryout/
  tryout.py            # thin entrypoint (path shim -> tryout.cli)
  tryout/
    cli.py             # argv, output, exit codes, signal handling (up + drive + report)
    bringup.py         # `up`: bring-up -> report -> teardown lifecycle
    drive.py           # `drive`: bring-up -> exercise surfaces -> capture -> teardown
    report.py          # `report`: reuse `drive --surface all` -> consolidate report.html + report.md
    server.py          # boot / health-gate / reap the throwaway server (the spine)
    web.py             # resolve (or build) the SPA bundle the server serves (web)
    surfaces/
      __init__.py      # the SurfaceResult contract + the Surface REGISTRY
      _subproc.py      # one subprocess spine: run_group, scan_json_line, shquote
      python_client.py # workspace create + dataset open via LucidaClient (bring-up)
      cli_surface.py   # drive the real `lucida` CLI tour, capture each command
      python_surface.py# broad LucidaClient read/mutate tour, capture transcript
      web_surface.py   # non-blank viewer screenshot (CLI) + the DPR render matrix (Playwright; DPR 2 gates)
    scenarios/
      __init__.py      # the ScenarioResult contract + the Scenario REGISTRY
      _runner.py       # the framework: boot -> seed -> drive UI -> capture -> (email) -> reap
      _ws.py           # WS seed transport: push document commands, await acks
      _browser.py      # generic Playwright driver: run a declarative testid-driven UI program
      _courier.py      # the --email step: bundle shots + summary -> courier (dry-run default)
      mentions.py      # the @-mention scenario (pure steps: seed + UI program + verdict)
    capture.py         # the one writer: record shape + on-disk artifacts (up.json/drive.json/report.*)
    netutil.py         # free-port allocation, /healthz polling
    errors.py          # staged TryoutError
  tests/
    test_render_matrix.py  # the retina render gate's judging policy (stdlib unittest, no browser)
```

The `surfaces/` package is where each way of driving the server lives, each a
thin adapter over the same booted server. Every drive surface returns a
`SurfaceResult` (a uniform `name`/`ran`/`ok`/`passed`/`total`/`error` spine plus
the surface's own payload) and registers itself in the `REGISTRY`, so `drive` and
`report` iterate over surfaces generically rather than branching per surface, and
all three share one subprocess helper (`_subproc.run_group` — own process group +
group-kill, so no spawned CLI/browser child is ever orphaned). `drive` reuses the
`server.py` spine and the `python_client.py` bring-up wholesale rather than
re-implementing the lifecycle; the web surface additionally points the server at
a SPA bundle (`web.py`) before boot so the real viewer can be rendered.
`report.py` reuses `drive` wholesale and only adds the consolidation step (the
portable `report.html` + `report.md`) on top of the raw artifacts `drive` already
writes — so the run logic lives in exactly one place. All record/artifact writes
go through `capture` (the one writer).

The `scenarios/` package mirrors that registry shape for *feature* verification.
Each scenario registers a `Scenario(name, description, run)` in its own `REGISTRY`
(so `--scenario <name>`/`list` stay generic), but a scenario module is **pure
steps**: it declares a `seed` (document commands), a declarative testid-driven UI
`program` of actions + named shots, the `localStorage` pins to install before
load, and an `ok` verdict. The framework (`_runner.py`) owns boot (the same
`server.py` spine + `python_client.py` bring-up, with the SPA bundle served), the
WS seed transport (`_ws.py`, riding the same `websockets` stack the client uses),
the Playwright launch/teardown (`_browser.py`, the same system-Chrome + WebGPU
launch config as `web_surface.py`, running one generic UI driver so the browser is
owned in one place and reaped via `_subproc.run_group`), the `shot` capture, and
the `--email` step (`_courier.py`, dry-run by default). Adding a scenario is a
small module, not edits across the harness.

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

# report: run every surface and emit the consolidated, portable report
LUCIDA_TRYOUT_SERVER_BIN=target/debug/lucida-server \
LUCIDA_TRYOUT_CLI=target/debug/lucida \
LUCIDA_TRYOUT_WEB_DIST=lucida-web/dist \
  python3 extras/tryout/tryout.py report --json \
  --out /tmp/tryout-report --fixture /path/to/dataset.ome.zarr
open /tmp/tryout-report/report.html   # macOS; or xdg-open on Linux

# scenario: verify the @-mention feature like a user, capture shots, preview email
LUCIDA_TRYOUT_SERVER_BIN=target/debug/lucida-server \
LUCIDA_TRYOUT_CLI=target/debug/lucida \
LUCIDA_TRYOUT_WEB_DIST=lucida-web/dist \
LUCIDA_TRYOUT_COURIER=/path/to/courier/courier.py \
  python3 extras/tryout/tryout.py drive --scenario mentions --email --json \
  --out /tmp/tryout-scn --fixture /path/to/dataset.ome.zarr
python3 scripts/assert_png_nonblank.py /tmp/tryout-scn/mentions/thread-chips.png
python3 extras/tryout/tryout.py drive --scenario list   # the available scenarios
```

For `up`: expect exit 0, a JSON object on stdout with a `127.0.0.1:PORT` base URL
(not 9876) and real `workspace_id` / `dataset_id`, a non-empty
`/tmp/tryout-check/server.log`, and `/tmp/tryout-check/up.json`.

For `drive`: expect exit 0, `surfaces.cli` with several captured commands (each
with an `exit_code`), `surfaces.python.ran` true, and `surfaces.web.ok` true with
a **non-blank** `/tmp/tryout-drive/web/viewer.png` and a recorded `viewer_url`
(plus `web/spa-dpr2.png`, `web/canvas-dpr2.png`, `web/console-dpr2.log` and their
DPR 1 counterparts, and `surfaces.web.render_gate.ok` true, when the real-SPA
ceiling is available);
non-empty `/tmp/tryout-drive/cli/*.log` and `/tmp/tryout-drive/python/session.log`,
`/tmp/tryout-drive/drive.json`, `teardown: "clean"`, and no orphaned
`lucida-server` (or headless browser).

For `report`: expect exit 0, a JSON object with `ok: true`, a `report_html` +
`report_md` path, `surfaces.{cli,python}` `ok`, and the same web pair as `drive`
— `surfaces.web.ok` (the floor) true and `surfaces.web.render_gate_ok` true when
`render_gate_enforced` is true. The web surface's `ok` alone is **not** the
acceptance: it stays true for a black retina frame, which is exactly the run the
gate fails. The top-level `ok` is the one that reflects both, and it is what the
exit code follows. The
`/tmp/tryout-report/report.html` is non-empty and **self-contained** — it opens
standalone with the screenshots showing inline (the bytes are embedded as base64
`data:` URIs) and an obvious PASS/FAIL banner. Run with **no `--out`** to confirm
the report lands under a gitignored `<repo>/.tmp/tryout/<ts>/` (reported as
`out_dir`); run with `--fixture /nonexistent.ome.zarr` to confirm the report is
**still written** (showing the failure) while the process exits non-zero.

For `drive --scenario mentions`: expect exit 0, `scenario.ok: true`, and all four
shots (`mentions-badge`, `mentions-panel`, `thread-chips`, `autocomplete`) present
under `/tmp/tryout-scn/mentions/` and **non-blank** (each
`assert_png_nonblank.py` exits 0). With `--email` (no `--email-send`),
`email.dry_run` is `true` and `email.sent` is `false` (nothing is sent).
`drive --scenario list` lists `mentions`; `drive --scenario nonesuch` exits 1
cleanly. `teardown: "clean"` and no orphaned `lucida-server`/browser/node remain.
