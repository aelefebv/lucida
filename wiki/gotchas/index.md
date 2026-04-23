---
created: 2026-04-18
modified: 2026-04-23
---

# Gotchas

Tribal knowledge, footguns, and "we tried X, it broke Y" lessons. The kind of thing a new contributor won't know until it bites them.

## Articles

- [[ts-typecheck-trap]] — `npx tsc --noEmit` is a no-op; use `tsc --noEmit -p tsconfig.app.json`
- [[preexisting-ts-build-errors]] — known unrelated `npm run build` failures in `renderClient.ts`, `renderLoop.ts`, `lz4.worker.ts`
- [[rust-2024-binding-modes]] — edition 2024 binding inference differs from 2021; trust the compiler suggestion
- [[app-tsx-hook-order]] — App.tsx hook order is load-bearing; callback refs break circular deps
- [[document-vs-viewport-classification]] — misclassifying a command floods peers (viewport-as-document) or silently desyncs (document-as-viewport)
- [[scene-document-state-json-compat]] — `Scene` flattens `DocumentState` for JSON compat; new fields need backward-compat tests
- [[upload-budgets-per-frame]] — 16 MB main view, 2 MB minimap; non-linear behavior at limits, profile before changing
- [[worker-eviction-async-reporting]] — worker posts `chunksEvicted` async; main-thread send-tracking must reconcile
- [[minimap-render-key]] — minimap skips render when key matches; new visual inputs must extend the key
- [[wasm-rebuild-after-rust-changes]] — `npm run build:wasm` is the second half of every Rust change
- [[stage-translations-are-microns]] — OME-Zarr stores stage positions in microns; `lucida-store` converts to voxels at import
- [[proxy-priority-not-honored]] — `priority` parameter on `ProxyGenerator::request` exists for API stability but FIFO today
- [[non-canonical-axes]] — OME-Zarr axes outside `{t,c,z,y,x}` (e.g. CZI `m` mosaic) are silently pinned to index 0; only the first slice is visible
