---
type: Subsystem
title: "Debug overlays & diagnostics UI"
description: "The in-app developer surface for inspecting the rendering pipeline live: an"
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/debug-overlays.md
created: 2026-06-25
modified: 2026-07-06
---

# Debug overlays & diagnostics UI

The in-app developer surface for inspecting the rendering pipeline live: an
on-canvas overlay layer, an always-on FPS readout, a tabbed side panel, and a
set of `window` globals that the headless capture harness and dev console hang
off. Lives in `lucida-web/src/debug/` plus `components/FpsCounter.tsx`.

**Honest framing:** the tooling *reads* by default, but in dev builds it is
also a **control surface** — the Config tab writes live planning knobs
(`configStore`, persisted to localStorage and read by the planner every tick)
and the Cache tab writes live CpuCache budgets (`cpuCache.updateConfig`). And
the tooling does own state of its own: the `debugStats` sink, the telemetry
ring buffers/detectors that feed it, and the persisted localStorage toggles.
The prod/dev split below is what keeps that out of production behavior.

## Production vs dev builds

- **Code-split, on demand.** `App.tsx` has no static import of `DebugPanel`
  or `DebugOverlays`; both load as a separate lazy chunk (`React.lazy` +
  `Suspense`). The panel chunk is fetched on the first Debug-button click;
  the overlay layer mounts only when an overlay toggle is persisted on or
  the panel is open. A session that never opens them never downloads the
  code. Only the tiny gate/stat modules (`debug/logging.ts`,
  `debug/debugStats.ts`) live in the main bundle — production code paths
  share them.
- **Inspect + reset-to-safe in prod; full control in dev.** The write paths
  are dev-build gated (`import.meta.env.DEV`): the Config tab's planning
  knobs (including the `coarseDetailEnabled` bridge flag) and the Cache
  tab's budget/fetch-limit inputs render read-only in production — live
  values visible, inputs disabled, with a one-line note. Everything is
  writable in dev builds. The Config tab's "Reset all to defaults" stays
  enabled in every build: knobs persisted by an earlier session still
  apply in prod, and resetting *toward* defaults is a safety valve (the
  in-UI recovery from stale persisted knobs), not a steering control.
  Exception by design: `depthBiasView` is *product* config; its control
  (`components/FocalDepthControl.tsx`, main 3-D UI) stays writable in every
  build and is deliberately not in the Config tab.
- **Log/overlay toggles stay writable in prod.** The Logging tab's category
  and overlay checkboxes only gate diagnostics output (localStorage `debug`
  / `debug.overlays`), not planner or cache behavior, so they remain usable
  for field debugging.
- **`window.__orch` (alias `__lucidaOrch`) is dev-only.** It bundles the
  tickCoordinator, cpuCache, and a `requestTestProxy(...)` helper that
  issues real fetches — installed in a `useEffect` behind
  `import.meta.env.DEV`, deleted on cleanup. Production builds never
  install it (dead-code eliminated).

## What it shows

- **`FpsCounter`** — a tiny top-right readout, its own `requestAnimationFrame`
  loop over a rolling 100 ms window. Independent of the debug panel: it renders
  whenever the viewer is mounted (not gated by `showDebug`).
- **`DebugOverlays`** — an absolutely-positioned layer over the canvas with
  `pointer-events: none`, so it never steals interaction. Each overlay is gated
  by its own toggle and polls scene state every 100 ms. The overlays:
  - *groupModes* — per-group badge with detail/coarse coverage (`Dn/m Cn/m`) and
    promotion mode, placed at the group's projected world centroid.
  - *chunkGrid* — the planned LOD chunk grid for every visible tile, colored by
    status (cached/in-flight/planned) or, via the *chunkTier* / *cachedTier* /
    *plannedRank* sub-toggles, by render tier, eviction tier, or fetch-queue
    rank. Capped at 600 rects/tick as a backstop.
  - *renderRadius* — the actual detail/coarse render-radius boundary, drawn as
    projected circles (3 planes in 3D).
