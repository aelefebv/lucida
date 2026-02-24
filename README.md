## Lucida

Rust daemon backend with a Python typed client/CLI.

Repository layout reference: `docs/architecture/repo-layout.md`.

## Runtime Model

- Backend is Rust-daemon-only.
- Default base URL is `http://127.0.0.1:3000`.
- Override with `LUCIDA_BASE_URL` or `--base-url`.
- `LUCIDA_BACKEND` is removed.
- `LucidaClient(backend=...)` is removed.

## Run

Start the daemon:

```bash
cargo run -p lucida-daemon
```

Use the Python CLI/client against the daemon:

```bash
uv run lucida dataset open --uri /path/to/data.zarr --json
# or
LUCIDA_BASE_URL=http://127.0.0.1:4000 uv run lucida session create --json
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
