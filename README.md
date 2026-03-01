# Lucida

Lucida is a streaming-first, WebGPU-rendered N-dimensional image viewer.

## Repository layout (S0 baseline)

- `docs/` - product/specification documents and S0 contract artifacts.
- `docs/adr/` - accepted architecture decision records.
- `engine/` - Rust engine skeleton (`lucida-engine`).
- `client-web/` - TypeScript client skeleton (`@lucida/client-web`).
- `.github/workflows/ci.yml` - CI baseline for linting, type checks, tests, and build validation.

## Local development

### Engine (Rust)

```bash
cd engine
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets --all-features
cargo build --all-targets
```

### Client web (TypeScript)

```bash
cd client-web
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
```
