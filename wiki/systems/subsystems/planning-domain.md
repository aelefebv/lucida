---
created: 2026-04-18
modified: 2026-05-15
---

# Planning Domain

`lucida-web/src/pipeline/planning/` — decides which chunks the renderer wants this tick. Inputs are pulled from WASM (view query + member positions + visible region) and from the orchestrator (asset catalog, minimap pending coords, carry-forward state); output is a `RequestPlan` consumed by [[cpu-cache]] and the [[gpu-residency|GPU worker]]. PRD #545 split the previously-monolithic `planning.ts` into a small directory: `index.ts` (types + pure planner), `config.ts` (tunables + defaults), `snapshot.ts` (WASM → snapshot translation), `debug.ts` (debug-panel snapshot), `synthetic.ts` (test fixtures). PRD #563 followed up with the contract refactor: discriminated `ActiveSetEntry` and `EntitySnapshot` unions, an explicit `PlanningState` container for carry-forward state, `datasetId` carried through the snapshot (no orchestrator post-stamp), and `SceneEpochs` / `VisibleRegion` relocated to `pipeline/epochs.ts` and `pipeline/viewport.ts` (they're scene/viewport concepts, not planning concepts).

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

Hysteresis bands of ±5 px around each threshold prevent flapping. Thresholds, the band, and every other tunable live in `planning/config.ts` as exported constants and as fields of `PlanningConfig`. The orchestrator reads the live `PlanningConfig` from `planning/configStore.ts` once per tick — so values can be tweaked at runtime via the [Config tab in DebugPanel](https://github.com/aelefebv/lucida/blob/main/lucida-web/src/debug/ConfigTab.tsx) without rebuilding (PRD #545 / Slice 6).

## LOD range

```
targetLod         = entity.idealTargetLod                 # from WASM view_query
coarsestDetailLod = targetLod
detailOwnedRange  = [targetLod, targetLod]
```

Slice 2 of PRD #545 dropped the legacy `+2` LOD buffer: planning now hands the caller exactly one level. The orchestrator no longer filters the request stream by `entry.targetLod` either, so a buffered range would have queued chunks the cache could never use. Cross-LOD smoothing during zoom transitions is the shader fallback chain's responsibility — see [[gpu-residency#semantic-fallback-chain]].

## Priority formula

A single scalar; **lower wins**.

```
priority = laneOffset + (1 - importance) * 500 + distance * 10
```

Lane offsets:

| Lane | Offset | What |
|---|---|---|
| MINIMAP | 0 | Whole-sample low-res context, fetched first on dataset open |
| DETAIL | 500 | Visible chunks |
| PROXY | 1000 | Well/field proxy fallbacks |
| PREFETCH | 1500 | Next-timepoint prefetch |
| OVERVIEW | 2500 | Per-entity coarsest pass for shader fallback chain |

Minimap wins outright on dataset open (~0); centered, important detail follows (~500); a far prefetch chunk loses (~1500+); the per-entity OVERVIEW backstop loses to everything (~2500+). The MINIMAP lane was promoted by PRD #545 / [[decisions/0023-minimap-lane-with-highest-priority]] to surface spatial context within ~1 second of dataset open. Minimap chunks emit at exactly `MINIMAP_LANE_OFFSET` — they bypass the importance and distance terms because they're per-dataset, not per-entity. The constants are tuned, not arbitrary — changing them noticeably affects perceived snappiness on plates.

## Interactions

- **Inputs from WASM** (read every tick via the orchestrator):
  - `scene.view_query(dsId)` → per-entity `projected_diagonal_px`, `projected_area_px2`, `centroid_world`, `ideal_target_lod`, `importance`
  - `scene.member_positions(dsId)` → per-entity 2D position for slice placement
  - `scene.visible_region(dsId)` → `xyBounds`, `zRange`, `effectiveZoom`, `frustumPlanes`
- **Inputs from JS state**: the dataset's `AssetCatalog` (for catalog-aware degradation), the active layout, the per-channel visibility settings, the per-image `minimapPending` map, the live `PlanningConfig` (from `planning/configStore.ts`), and the per-dataset `PlanningState` carry-forward (introduced by PRD #563).
- **Plan signature**: `plan(snapshot, state, config?)` — three-way decomposition (PRD #563). `snapshot` is the world this tick; `state: PlanningState` is what crossed from last tick (v1: `{ previousActiveSet }`); `config: PlanningConfig` is the tunables. The planner returns `RequestPlan & { nextState: PlanningState }`; callers store the opaque pointer.
- **Outputs**: a `RequestPlan` per dataset — list of `ChunkRequest` with priorities (each carrying its own `datasetId`, no post-stamp), per-well mode metadata for cold-state assembly, plus the opaque `nextState` for the next tick.
- **Consumers**: [[cpu-cache]] (`submit(plan)`), [[gpu-residency|gpu.worker.ts]] (via the cold-state message — see [[worker-protocol]]).
- **Snapshot assembly**: `planning/snapshot.ts` exports `buildPlanningSnapshot(args)` — a pure WASM→snapshot translator the orchestrator calls each tick. Lets planning be tested with stub WASM scenes. Snapshot carries `datasetId` (PRD #563) and constructs the matching discriminated `EntitySnapshot` variant (`ImageSnapshot | WellSnapshot | FieldSnapshot`) per WASM `kind()`.
- **Debug panel data**: `planning/debug.ts` exports `buildPlanningDatasetDebug` and `modeReason` — pure derivations from the plan + entity list, consumed by the DebugPanel "Planning" tab. `modeReason` reads thresholds from `PlanningConfig` so it can't drift from `chooseEntityMode`.
- **Live tuning**: `planning/configStore.ts` is a singleton with `get`/`set`/`reset`/`subscribe`, persisted to `localStorage["lucida.planning.config"]` with a schemaVersion envelope. The orchestrator subscribes to clear its planning cache on config change; the render loop subscribes to fire an interactive-dirty frame.
- **Cross-subsystem types**: `SceneEpochs` lives in `pipeline/epochs.ts` (relocated from planning by PRD #563 — only the `request` field is planning-owned; the others are scene-state change counters consumed by render and worker pipelines too). `VisibleRegion` lives in `pipeline/viewport.ts` (also relocated — viewport concept, not planning concept).

## Invariants

- **Wells are the planning unit for plates.** All field-level decisions cascade from the well's mode. A well in `well-as-proxy` mode does not enumerate field chunks regardless of any field's individual visibility.
- **Singles are treated as a singleton "well group" with one field.** `planning/index.ts::groupByWell` synthesizes an `__image__${entityId}` group key for `kind === "Image"` entities — same code path as plates, simpler shape.
- **Catalog degradation is one tier at a time.** If well-as-proxy isn't available, drop to fields-with-proxy-fallback; if that's not available, drop to fields-with-detail. Never skip a tier.
- **The plan is fresh every tick.** No caching across ticks; the [[scene-state-and-epochs|epoch fast-path]] in the orchestrator decides whether to re-run planning at all.
- **Per-variant invariants are compile-time enforced** (PRD #563). `WellAsProxyEntry` carries no `imageId` / LOD fields / proxy fields — the well IS the proxy. `InvisibleEntry` is its own kind, never confused with `mode: "fields-with-detail"` for visible fields. `FieldSnapshot` always has a `parentId: string`; `ImageSnapshot` and `WellSnapshot` don't have the field at all. Reads must narrow on `kind` first.
- **Carry-forward state is explicit.** The planner consumes `state: PlanningState` (today: `{ previousActiveSet }`) and returns `nextState: PlanningState`. No globals, no module state, no implicit caches — see [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]].
- **`datasetId` is stamped at emit time, not post-hoc** (PRD #563). The snapshot carries `datasetId`; the planner stamps it on every `ChunkRequest` and `ProxyRequest` as it emits. The orchestrator no longer mutates the result.

## Gotchas

- **`importance` is per-entity per frame and comes from WASM** — don't try to compute it client-side. The math involves projected area and centroid distance from the viewport center; the WASM impl is the canonical one.
- **`projected_diagonal_px` is the well's diagonal, not a field's.** Threshold comparisons use the well diagonal even when fielding the well's children. Field-level projected sizes don't enter the mode decision.
- **Mode transitions can produce a brief "no detail, no proxy" frame** if the server-side proxy hasn't arrived yet. The shader's [[gpu-residency#semantic-fallback-chain|fallback chain]] handles this — coarser LODs draw if available, otherwise blank. Don't try to block planning waiting for the proxy.
- **Hysteresis is asymmetric** — the band is +5/-5 around the threshold, but the *initial* state on dataset open is the centered mode for whatever diagonal the well first projects to. There's no "warm-up" mode.
