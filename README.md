## Lucida

Rust daemon + Python client/CLI for Phase 1 OME-Zarr workflows.

## Runtime Defaults

- Default backend is `rust`.
- Default Rust base URL is `http://127.0.0.1:3000`.
- Python fallback is explicit:
  - `LUCIDA_BACKEND=python` for local in-process behavior.
  - optional `LUCIDA_BASE_URL=http://...` for Python HTTP mode.

Examples:

```bash
# Rust default (HTTP)
uv run lucida dataset open --uri /path/to/data.zarr --json

# Explicit Python fallback (in-process local service)
LUCIDA_BACKEND=python uv run lucida dataset open --uri /path/to/data.zarr --json
```

## Build Rust Daemon

```bash
cargo build -p lucida-daemon
cargo run -p lucida-daemon
```

## Release Packaging

Build a host-targeted release artifact and SHA-256 checksum:

```bash
./scripts/release_lucida_daemon.sh
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

Run the full Milestone 5 stabilization gate locally:

```bash
./scripts/ci_milestone5.sh
```
