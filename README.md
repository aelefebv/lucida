## Lucida

Rust daemon backend with a Python typed client/CLI.

Repository layout reference: `docs/architecture/repo-layout.md`.

## Runtime Model

- Backend is Rust-daemon-only.
- Default base URL is `http://127.0.0.1:3000`.
- Override with `LUCIDA_BASE_URL` or `--base-url`.
- `LUCIDA_BACKEND` is removed.
- `LucidaClient(backend=...)` is removed.
- Embedded usage UI is served at [`/ui`](http://127.0.0.1:3000/ui).
- Interactive viewer UI is served at [`/ui/viewer`](http://127.0.0.1:3000/ui/viewer).
- Read-only live view UI is served at [`/ui/live`](http://127.0.0.1:3000/ui/live).
- Dedicated visual replay UI is served at [`/ui/replay`](http://127.0.0.1:3000/ui/replay).

## Usage Telemetry + UI

Lucida now records request/response usage telemetry for core viewer endpoints and serves:

- Timeline/analytics APIs under `/usage/*`
- Live SSE stream at `/usage/events/stream`
- View-targeted SSE stream at `/view/events/stream?view_id=...`
- Active session discovery at `/session/list`
- Active view discovery at `/view/list` (optional `session_id` filter)
- Thumbnail assets at `/usage/thumbs/*`
- Embedded dashboard UI at `/ui`
- Interactive viewer UI at `/ui/viewer`
- Read-only live mirror UI at `/ui/live`
- Decoupled visual playback UI at `/ui/replay` (step-through actions + frame replay)

Viewer controls:

- Drag in viewport: pan
- Mouse wheel: zoom
- `Shift` + wheel: slice step on orthogonal axis
- `[` and `]`: slice step shortcuts
- `1`, `2`, `3`: set plane to `xy`, `xz`, `yz`

Telemetry defaults:

- DB path: `output/usage/lucida_usage.sqlite`
- Retention age: `14` days
- Max events: `50000`
- Max DB size: `1073741824` bytes

Override with environment variables:

- `LUCIDA_USAGE_DB_PATH`
- `LUCIDA_USAGE_RETENTION_DAYS`
- `LUCIDA_USAGE_MAX_EVENTS`
- `LUCIDA_USAGE_MAX_DB_BYTES`
- `LUCIDA_USAGE_THUMBNAIL_SAMPLE_RATE` (`0.0`-`1.0`, default `1.0`)
- `LUCIDA_USAGE_THUMBNAIL_MAX_PER_MINUTE` (`0` disables thumbnails, default unlimited)

Agent correlation headers (optional, additive):

- `X-Lucida-Agent-Run-Id`
- `X-Lucida-Agent-Step-Id`
- `X-Lucida-Agent-Name`

Example:

```bash
curl -sS -X POST http://127.0.0.1:3000/session/create \
  -H 'content-type: application/json' \
  -H 'X-Lucida-Agent-Run-Id: run_demo_001' \
  -H 'X-Lucida-Agent-Step-Id: step_session_create' \
  -H 'X-Lucida-Agent-Name: demo-agent' \
  -d '{"schema_version":1}'
```

## Run

Start the daemon manually (optional when using local defaults):

```bash
cargo run -p lucida-daemon
```

Install the CLI once (from repo root):

```bash
uv tool install --editable .
uv tool update-shell
```

Use the CLI against the daemon:

```bash
LUCIDA_BASE_URL=http://127.0.0.1:4000 lucida session create --json
lucida dataset open --uri /path/to/data.zarr --json
lucida view create --mode 2d --json
lucida view dim --axis z --index 3 --json
lucida view pan --dx-px 20 --dy-px -10 --json
lucida view bounds --json
lucida view screenshot --json
```

`lucida session create` now bootstraps a local daemon automatically when the
resolved base URL points at localhost and `/healthz` is not available.
Stop a managed auto-started daemon with:

```bash
lucida stop
```

Aliases: `lucida close`, `lucida exit`.
`lucida stop` also attempts a localhost port-based shutdown when no managed record exists.
Override managed daemon state file with `LUCIDA_DAEMON_STATE_PATH` if needed.

Defaults are persisted locally after `session create`, `dataset open`, and `view create`.
Inspect or reset them with:

```bash
lucida context show
lucida context clear
```

For a short end-to-end Zarr smoke test, see `docs/cli-zarr-testing.md`.
For a full command reference, see `docs/cli-reference.md`.
For backend policy and cache/timing controls, see `docs/render-backend-controls.md`.

## Convert OME-TIFF to OME-Zarr

Generate OME-Zarr datasets from one or more OME-TIFF inputs:

```bash
uv sync --group dev
uv run python scripts/data/convert_ome_tiff_to_omezarr.py /path/to/input.ome.tif --output /path/to/input.zarr --overwrite --json
```

Batch conversion into a directory:

```bash
uv run python scripts/data/convert_ome_tiff_to_omezarr.py /path/a.ome.tif /path/b.ome.tif --out-dir /path/to/out --overwrite
```

## Build Rust Daemon

```bash
cargo build -p lucida-daemon
```

## Release Packaging

Build a host-targeted release artifact and SHA-256 checksum:

```bash
./scripts/release/lucida_daemon.sh
```

Outputs land under `output/releases/`.

Verify checksum (Linux):

```bash
cd output/releases
sha256sum -c lucida-daemon-<target-triple>.sha256
```

Verify checksum (macOS):

```bash
cd output/releases
shasum -a 256 -c lucida-daemon-<target-triple>.sha256
```

## Milestone 5 Gate

Run the full stabilization gate locally:

```bash
./scripts/ci/milestone5.sh
```

## Render Perf Gate

Run the render benchmark + perf threshold gate (daemon must already be running):

```bash
./scripts/ci/render_perf_gate.sh
```

Baseline commands and reference timings are documented in:

- `docs/perf/render-benchmark-baseline.md`

## Skill Development

Canonical cross-agent skill artifacts live under `skills/lucida-orchestrator/`.

Validate contract and structure:

```bash
uv run python scripts/skills/validate_skill.py --skill skills/lucida-orchestrator
```

Check for drift against CLI and daemon routes:

```bash
uv run python scripts/skills/check_drift.py --skill skills/lucida-orchestrator
```

Build upload-ready adapter bundles (OpenAI + Anthropic):

```bash
uv run python scripts/skills/build_adapters.py --skill skills/lucida-orchestrator --out output/skills
```

Run runtime smoke checks against a running daemon:

```bash
uv run python scripts/skills/smoke_skill.py --base-url http://127.0.0.1:3000
```
