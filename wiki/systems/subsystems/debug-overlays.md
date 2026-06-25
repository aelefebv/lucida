---
type: Subsystem
title: "Debug overlays & diagnostics UI"
description: "The in-app developer surface for inspecting the rendering pipeline live: an"
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/debug-overlays.md
created: 2026-06-25
modified: 2026-06-25
---

# Debug overlays & diagnostics UI

The in-app developer surface for inspecting the rendering pipeline live: an
on-canvas overlay layer, an always-on FPS readout, a tabbed side panel, and a
set of `window` globals that the headless capture harness and dev console hang
off. Lives in `lucida-web/src/debug/` plus `components/FpsCounter.tsx`. None of
it adds production-side state — every overlay and tab *reads* from the scene,
orchestrator (tick coordinator), and CPU cache that already exist.

## What it shows

- **`FpsCounter`** — a tiny top-right readout, its own `requestAnimationFrame`
  loop over a rolling 100 ms window. Independent of the debug panel: it renders
  whenever the viewer is mounted (not gated by `showDebug`).
- **`DebugOverlays`** — an absolutely-positioned layer over the canvas with
  `pointer-events: none`, so it never steals interaction. Each overlay is gated
  by its own toggle and polls scene state every 100 ms. The overlays:
  - *wellModes* — per-well badge with detail/coarse coverage (`Dn/m Cn/m`) and
    promotion mode, placed at the well's projected world centroid.
  - *chunkGrid* — the planned LOD chunk grid for every visible field, colored by
    status (cached/in-flight/planned) or, via the *chunkTier* / *cachedTier* /
    *plannedRank* sub-toggles, by render tier, eviction tier, or fetch-queue
    rank. Capped at 600 rects/tick as a backstop.
  - *renderRadius* — the actual detail/coarse render-radius boundary, drawn as
    projected circles (3 planes in 3D).
- **`DebugPanel`** — a tabbed side panel: Render, Scene, Pick, Planning, Cache,
  **Health**, Orch, Catalog, Config, Logging. *Config* is the live planning-config
  editor (sliders backed by `configStore`; see [Planning Domain](planning-domain.md)). *Logging*
  hosts the category toggles and the overlay toggles above. *Health* fetches
  **server-authored** `DatasetSourceHealth` over the WS (`bridge.requestDatasetHealth`),
  the same per-source status/stage model traced in [Flow: Dataset Diagnostics](../../flows/dataset-diagnostics.md) —
  client-side residency telemetry lives in Cache/Catalog instead.

## How it's toggled

The "Debug" button drives `showDebug` (`App.tsx`, `handleDebugToggle`): it both
mounts the `DebugPanel` side panel and flips `debugStats.enabled` so the cheap
per-frame stat collection only runs while the panel is open. Overlays are
*separate* — each is persisted in `localStorage` (`debug.overlays`) via the
Logging tab and survives reload independently of `showDebug`; turning every
overlay off makes `DebugOverlays` render `null`. While the panel is open,
`handleDebugClick` turns a canvas click into a ray-pick that feeds the Pick tab.

## Debug globals (and the capture contract)

The render loop publishes `window.__lucidaCaptureReady`
(`LucidaCaptureReadyState`: `ready`/`reason`/`frameCount`/`mode`/canvas dims) —
`false` with a reason during init / dataset-add / no-datasets, `true`/`"rendered"`
after a real frame paints (`renderLoop.ts`, `publishCaptureReady`). This is the
product's own readiness contract: **headless capture depends on it** — the
tryout web surface (`extras/tryout/.../web_surface.py`) polls for a sized canvas
whose `__lucidaCaptureReady.ready` is true before screenshotting, rather than
guessing with sleeps. Treat it as load-bearing, not debug-only.

`App.tsx` also exposes `window.__orch` (alias `__lucidaOrch`) bundling the
`tickCoordinator`, `cpuCache`, and a `requestTestProxy(...)` helper, so the dev
console can drive proxy fetches and poke residency by hand. Both globals are
installed in a `useEffect` and **deleted on cleanup**, so they vanish on unmount.

## Interactions, gotchas, invariants

- Overlay projection reuses the renderer's exact voxel→world→screen path
  (`WasmScene.project_to_screen`), and in volume mode mirrors the shader's
  unit-cube Y-flip — so an overlay rect lining up with displayed data is a real
  signal, not an approximation. A chunk's overlay color reflects [GPU Residency](gpu-residency.md)
  (worker-resident vs. CPU-ready vs. planned), which is *why* a green rect can
  briefly survive a cold-state rebuild during pan/zoom.
- Overlays read live, tunable planning config; numbers shift when you edit the
  Config tab. The overlay/panel poll loops (100 ms) are deliberately decoupled
  from the render loop, so afterglow/sticky-max indicators stay visible at human
  rates even when frames are sparse.
- `__lucidaCaptureReady` is a *singleton* on `window`; the last render loop to
  publish wins. Don't gate production logic on it — it's a readiness signal for
  external drivers, asserted only as a capture precondition.
