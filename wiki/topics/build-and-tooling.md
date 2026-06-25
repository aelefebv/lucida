---
type: Topic
title: "Topic: Build and Tooling"
description: "Build-system, type-checker, and dev-loop footguns."
tags: [lucida, topic]
source_path: wiki/topics/build-and-tooling.md
created: 2026-05-07
modified: 2026-05-07
---

# Topic: Build and Tooling

Build-system, type-checker, and dev-loop footguns. Distinct from runtime gotchas — these only bite during `cargo build`, `npm run build`, `tsc`, or after touching Rust that flows into WASM.

This page is a curated index of footguns; the articles live in `gotchas/`.

## When you hit a build error

- [TS Type-Check Trap](../gotchas/ts-typecheck-trap.md) — `npx tsc --noEmit` is a no-op against the project; use `tsc --noEmit -p tsconfig.app.json`
- [Pre-existing TS Build Errors (resolved)](../gotchas/preexisting-ts-build-errors.md) — known unrelated `npm run build` failures (may be partially out of date — see `now.md` for recent TS cleanups)
- [Rust 2024 Edition Binding Modes](../gotchas/rust-2024-binding-modes.md) — edition 2024 binding inference differs from 2021; trust the compiler suggestion

## When you change Rust that runs in the browser

- [WASM Rebuild After Rust Changes](../gotchas/wasm-rebuild-after-rust-changes.md) — `npm run build:wasm` is the second half of every Rust change that touches code reachable from `lucida-core`'s WASM exports. Easy to forget; symptoms are stale or surprising browser behavior.

## Related

- [WASM Scene as Source of Truth](../decisions/0007-wasm-scene-as-source-of-truth.md) — why Rust-in-the-browser is load-bearing (and therefore why the WASM rebuild step matters)
