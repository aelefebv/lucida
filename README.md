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
- Dedicated visual replay UI is served at [`/ui/replay`](http://127.0.0.1:3000/ui/replay).

## Usage Telemetry + UI

Lucida now records request/response usage telemetry for core viewer endpoints and serves:

- Timeline/analytics APIs under `/usage/*`
- Live SSE stream at `/usage/events/stream`
- Embedded dashboard UI at `/ui`
- Decoupled visual playback UI at `/ui/replay` (step-through actions + frame replay)

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

Start the daemon:

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
lucida dataset open --uri /path/to/data.zarr --json
# or
LUCIDA_BASE_URL=http://127.0.0.1:4000 lucida session create --json
# action-oriented view updates
lucida view dim --view-id <view_id> --axis z --index 3 --json
lucida view pan --view-id <view_id> --dx-px 20 --dy-px -10 --json
# information-oriented retrieval
lucida view bounds --view-id <view_id> --json
lucida view screenshot --view-id <view_id> --json
```

For a short end-to-end Zarr smoke test, see `docs/cli-zarr-testing.md`.

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
