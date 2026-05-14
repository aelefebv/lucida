# Lucida

Collaborative volumetric microscopy viewer. Multiple peers open the same OME-Zarr dataset, follow each other's viewport, and share annotations in real time. Server in Rust (Axum + Tokio), client in TypeScript + WebGPU + WASM.

[![CI](https://github.com/aelefebv/lucida/actions/workflows/ci.yml/badge.svg)](https://github.com/aelefebv/lucida/actions/workflows/ci.yml)
[![Release](https://github.com/aelefebv/lucida/actions/workflows/release.yml/badge.svg)](https://github.com/aelefebv/lucida/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Quick start

### Try it with Docker

```bash
docker run --rm -p 9876:9876 \
  -e LUCIDA_AUTH=disabled -e LUCIDA_INSECURE=1 \
  ghcr.io/aelefebv/lucida:latest
```

Visit <http://localhost:9876>. Auth is disabled for the local-only path; `LUCIDA_INSECURE=1` acknowledges the loopback-only assumption (see [ADR-0018](wiki/decisions/0018-auth-mode-auto-detect-by-bind-address.md)). Open an OME-Zarr dataset by URL: `gs://`, `s3://`, `http(s)://`, or a local `file://` path mounted into the container.

### Deploy to production (Kubernetes)

Reference manifests live in [`extras/deploy/k8s/`](extras/deploy/k8s/) with `<PLACEHOLDER>` values. Follow [`extras/deploy/RUNBOOK.md`](extras/deploy/RUNBOOK.md) for the step-by-step: provision an OAuth client, create a Kubernetes Secret, edit the placeholders, `kubectl apply`. The conceptual model (env-var contract, persistence layout, OAuth provider extensibility, per-cloud identity wiring) lives in [`wiki/systems/subsystems/deployment.md`](wiki/systems/subsystems/deployment.md).

### Develop on it

One-time setup:

```bash
# rust + cargo, pnpm, wasm-pack, node — your package manager equivalent
(cd lucida-web && pnpm install)
```

Two-terminal dev loop:

```bash
# Terminal 1 — relay server (binds 127.0.0.1:9876, auth auto-disabled on loopback)
cargo run -p lucida-server

# Terminal 2 — SPA dev server (Vite proxies /auth /api /admin /ws to :9876)
cd lucida-web && pnpm run build:wasm   # rebuild after any Rust change
cd lucida-web && pnpm run dev
```

Visit <http://localhost:5173>.

## Working with the codebase

- **Rust changes in any `lucida-*` crate** → rerun `(cd lucida-web && pnpm run build:wasm)` so the SPA picks up the new WASM
- **TypeScript changes in `lucida-web/`** → Vite hot-reloads automatically
- **Python binding changes in `lucida-py/`** → `(cd lucida-py && maturin develop)`

Tests:

```bash
cargo test --workspace
(cd lucida-web && pnpm test)
```

Type-check the SPA: `(cd lucida-web && pnpm exec tsc --noEmit -p tsconfig.app.json)` — see [`wiki/gotchas/ts-typecheck-trap`](wiki/gotchas/ts-typecheck-trap.md) for why the project flag is load-bearing.

## Architecture

The wiki under [`wiki/`](wiki/) is the primary reference — start at [`wiki/index.md`](wiki/index.md) (or [`wiki/CLAUDE.md`](wiki/CLAUDE.md) for navigation conventions). The chunk pipeline — how a chunk gets from disk → CPU cache → GPU atlas → shader sample — is the heart of the rendering system and is documented end-to-end in [`CHUNK_PIPELINE.md`](CHUNK_PIPELINE.md).

For *why* something is shaped the way it is, look in [`wiki/decisions/`](wiki/decisions/) (numbered ADRs). For *what bites you when you don't expect it*, look in [`wiki/gotchas/`](wiki/gotchas/).

## License

MIT — see [`LICENSE`](LICENSE).
