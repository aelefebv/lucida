---
created: 2026-05-07
modified: 2026-05-07
---

# Topic: Build and Tooling

Build-system, type-checker, and dev-loop footguns. Distinct from runtime gotchas — these only bite during `cargo build`, `npm run build`, `tsc`, or after touching Rust that flows into WASM.

This page is a curated index of footguns; the articles live in `gotchas/`.

## When you hit a build error

- [[gotchas/ts-typecheck-trap]] — `npx tsc --noEmit` is a no-op against the project; use `tsc --noEmit -p tsconfig.app.json`
- [[gotchas/preexisting-ts-build-errors]] — known unrelated `npm run build` failures (may be partially out of date — see `now.md` for recent TS cleanups)
- [[gotchas/rust-2024-binding-modes]] — edition 2024 binding inference differs from 2021; trust the compiler suggestion

## When you change Rust that runs in the browser

- [[gotchas/wasm-rebuild-after-rust-changes]] — `npm run build:wasm` is the second half of every Rust change that touches code reachable from `lucida-core`'s WASM exports. Easy to forget; symptoms are stale or surprising browser behavior.

## Related

- [[decisions/0007-wasm-scene-as-source-of-truth]] — why Rust-in-the-browser is load-bearing (and therefore why the WASM rebuild step matters)
- The repo-root `CHUNK_PIPELINE.md` for the canonical chunk-pipeline narrative if you're debugging a build that broke after touching the renderer
