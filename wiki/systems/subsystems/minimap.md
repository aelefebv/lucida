---
created: 2026-05-19
modified: 2026-06-25
---

# Minimap

`lucida-web/src/minimapPath.ts` plus `renderer/minimapHandlers.ts` — the separate low-resolution spatial context path. The minimap is intentionally not the same thing as the coarse fallback tier.

It is fed by **two paths**: [[planning-domain]] emits `lane:"minimap"` requests into the [[cpu-cache]], AND `tickMinimapOverview` (in `minimapPath.ts`) independently drains the CPU cache and uploads to the worker via the `minimapUploadOverviewChunksForLayer` message. The overview texture is **per-member/FOV** (each minimap layer gets its own), not one whole-dataset texture.

## Model

The minimap uses the manifest's explicit `coarse_level_index` pointer. That pointer may refer to a source coarse level or to a server-generated coarse level merged in through generated availability. The minimap does not synthesize a fallback by choosing the last source level. If no explicit coarse pointer exists yet, the minimap skips rendering for that dataset until metadata supplies one.

This keeps two concerns separate:

- **coarse tier** — per-field/image fallback/context chunks used by the main renderer and selected by the same explicit coarse pointer.
- **minimap** — per-member/FOV navigation context (each FOV gets its own overview texture) with its own render key, upload budget, and cache lane.

The minimap binds its own colormap LUT (`resolveMinimapLayerColormap`) and per-channel contrast (`resolveMinimapLayerContrast`) so 2D matches 3D — it previously rendered gray/dark (PR #835/#837).

## Interactions

- [[planning-domain]] emits minimap requests at `MINIMAP_LANE_OFFSET` so first spatial context wins over detail/coarse fill.
- [[cpu-cache]] routes `lane: "minimap"` through the coarse/minimap bucket so it does not compete with detail cache residency.
- [[gpu-residency]] owns minimap GPU resources separately from slice/volume tier pools and removes them on dataset cleanup.

## Invariants

- The minimap should not evict or be evicted by detail chunks.
- The minimap should not silently select arbitrary lowest-resolution source data; it needs an explicit `coarse_level_index`.
- Generated coarse is valid minimap input once it is advertised as the explicit coarse level, but it must flow through the progressive chunk upload path rather than an eager full-volume browser allocation.

## Related

- [[decisions/0023-minimap-lane-with-highest-priority]]
- [[gotchas/minimap-render-key]]
- [[cpu-cache]]
- [[gpu-residency]]
