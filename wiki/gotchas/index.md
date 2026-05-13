---
created: 2026-04-18
modified: 2026-05-13
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
- [[non-canonical-axes]] — OME-Zarr axes outside `{t,c,z,y,x}` (e.g. CZI `m` mosaic) are silently pinned to index 0; only the first slice is visible. Pinned axes and canonical-indexed axes (`t`, `c`) with `chunk_size > 1` are handled via post-decode byte slicing
- [[blosc-support]] — Blosc decoder supports a deliberately narrow subset (Blosc1 + zstd inner + typesize ∈ {1,2,4}); everything else is rejected at import time
- [[wire-chunk-key-conventions]] — wire chunk keys split asymmetrically: `t/c` are voxel coords, `z/y/x` are chunk-grid coords. The divide-and-slice for `t/c` happens server-side
- [[oss-config-defaults]] — `LUCIDA_*` env var contract, common misconfigurations (bind + auth mode mismatch, TLS-terminating-proxy cookie issue, hosted domain edge cases)
- [[saved-view-credentials-in-urls]] — dataset URLs in `#view=…` saved views are exposed via clipboard, browser history, screenshots; presigned URLs and credentialed URLs leak to anyone with the link
- [[axum-query-multivalue]] — Axum's default `Query<T>` extractor silently drops repeated keys (`?dataset=A&dataset=B` → only `B` reaches the handler)
- [[strict-mode-destroyable-classes]] — class instances with a `destroyed` flag set in `destroy()` get permanently disabled in dev (Strict-Mode double-invokes mount effects); `start()` must reset the flag
- [[saved-view-client-only-state]] — JS-only preferences (e.g. `autoContrastMap`) that mutate WASM state need a dedicated SavedView field or recipients silently override with their defaults
- [[branching-and-releases]] — trunk-based shape; image tags (not branches) for environment promotion; manual-merge release-please; branch-protection prerequisite
