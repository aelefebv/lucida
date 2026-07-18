---
type: Crate
title: "lucida-web"
description: "React 19 + Vite 8 + WebGPU frontend that consumes the lucida-core WASM build and renders multi-channel volumetric image datasets."
tags: [lucida, crate]
source_path: wiki/systems/crates/lucida-web.md
created: 2026-04-18
modified: 2026-07-16
---

# lucida-web

React 19 + Vite 8 + WebGPU frontend that consumes the [lucida-core](lucida-core.md) WASM build and renders multi-channel volumetric image datasets. The web client is a thin orchestration layer over the WASM Scene — JS owns the network, the GPU, and the DOM; WASM owns the truth about what's visible and where.

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
- [Saved Views](../subsystems/saved-views.md) — `#view=…` URL-as-app-state hashes + server-stored saved views; capture, encode, and apply orchestration under `savedView/`
- [Annotations, comments, and mentions](../subsystems/annotations.md) — `AnnotationOverlay{,3D}` + draft overlay, `MentionsOfMe`, `ThreadPopover`, `annotation*.ts` (the shared non-component family: `annotationDocument` model/read, `useAnnotationOverlay` document/thread state, `annotationInteraction` slop/capture/move-emit, `annotationGeometry`, `annotationContext`, plus the shared `AnnotationPinBadges` and the `cameraProjection` event↔world↔screen math), and `savedView/{build,restore}AnnotationView.ts`

## Top-level files in `src/`

