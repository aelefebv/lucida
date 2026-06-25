---
type: Crate
title: "lucida-web"
description: "React 19 + Vite 7 + WebGPU frontend that consumes the lucida-core WASM build and renders multi-channel volumetric microscopy datasets."
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-web.md
created: 2026-04-18
modified: 2026-06-25
---

# lucida-web

React 19 + Vite 7 + WebGPU frontend that consumes the [lucida-core](lucida-core.md) WASM build and renders multi-channel volumetric microscopy datasets. The web client is a thin orchestration layer over the WASM Scene — JS owns the network, the GPU, and the DOM; WASM owns the truth about what's visible and where.

This article is a roadmap. The substantive content for each subsystem lives in its own article.

## Why a thin client over WASM

The web client doesn't reimplement the Scene model. It doesn't decide what's visible, what LOD to use, or where entities project to on screen — it asks WASM. This split exists because the same questions need answers on the server, the CLI, and the Python bindings, and we'd otherwise have to re-implement view-query math four times. See [WASM Scene as Source of Truth](../../decisions/0007-wasm-scene-as-source-of-truth.md).

Practically, the web client owns:

- **Networking** — WebSocket bridge, presence throttling, binary chunk routing
- **Fetch** — content source, generated availability catalog, decode pool, CPU cache
- **GPU** — tiered atlases, indirection, descriptor buffers, shaders, render loop
- **DOM** — React components, layer panel, debug overlay, layout switcher

WASM owns:

- **Scene state** — entities, layouts, derived geometry, camera, view, display
- **Commands** — single mutator (`Scene::apply`), epoch bookkeeping
- **View query** — what's visible, projected size, ideal LOD per entity
- **Picking** — ray cast for clicks

## Subsystem map

- [Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md) — end-to-end overview pointing into the deep dive
- [Planning Domain](../subsystems/planning-domain.md) — wanted-set computation, detail/coarse tier selection, lane-based priorities
- [CPU Cache](../subsystems/cpu-cache.md) — fetch scheduling, decode pool, tiered LRU, drain to GPU
- [Generated Coarse](../subsystems/generated-coarse.md) — server-generated coarse metadata/readiness consumed by planning and fetch
- [GPU Residency](../subsystems/gpu-residency.md) — tiered atlas pools, indirection buffers, descriptor buffer, semantic fallback chain
- [Worker Protocol](../subsystems/worker-protocol.md) — main-thread ↔ render-worker message contract
- [Scene State and Epochs](../subsystems/scene-state-and-epochs.md) — how WASM state is pulled into JS
- [Presence and Follow Mode](../subsystems/presence-and-follow-mode.md) — peer-to-peer presence, transitive follow chains
- [Layout System](../subsystems/layout-system.md) — registered layouts, switching, derived placements
- [Multi-Channel and Colormaps](../subsystems/multichannel-and-colormaps.md) — per-channel settings, LUT textures, composite
- [Saved Views](../subsystems/saved-views.md) annotations/mentions/comment-threads — `AnnotationOverlay{,3D}` + draft overlay, `MentionsOfMe`, `ThreadPopover`, `annotation*.ts`, and `savedView/{build,restore}AnnotationView.ts`

## Top-level files in `src/`

- `App.tsx` — the root component. Threads ~10 hooks together with deliberate ordering and callback refs to break circular deps. See [App.tsx Hook Order and Callback Refs](../../gotchas/app-tsx-hook-order.md).
- `main.tsx` — Vite entry; `createRoot` mount
- `bridge.ts` — WebSocket client; throttles presence/cursor/dataset-presence updates
- `manifestTypes.ts` — TS mirror of [lucida-content](lucida-content.md)'s `DatasetManifest` and [lucida-protocol](lucida-protocol.md)'s `FetchSource`
- `applyAndSend.ts` — `applyDocumentCommand` (sends to server) vs `applyViewportCommand` (local + presence emit)
- `renderLoop.ts` / `renderLoopTypes.ts` — pull-based RAF loop with typed dirty flags
- `slicePath.ts` / `volumePath.ts` / `minimapPath.ts` — entry points for the three render paths
- `tickCommon.ts` — shared tick helpers
- `session.ts` — session state container
- `colormaps.ts` — 15 colormap LUTs
- `savedView/` — web side of [Saved Views](../subsystems/saved-views.md): `encoder.ts` (deep, gzip+base64url with default-stripping), `applier.ts` (deep, async orchestrator with `applyInProgress` flag and `subscribeApplyResult` channel), `urlSync.ts` (deep, debounced `replaceState` + popstate + bootstrap from `#view=…` and `#b=<id>`), `captureBuilder.ts`, `bookmarksApi.ts`, `useBookmarks.ts`, `types.ts`. Components: `BookmarkSidebar.tsx`, `ShareToolbarButton.tsx`, `LoadingViewBanner.tsx`.
- `auth/` — [Authentication](../subsystems/auth.md) consumer: `whoami.ts`, `useAuthState.ts`, `AuthGate.tsx`, `AuthSession.tsx`, `ProfileMenu.tsx`, `UnauthLanding.tsx`.
- Workspace dashboard/routing: `WorkspaceRoot.tsx`, `WorkspaceDashboard.tsx`, `WorkspaceSharingDialog.tsx`, `workspaceApi.ts` — workspace list/open, deep-link routing, and sharing UI.
- `types.ts` — shared TS types

