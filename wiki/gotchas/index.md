# Gotchas

Tribal knowledge, footguns, and "we tried X, it broke Y" lessons. The kind of thing a new contributor won't know until it bites them.

## Articles

- [TS Type-Check Trap](ts-typecheck-trap.md) — `npx tsc --noEmit` is a no-op; use `tsc --noEmit -p tsconfig.app.json`
- [Pre-existing TS Build Errors (resolved)](preexisting-ts-build-errors.md) — known unrelated `npm run build` failures in `renderClient.ts`, `renderLoop.ts`, `lz4.worker.ts`
- [Rust 2024 Edition Binding Modes](rust-2024-binding-modes.md) — edition 2024 binding inference differs from 2021; trust the compiler suggestion
- [App.tsx Hook Order and Callback Refs](app-tsx-hook-order.md) — App.tsx hook order is load-bearing; callback refs break circular deps
- [Document vs Viewport Command Classification](document-vs-viewport-classification.md) — misclassifying a command floods peers (viewport-as-document) or silently desyncs (document-as-viewport)
- [Scene/DocumentState JSON Backward Compatibility](scene-document-state-json-compat.md) — `Scene` flattens `DocumentState` for JSON compat; new fields need backward-compat tests
- [Upload Budgets Are Per-Frame and Per-Path](upload-budgets-per-frame.md) — 8 MB main view, 2 MB minimap; non-linear behavior at limits, profile before changing
- [Worker Eviction Reporting Is Async](worker-eviction-async-reporting.md) — worker posts `chunksEvicted` async; main-thread send-tracking must reconcile
- [Minimap Skip-When-Stationary via Render Key](minimap-render-key.md) — minimap skips render when key matches; new visual inputs must extend the key
- [WASM Rebuild After Rust Changes](wasm-rebuild-after-rust-changes.md) — `npm run build:wasm` is the second half of every Rust change
- [Explicit Translations Are in Physical Units; Lucida Composes in Voxels](explicit-translations-are-physical-units.md) — OME-Zarr stores explicit tile translations in physical units; `lucida-store` converts to voxels at import
- [Proxy Generator Priority Is Not Honored Yet](proxy-priority-not-honored.md) — `priority` parameter on `ProxyGenerator::request` exists for API stability but FIFO today
- [Non-canonical axes are pinned to index 0](non-canonical-axes.md) — OME-Zarr axes outside `{t,c,z,y,x}` (e.g. CZI `m` mosaic) are silently pinned to index 0; only the first slice is visible. Pinned axes and canonical-indexed axes (`t`, `c`) with `chunk_size > 1` are handled via post-decode byte slicing
- [Blosc support is a deliberately narrow subset](blosc-support.md) — Blosc decoder supports a deliberately narrow subset (Blosc1 + zstd inner + typesize ∈ {1,2,4}); everything else is rejected at import time
- [Wire chunk keys: t/c are voxel coords, z/y/x are chunk-grid coords](wire-chunk-key-conventions.md) — wire chunk keys split asymmetrically: `t/c` are voxel coords, `z/y/x` are chunk-grid coords. The divide-and-slice for `t/c` happens server-side
- [OSS Config Defaults and the LUCIDA_* Env Var Contract](oss-config-defaults.md) — `LUCIDA_*` env var contract, common misconfigurations (bind + auth mode mismatch, TLS-terminating-proxy cookie issue, hosted domain edge cases)
- [Saved-View URLs Expose Dataset URLs (and Anything in Them)](saved-view-credentials-in-urls.md) — dataset URLs in `#view=…` saved views are exposed via clipboard, browser history, screenshots; presigned URLs and credentialed URLs leak to anyone with the link
- [Axum's Default Query Extractor Drops Repeated Keys](axum-query-multivalue.md) — Axum's default `Query<T>` extractor silently drops repeated keys (`?dataset=A&dataset=B` → only `B` reaches the handler)
- [React Strict-Mode Kills One-Shot `destroy()` Classes](strict-mode-destroyable-classes.md) — class instances with a `destroyed` flag set in `destroy()` get permanently disabled in dev (Strict-Mode double-invokes mount effects); `start()` must reset the flag
- [SavedView Mirrors WASM Presence — Client-Only State Won't Round-Trip Without a Dedicated Field](saved-view-client-only-state.md) — JS-only preferences (e.g. `autoContrastMap`) that mutate WASM state need a dedicated SavedView field or recipients silently override with their defaults
- [Branching and Releases](branching-and-releases.md) — trunk-based shape; image tags (not branches) for environment promotion; manual-merge release-please; branch-protection prerequisite
- [Use `GoogleCloudStorageBuilder::from_env()`, not `new()`, for GCS credentials](gcs-credentials.md) — `object_store::gcp` discovery is incomplete vs. Google's full ADC contract; lucida forwards `GOOGLE_APPLICATION_CREDENTIALS` explicitly; off-cluster metadata-server hangs ~13s
- [Compact Manifest Encoding Is a Decoder One-Way Door](compact-manifest-decoder-one-way-door.md) — shared-once manifests/fetch descriptors hard-fail on decoders that predate them; server rollback strands compact-persisted workspace documents (recovery: re-upgrade or remove/re-open); old web/CLI fail loud in a skew window, old Python summaries degrade silently; inline documents re-persist compact on first write
- [Verify Rendering at devicePixelRatio 2, Not Just 1](retina-dpr2-render-verification.md) — a retina backing store is 4× the pixels/frame; per-tile-scaled frame cost hits a silent completion cliff (black viewer, no error) invisible at DPR 1, and headless browsers/CI default to DPR 1