- `App.tsx` — the root component. Threads ~10 hooks together with deliberate ordering and callback refs to break circular deps. See [App.tsx Hook Order and Callback Refs](../../gotchas/app-tsx-hook-order.md).
- `main.tsx` — Vite entry; `createRoot` mount
- `bridge.ts` — WebSocket client: the transport plus the sequenced-stream layer (last-applied-seq tracking, gap detection with grace-window buffering and snapshot resync, pending-command replay across mid-session snapshots); throttles presence/cursor/dataset-presence updates. The sequenced layer is a nameable seam (a potential documentSync module) kept in-file on purpose: its resets interleave with the connection lifecycle, so splitting waits until that layer next changes behavior — see the file header.
- `sessionController.ts` — non-React owner of the per-workspace connection stack: constructs DecodePool/ProxiedContentSource/CpuCache/Bridge/Session, wires all bridge handlers (single `ensureDatasetRegistered`/`removeDataset` path for snapshot + broadcast dataset membership, layout-registry mirroring, auto-fit-on-open policy), and owns connection-scoped state (self id, peers, follow target, open-in-flight). Explicit `new`/`destroy()` lifecycle; emits toward React through the narrow `SessionControllerEvents` surface. `hooks/useBridge.ts` is its thin adapter (one controller per mount).
- `manifestTypes.ts` — TS mirror of [lucida-content](lucida-content.md)'s `DatasetManifest` and [lucida-protocol](lucida-protocol.md)'s `FetchSource`
- `applyAndSend.ts` — `applyDocumentCommand` (applies locally, then sends to the server) vs `applyViewportCommand` (applies locally only — it does not emit presence; call sites pair viewport mutations with the separate throttled presence emit, see `useBridge.emitPresence`); both take the typed vocabulary from `commands.ts`
- `commands.ts` — TS mirror of `lucida-core/src/command.rs`'s `DocumentCommand`/`ViewportCommand` serde wire shapes (manifestTypes.ts-style), covering every command the web produces as a JSON literal
- `renderLoop.ts` / `renderLoopTypes.ts` — pull-based RAF loop with typed dirty flags
- `slicePath.ts` / `volumePath.ts` / `minimapPath.ts` — entry points for the three render paths. `slicePath.ts` also owns the slice member-pass budget (members below `MEMBER_AGGREGATE_MAX_DIAG_PX` on-screen batch into one instanced aggregate layer, hard-capped by `MAX_INDIVIDUAL_MEMBER_PASSES` per dataset/channel, so overview frames on wide collections stay a handful of passes instead of one per member) and the bounded backing clamp (`MAX_SLICE_BACKING_PIXELS`: oversized high-DPR targets render at reduced resolution with zoom rescaled, planning keeps the full viewport — same split as the volume path's `renderScale`)
- `tickCommon.ts` — shared tick helpers
- `invalidation.ts` — composed scene-invalidation intents (`invalidateDisplaySettings` / `invalidateResidency` / `invalidateAfterViewRestore` / `requestRender`): a call site states *what happened* and the module lands the right combination of settings-generation bump + render-loop dirty marks together, so a mutation can't tap one mechanism and forget the other (wiring pinned by `App.wiring.test.tsx`)
- `viewportCoordinator.ts` — the typed transaction boundary for local viewport writes. A successful batch applies follow-breaking, collaboration publication, URL/last-view synchronization, active-saved-view invalidation, and repaint policy exactly once; failed or unavailable scene mutations publish none of those effects. Canvas viewers and annotation, dimension, camera, collection, and restore paths consume this narrow interface instead of assembling partial side-effect sequences.
- `session.ts` — session state container
- `colormaps.ts` — 15 colormap LUTs
- `savedView/` — web side of [Saved Views](../subsystems/saved-views.md): `encoder.ts` (deep, gzip+base64url with default-stripping), `applier.ts` (deep, async orchestrator with `applyInProgress` flag and `subscribeApplyResult` channel), `urlSync.ts` (deep, debounced `replaceState` + popstate + bootstrap from `#view=…` and workspace-scoped `#b=<id>`), `captureBuilder.ts`, `useWorkspaceSavedViews.ts`, and `types.ts`. `App.tsx` injects `workspaceApi.getWorkspaceSavedView` as the `#b` resolver. The product surface is `WorkspaceSavedViewsSidebar.tsx`, with `ShareToolbarButton.tsx` and `LoadingViewBanner.tsx`.
- `auth/` — [Authentication](../subsystems/auth.md) consumer: `whoami.ts`, `useAuthState.ts`, `AuthGate.tsx`, `AuthSession.tsx`, `ProfileMenu.tsx`, `UnauthLanding.tsx`.
- Workspace dashboard/routing: `WorkspaceRoot.tsx`, `WorkspaceDashboard.tsx`, `WorkspaceSharingDialog.tsx`, `workspaceApi.ts` — workspace list/open, deep-link routing, and sharing UI.
- `types.ts` — shared TS types

Subdirectories:

- `pipeline/` — detail/coarse planning, tick coordinator, chunk-only CPU cache/content source, decode pool, and layout builders/registry
- `renderer/` — GPU worker, atlases, indirection, descriptor buffer, wanted-set, four WGSL shaders (`compositor.wgsl`, `slice.wgsl`, `volume.wgsl`, `cursors.wgsl` for peer-cursor rendering), residency
- `hooks/` — the React hooks driving App.tsx
- `components/` — React components: viewers, controls, file browser, collection selector, peer cursors, FPS counter, minimap, layout switcher, layer panel, colormap selector, dimension controls, contrast controls, and the annotation/mentions/thread overlays
- `config/` — `keyBindings.ts` (keyboard binding map)
- `debug/` — DebugPanel/DebugOverlays and debugStats — runtime telemetry overlay. The panel + overlay components are code-split: App.tsx loads them via `React.lazy` as a separate on-demand chunk (first Debug-button click / overlay toggle), so they stay out of the main production bundle; only the small gate/stat modules (`logging.ts`, `debugStats.ts`) are statically imported. Dev-build editable, prod read-only — see [Debug overlays & diagnostics UI](../subsystems/debug-overlays.md)
- `zarr/intensitySampler.ts` — coarse-LOD intensity readout for the volume sampler

The WASM bundle is **not** a `src/` subdir: `pnpm run build:wasm` builds it into `lucida-core/pkg/`, consumed through the live `"lucida-core": "link:../lucida-core/pkg"` package alias in `package.json`. Vite excludes the alias from dependency optimization so rebuilding does not require a package reinstall or cache bypass.

## Component styling convention

New components use a co-located CSS file and semantic class names for stable
structure, responsive behavior, interaction states, and visual presentation.
Colors, radii, shadows, focus treatment, and stacking come from the custom
properties in `src/index.css`; component CSS must not introduce a private color
palette. State is expressed with classes, attributes, and CSS pseudo-classes,
not mouse handlers that mutate element styles.

Inline React styles are reserved for values that only exist at runtime, such as
measured popover coordinates, canvas dimensions, or a computed transform. When
a runtime value needs several declarations, expose it as a narrowly named CSS
custom property and let the component stylesheet consume it. A reusable
interaction contract belongs in a component (for example
`InlineRenameInput`), while application mutation belongs in an adapter around
the presentation component (for example `LayoutSwitcherController` around
`LayoutSwitcher`).

## Interactions

- **Inputs**: `lucida_core` WASM (Scene/View/Camera/Command), `bridge.ts` WebSocket connection to [lucida-server](lucida-server.md), browser events (mouse, keyboard, resize)
- **Outputs**: WebGPU draw calls via OffscreenCanvas in a worker; `ClientMessage` (commands + presence + cursor + follow + open-dataset) over WebSocket; debug telemetry to the DebugPanel

## Invariants

- **All GPU work is on the worker.** The main thread never touches WebGPU directly; the canvas is transferred via `OffscreenCanvas`. See [All GPU Work on a Dedicated Web Worker](../../decisions/0003-gpu-on-dedicated-worker.md).
- **`interactiveDirty` and `residencyDirty` are throttled differently.** `interactiveDirty` renders immediately; `residencyDirty` waits ~33ms. The reason and consequence are in [Flow: Chunk Lifecycle](../../flows/chunk-lifecycle.md).
- **Rendered means GPU-complete.** Slice and volume submissions carry monotonic frame IDs. The worker publishes `framePresented` only after `GPUQueue.onSubmittedWorkDone()` resolves; capture readiness, FPS, thread/annotation placement, and peer-cursor projection subscribe to that acknowledgement rather than counting browser RAF callbacks. Idle overlays do not own perpetual animation loops.
- **The product theme is intentionally dark-only.** `index.css` declares `color-scheme: dark` so native controls and application surfaces cannot diverge under a light OS preference. Shared surface/text/accent/semantic tokens are the component contract; normal product text token pairs are automatically checked at WCAG AA contrast. Focus visibility and reduced-motion behavior are global contracts, not component-local options.
- **The classification gate is call-site discipline backed by types on BOTH sides.** `applyDocumentCommand` (applies locally, then sends — the server sequences and broadcasts; the Ack is a delivery receipt, not awaited) vs `applyViewportCommand` (applies locally only; peers learn viewport state via the separate throttled presence emits at call sites) is the choice point; the Rust side enforces it at compile time via the disjoint `DocumentCommand` / `ViewportCommand` enums, and the TS side mirrors that in `commands.ts` — the seam functions take the mirrored unions (tag-disjoint by a compile-time assertion), so a misclassified or typo'd command literal is a tsc error, not a silent serde-default. Misclassifying a viewport command as a document command floods peers; misclassifying a document command as viewport silently drops shared state. See [Document vs Viewport Command Classification](../../gotchas/document-vs-viewport-classification.md).
- **The TS command vocabulary is locked against the real wasm.** `commands.test.ts` round-trips one representative of every `commands.ts` variant through the built `lucida-core/pkg` `apply_command` (acceptance + state read-back, plus an unknown-tag must-throw probe), so a Rust-side tag/field rename fails the web suite. Division of labor: the wire goldens lock the client<->server envelopes (field presence/values via parsed-frame comparison; key order is serde-irrelevant) and deliberately stop at the WebSocket; this lock covers the local TS->wasm `apply_command` seam, including viewport commands that never cross the server wire.
- **`Scene::apply_command` is called for every incoming command broadcast** so all clients converge on the same document state. Local viewport commands take a separate path (`applyViewportCommand`).

## Gotchas

- **Build TypeScript with the project flag**: `tsc --noEmit -p tsconfig.app.json`. Plain `npx tsc --noEmit` is a no-op in this repo. See [TS Type-Check Trap](../../gotchas/ts-typecheck-trap.md).
- **The production build is a required gate.** Run `pnpm run build`; historical
  TypeScript failures are resolved and must not be treated as an accepted
  baseline. See [Pre-existing TS Build Errors (resolved)](../../gotchas/preexisting-ts-build-errors.md).
- **WASM rebuild required after Rust changes** — `pnpm run build:wasm`
  regenerates `lucida-core/pkg/`. Vite reads the linked package, but does not
  invoke wasm-pack itself.