Subdirectories:

- `pipeline/` — planning, tickCoordinator, CpuCache, contentSource, decode pool, asset catalog, layout builders/registry
- `renderer/` — GPU worker, atlases, indirection, descriptor buffer, wanted-set, four WGSL shaders (`compositor.wgsl`, `slice.wgsl`, `volume.wgsl`, `cursors.wgsl` for peer-cursor rendering), residency
- `hooks/` — the React hooks driving App.tsx
- `components/` — React components: viewers, controls, file browser, plate selector, peer cursors, FPS counter, minimap, layout switcher, layer panel, colormap selector, dimension controls, contrast controls, and the annotation/mentions/thread overlays
- `config/` — `keyBindings.ts` (keyboard binding map)
- `debug/` — DebugPanel and debugStats — runtime telemetry overlay
- `zarr/intensitySampler.ts` — coarse-LOD intensity readout for the volume sampler

The WASM bundle is **not** a `src/` subdir: `npm run build:wasm` builds it into `lucida-core/pkg/`, consumed via the `"lucida-core": "file:../lucida-core/pkg"` package alias in `package.json`.

## Interactions

- **Inputs**: `lucida_core` WASM (Scene/View/Camera/Command), `bridge.ts` WebSocket connection to [lucida-server](lucida-server.md), browser events (mouse, keyboard, resize)
- **Outputs**: WebGPU draw calls via OffscreenCanvas in a worker; `ClientMessage` (commands + presence + cursor + follow + open-dataset) over WebSocket; debug telemetry to the DebugPanel

## Invariants

- **All GPU work is on the worker.** The main thread never touches WebGPU directly; the canvas is transferred via `OffscreenCanvas`. See [All GPU Work on a Dedicated Web Worker](../../decisions/0003-gpu-on-dedicated-worker.md).
- **`interactiveDirty` and `residencyDirty` are throttled differently.** `interactiveDirty` renders immediately; `residencyDirty` waits ~33ms. The reason and consequence are in [Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md).
- **The classification gate is call-site discipline, not a runtime predicate.** `applyDocumentCommand` (sends to server, awaits Ack/CommandBroadcast) vs `applyViewportCommand` (applies locally + emits presence) is the choice point; the Rust side enforces it at compile time via the disjoint `DocumentCommand` / `ViewportCommand` enums. Misclassifying a viewport command as a document command floods peers; misclassifying a document command as viewport silently drops shared state. See [Document vs Viewport Command Classification](../../gotchas/document-vs-viewport-classification.md).
- **`Scene::apply_command` is called for every incoming command broadcast** so all clients converge on the same document state. Local viewport commands take a separate path (`applyViewportCommand`).

## Gotchas

- **Build TypeScript with the project flag**: `tsc --noEmit -p tsconfig.app.json`. Plain `npx tsc --noEmit` is a no-op in this repo. See [TS Type-Check Trap](../../gotchas/ts-typecheck-trap.md).
- **`npm run build` has known TS errors** in `renderClient.ts` (SharedArrayBuffer), `renderLoop.ts` (unused import), `lz4.worker.ts` (postMessage overload). These are pre-existing — don't chase them when adding unrelated work. See [Pre-existing TS Build Errors (resolved)](../../gotchas/preexisting-ts-build-errors.md).
- **WASM rebuild required after Rust changes** — `npm run build:wasm` regenerates `src/wasm/`. Vite hot-reload picks it up but won't trigger the rebuild itself.
