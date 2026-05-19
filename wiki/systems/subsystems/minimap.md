---
created: 2026-05-19
modified: 2026-05-19
---

# Minimap

`lucida-web/src/minimapPath.ts` plus `renderer/minimapHandlers.ts` — the separate low-resolution spatial context path. The minimap is intentionally not the same thing as the coarse fallback tier.

## Model

The minimap uses an explicit source coarse level when the manifest advertises one. It does not synthesize a fallback by choosing the last source level, and it does not depend on generated coarse readiness. If no explicit minimap-safe source coarse exists, the minimap skips rendering for that dataset rather than consuming the coarse fallback tier.

This keeps two concerns separate:

- **coarse tier** — per-field/image fallback/context chunks used by the main renderer.
- **minimap** — whole-dataset navigation context with its own render key, upload budget, and cache lane.

## Interactions

- [[planning-domain]] emits minimap requests at `MINIMAP_LANE_OFFSET` so first spatial context wins over detail/coarse fill.
- [[cpu-cache]] routes `lane: "minimap"` through the coarse/minimap bucket so it does not compete with detail cache residency.
- [[gpu-residency]] owns minimap GPU resources separately from slice/volume tier pools and removes them on dataset cleanup.

## Invariants

- The minimap should not evict or be evicted by detail chunks.
- The minimap should not silently select arbitrary lowest-resolution source data; it needs an explicit source coarse level.
- Main-render coarse fallback can use generated coarse. The minimap does not.

## Related

- [[decisions/0023-minimap-lane-with-highest-priority]]
- [[gotchas/minimap-render-key]]
- [[cpu-cache]]
- [[gpu-residency]]
