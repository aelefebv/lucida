---
created: 2026-04-18
modified: 2026-04-18
---

# Planning Domain

`lucida-web/src/pipeline/planning.ts` — decides which chunks the renderer wants this tick. Inputs are pulled from WASM (view query + member positions + visible region); output is a `RequestPlan` consumed by [[cpu-cache]] and the [[gpu-residency|GPU worker]].

## Why a separate domain

Planning is the only place where the renderer's "what should be on screen" intent meets reality (server catalog, GPU residency, dataset shape). Pulling it out of the orchestrator and the renderer made three things possible:

1. **Pure-function tests** — `planning.test.ts` covers the threshold logic without standing up GPU or network.
2. **Catalog-aware degradation in one place** — when the server doesn't advertise a proxy, the planner degrades; downstream layers don't need to know.
3. **A single priority formula** that the CPU cache (fetch scheduling) and GPU worker (eviction distance) can both consume.

## Three promotion modes

For each well group, planning chooses one of three modes from the well's projected diagonal in screen pixels:

| Mode | Projected diagonal | What gets fetched |
|---|---|---|
| **well-as-proxy** | < 80 px | One `WellProxy3D` per visible channel. No detail. |
| **fields-with-proxy-fallback** | 80–150 px | Detail chunks + per-field proxy + per-well proxy |
| **fields-with-detail** | > 150 px | Detail chunks. Field proxy only if catalog advertises it. |

Hysteresis bands of ±5 px around each threshold prevent flapping. Thresholds and the band live in `planning.ts:23-36`.

## LOD range

```
targetLod         = entity.idealTargetLod                 # from WASM view_query
coarsestDetailLod     = min(targetLod + 2, maxLevel)
detailOwnedRange  = [targetLod, coarsestDetailLod]
```

The two-LOD buffer absorbs zoom transitions smoothly — by the time the user zooms in past the next threshold, the finer LOD's detail chunks are already CPU-resident.

## Priority formula

A single scalar; **lower wins**.

```
priority = laneOffset + (1 - importance) * 500 + distance * 10
```

Lane offsets:

| Lane | Offset | What |
|---|---|---|
| DETAIL | 0 | Visible chunks |
| PROXY | 500 | Well/field proxy fallbacks |
| PREFETCH | 1000 | Next-timepoint prefetch |
| OVERVIEW | 2000 | Minimap |

Centered, important detail wins (~0); a far prefetch chunk loses (~1500+). The constants are tuned, not arbitrary — changing them noticeably affects perceived snappiness on plates.

## Interactions

- **Inputs from WASM** (read every tick via the orchestrator):
  - `scene.view_query(dsId)` → per-entity `projected_diagonal_px`, `projected_area_px2`, `centroid_world`, `ideal_target_lod`, `importance`
  - `scene.member_positions(dsId)` → per-entity 2D position for slice placement
  - `scene.visible_region(dsId)` → `xyBounds`, `zRange`, `effectiveZoom`, `frustumPlanes`
- **Inputs from JS state**: the dataset's `AssetCatalog` (for catalog-aware degradation), the active layout, the per-channel visibility settings.
- **Outputs**: a `RequestPlan` per dataset — list of `ChunkRequest` with priorities, plus per-well mode metadata so the orchestrator can build the worker's cold state correctly.
- **Consumers**: [[cpu-cache]] (`submit(plan)`), [[gpu-residency|gpu.worker.ts]] (via the cold-state message — see [[worker-protocol]]).

## Invariants

- **Wells are the planning unit for plates.** All field-level decisions cascade from the well's mode. A well in `well-as-proxy` mode does not enumerate field chunks regardless of any field's individual visibility.
- **Singles are treated as a singleton "well group" with one field.** `planning.ts:437-443` — same code path as plates, simpler shape.
- **Catalog degradation is one tier at a time.** If well-as-proxy isn't available, drop to fields-with-proxy-fallback; if that's not available, drop to fields-with-detail. Never skip a tier.
- **The plan is fresh every tick.** No caching across ticks; the [[scene-state-and-epochs|epoch fast-path]] in the orchestrator decides whether to re-run planning at all.

## Gotchas

- **`importance` is per-entity per frame and comes from WASM** — don't try to compute it client-side. The math involves projected area and centroid distance from the viewport center; the WASM impl is the canonical one.
- **`projected_diagonal_px` is the well's diagonal, not a field's.** Threshold comparisons use the well diagonal even when fielding the well's children. Field-level projected sizes don't enter the mode decision.
- **Mode transitions can produce a brief "no detail, no proxy" frame** if the server-side proxy hasn't arrived yet. The shader's [[gpu-residency#semantic-fallback-chain|fallback chain]] handles this — coarser LODs draw if available, otherwise blank. Don't try to block planning waiting for the proxy.
- **Hysteresis is asymmetric** — the band is +5/-5 around the threshold, but the *initial* state on dataset open is the centered mode for whatever diagonal the well first projects to. There's no "warm-up" mode.
