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

## Canonical S0 demo

Run the end-to-end S0 demo script to exercise:
- session create/attach snapshot flow
- typed error and typed event emission
- lease request + shared scene mutation
- warning aggregation updates
- heartbeat, idle disconnect, and reconnect recovery

```bash
./scripts/s0_demo.sh
```

## Canonical S1 demo

Run the S1 acceptance-backed demo script to validate:
- attach + snapshot + live event flow
- preview-first paint + same-generation refinement
- interactive pan/zoom/z/t/channel loop
- reconnect recovery
- no mixed-generation 2D frame behavior

```bash
./scripts/s1_demo.sh
```

Expected success markers include:
- `S1_DEMO_PASS`
- `T-M1-01: passed` through `T-M1-05: passed`

See [docs/s1_demo_runbook.md](docs/s1_demo_runbook.md) for the full runbook.