- **`DebugPanel`** — a tabbed side panel: Render, Scene, Pick, Planning, Cache,
  **Health**, Orch, Catalog, Config, Logging. *Config* is the planning-config
  editor (sliders backed by `configStore`; see [Planning Domain](planning-domain.md)) —
  live editor in dev builds, read-only viewer in prod. *Logging*
  hosts the category toggles and the overlay toggles above. *Health* fetches
  **server-authored** `DatasetSourceHealth` over the WS (`bridge.requestDatasetHealth`),
  the same per-source status/stage model traced in [Flow: Dataset Diagnostics](../../flows/dataset-diagnostics.md) —
  client-side residency telemetry lives in Cache/Catalog instead.

## How it's toggled

The "Debug" button drives `showDebug` (`App.tsx`, `handleDebugToggle`): it both
mounts the `DebugPanel` side panel (loading the debug chunk on first use) and
flips `debugStats.enabled` so the cheap per-frame stat collection only runs
while the panel is open. Overlays are *separate* — each is persisted in
`localStorage` (`debug.overlays`) via the Logging tab and survives reload
independently of `showDebug`; App mounts the overlay layer only while at least
one overlay is on (or the panel is open, which the Config tab's radius-slider
drag previews rely on). While the panel is open, `handleDebugClick` turns a
canvas click into a ray-pick that feeds the Pick tab.

## Telemetry cost discipline

- **Log gates are cached, not read per call.** `debug/logging.ts` reads
  `localStorage.debug` once at module init; `isDebugEnabled` (on the
  `bridgeLog` / cache / render hot paths) is an in-memory `Set` lookup. The
  cache refreshes through `setDebugEnabled` (panel edits) and the cross-tab
  `storage` event; a same-tab out-of-band write needs
  `refreshDebugCategories()` or a reload. See
  [Logging Conventions](../../decisions/0012-logging-conventions.md).
- **Rolling-window telemetry runs only when observable.** The upload
  rolling window and cold-state rebuild window (with their sustained-anomaly
  detectors — budget-exhausted, resend storm, drain waste, non-view churn)
  aggregate per tick *only* while `orchTelemetryActive()` holds: panel open
  (`debugStats.enabled`) or the `orch` log category on
  (`pipeline/upload/telemetry/active.ts`; gated at the
  `Uploader.deliverToWorker` / `TickCoordinator.planAndFetch` call sites).
  Consequence: cumulative counters in the Orch tab count from when a
  consumer first turned on, not from session start. The cheap monotonic
  counters elsewhere (e.g. `fetch/telemetry.ts` `TelemetryCounters`) stay
  unconditional — they are increments, and their log output is rate-limited
  and category-gated.

## Debug globals (and the capture contract)

The render loop publishes `window.__lucidaCaptureReady`
(`LucidaCaptureReadyState`: `ready`/`reason`/`frameCount`/`mode`/canvas dims) —
`false` with a reason during init / dataset-add / no-datasets, `true`/`"rendered"`
after a real frame paints (`renderLoop.ts`, `publishCaptureReady`). This is the
product's own readiness contract: **headless capture depends on it** — the
tryout web surface (`extras/tryout/.../web_surface.py`) polls for a sized canvas
whose `__lucidaCaptureReady.ready` is true before screenshotting, and the CLI
capture path also reads `window.__lucidaAutoContrast` (published by
`useIntensityBatcher.ts`). Both are load-bearing and present in **every**
build — they are the deliberate exception to the dev-only gating of `__orch`
above. Treat them as product API, not debug tooling.

`__lucidaCaptureReady` is a *singleton* on `window`; the last render loop to
publish wins. Don't gate production logic on it — it's a readiness signal for
external drivers, asserted only as a capture precondition.

## Interactions, gotchas, invariants

- Overlay projection reuses the renderer's exact voxel→world→screen path
  (`WasmScene.project_to_screen`), and in volume mode mirrors the shader's
  unit-cube Y-flip — so an overlay rect lining up with displayed data is a real
  signal, not an approximation. A chunk's overlay color reflects [GPU Residency](gpu-residency.md)
  (worker-resident vs. CPU-ready vs. planned), which is *why* a green rect can
  briefly survive a cold-state rebuild during pan/zoom.
- Overlays read live, tunable planning config; numbers shift when you edit the
  Config tab (dev builds). The overlay/panel poll loops (100 ms) are
  deliberately decoupled from the render loop, so afterglow/sticky-max
  indicators stay visible at human rates even when frames are sparse.
- Planning-knob edits persist (`localStorage["lucida.planning.config"]`), so a
  dev-build tweak survives reloads until reset — the Config tab's "Reset all
  to defaults" clears the key.
