# Tryout harness

A stdlib-only Python harness that boots a real `lucida-server` from the working
tree, exercises it the way an agent would, and always reaps it. The server gets
a free loopback port, a throwaway database and auth disabled, and the fixture
is opened read-only. Nothing is mocked.

## Commands

- `up` brings the server up and prints how to reach it. With `--once` it tears
  it down again.
- `drive` exercises the `lucida` CLI, the `LucidaClient` Python client and the
  web viewer, and captures each step's output under `--out`.
- `drive --scenario NAME` checks one feature through the real UI by
  `data-testid` and saves named screenshots. `--scenario list` prints the
  scenarios.
- `report` runs every surface and writes a self-contained `report.html`, with
  the screenshots inline, plus a `report.md`.

`--help` on the entrypoint and on each command describes the flags.

## Run it

```bash
LUCIDA_TRYOUT_SERVER_BIN=target/debug/lucida-server \
LUCIDA_TRYOUT_CLI=target/debug/lucida \
LUCIDA_TRYOUT_WEB_DIST=lucida-web/dist \
  python3 extras/tryout/tryout.py report --json --fixture /path/to/dataset.ome.zarr
```

Open the `report_html` path from the printed JSON. With no `--out`, output
lands in the gitignored `.tmp/tryout/<timestamp>/`. With `--json`, stdout is
one JSON object and everything else goes to stderr. `make -C extras/tryout`
wraps the same commands.

Without the prebuilt paths the harness builds what it needs: `cargo build` for
the server, `cargo run` for the CLI, and `wasm-pack` plus `pnpm` for the web
bundle.

| Variable | Effect |
| --- | --- |
| `LUCIDA_TRYOUT_SERVER_BIN` | Prebuilt `lucida-server`. Skips the build. |
| `LUCIDA_TRYOUT_CLI` | Prebuilt `lucida` CLI. |
| `LUCIDA_TRYOUT_WEB_DIST` | Prebuilt web bundle. Must contain `index.html`. |
| `LUCIDA_TRYOUT_FIXTURE` | Default `--fixture`. |
| `LUCIDA_TRYOUT_UV`, `LUCIDA_TRYOUT_PY` | The `uv` binary, or the whole interpreter prefix, that runs the working-tree `lucida-py` client. |
| `LUCIDA_TRYOUT_PLAYWRIGHT_DIR` | Where Playwright is installed for the full-page capture. Default `~/.cache/lucida-tryout/playwright`. |
| `LUCIDA_BROWSER` | Browser for screenshots. Defaults to the system Chrome, Chromium or Edge. |
| `LUCIDA_TRYOUT_COURIER` | Path to `courier.py` for `drive --scenario --email`. |

## Behavior worth knowing

- A failing CLI command or Python step is captured, not fatal. The run exits
  non-zero only when bring-up fails or a requested surface cannot run at all.
- The web surface passes on a non-blank `viewer.png` from
  `lucida viewer screenshot`. The Playwright full-page capture is best effort
  and never fails the run.
- `--email` is a dry run. Only `--email-send` sends.
- `report` writes its report on a failed run too, showing what failed.

## What imports it

Two measurement harnesses use the package for its server lifecycle:
`docs/perf/recorder-cost/ab_run.py` and
`docs/research/level-chain-harness/lc_run.py`. Between them they import
`tryout.server.ServerProcess`,
`tryout.surfaces.python_client.create_workspace_and_open`,
`tryout.surfaces._subproc.run_group`, and two private helpers from
`tryout.surfaces.web_surface`: `_ensure_playwright` and `_system_browser_path`.
Keep those names working when you change the package.
