# Lucida

Collaborative volumetric microscopy viewer. Multiple peers open the same OME-Zarr dataset, follow each other's viewport, and share annotations in real time. Server in Rust (Axum + Tokio), client in TypeScript + WebGPU + WASM.

[![CI](https://github.com/aelefebv/lucida/actions/workflows/ci.yml/badge.svg)](https://github.com/aelefebv/lucida/actions/workflows/ci.yml)
[![Release](https://github.com/aelefebv/lucida/actions/workflows/release.yml/badge.svg)](https://github.com/aelefebv/lucida/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Quick start

### Run it locally (just you)

```bash
docker run --rm -p 127.0.0.1:9876:9876 \
  -e LUCIDA_AUTH=disabled -e LUCIDA_INSECURE=1 \
  ghcr.io/aelefebv/lucida:latest
```

Visit <http://localhost:9876>. The `127.0.0.1:` prefix on `-p` keeps the host's port forward bound to loopback so only your machine can reach it; the container itself still binds `0.0.0.0` internally (the Dockerfile defaults it that way), and `LUCIDA_INSECURE=1` acknowledges that auth is off (see [ADR-0018](wiki/decisions/0018-auth-mode-auto-detect-by-bind-address.md)).

### Share with your LAN

```bash
docker run --rm -p 9876:9876 \
  -e LUCIDA_AUTH=disabled -e LUCIDA_INSECURE=1 \
  ghcr.io/aelefebv/lucida:latest
```

Drops the `127.0.0.1:` prefix so the host port-forward listens on every interface — anyone on the same LAN can reach <http://your-machine:9876>. Be aware of the multi-user posture: every browser resolves to the same `dev@local` identity, bookmarks land in one shared namespace, and admin endpoints (`/admin/clear-proxy-cache`) are unprotected. If you want per-user identity, use the auth-enabled scenario below.

### Run with sign-in (Google OAuth)

For any production-shape deployment — multi-user identity, proper admin gating, internet-reachable hostname — sign-in is required. The click-by-click Google Cloud Console setup (provision an OAuth client, configure the redirect URI, supply the credentials to the container) lives in [`extras/deploy/RUNBOOK.md`](extras/deploy/RUNBOOK.md) §2 alongside the Kubernetes manifests in [`extras/deploy/k8s/`](extras/deploy/k8s/) and the single-host docker-compose alternative in [`extras/deploy/docker-compose.yml`](extras/deploy/docker-compose.yml). The conceptual model (env-var contract, persistence layout, OAuth provider extensibility, per-cloud identity wiring) lives in [`wiki/systems/subsystems/deployment.md`](wiki/systems/subsystems/deployment.md).

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

### Useful options

Add to any of the `docker run` recipes above.

**Mount a local data directory** so `/api/browse` can list OME-Zarr files on your filesystem (otherwise browsing is restricted to `gs://` / `s3://` / `http(s)://` URLs):

```bash
-v /path/on/host:/var/lib/lucida/data \
  -e LUCIDA_DATA_DIR=/var/lib/lucida/data
```

**Persist bookmarks/sessions across restarts** with a named volume covering the whole `/var/lib/lucida` tree (`lucida.db` + proxy cache). Without this, `docker rm` wipes everything; matters most for the LAN-shared case where multiple people accumulate state:

```bash
-v lucida-data:/var/lib/lucida
```

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
