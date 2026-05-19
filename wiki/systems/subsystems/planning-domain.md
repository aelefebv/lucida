---
created: 2026-04-18
modified: 2026-05-19
---

# Planning Domain

`lucida-web/src/pipeline/planning/` — decides which chunks the renderer wants this tick. Inputs are pulled from WASM (view query + member positions + visible region) and from the tick coordinator (generated availability, minimap pending coords, carry-forward state); output is a `RequestPlan` consumed by [[cpu-cache]] and the [[gpu-residency|GPU worker]]. The module is structured as a small directory of pure functions: `types.ts` (every interface and type alias), `modes.ts` (tier/LOD resolution), `chunks.ts` (chunk enumeration + culling), `emit.ts` (lane emitters + priority), `plan.ts` (top-level composition), with `index.ts` as a barrel re-export. Supporting modules: `config.ts` / `configStore.ts` (live-tunable parameters), `snapshot.ts` (WASM → snapshot translation), `debug.ts` (debug-panel derivations), `synthetic.ts` (test fixtures), `validate.ts` (dev-mode boundary check).

## Why a separate domain

Planning is the only place where the renderer's "what should be on screen" intent meets reality (generated/source coarse availability, GPU residency, dataset shape). Pulling it out of the tick coordinator and the renderer made three things possible:

1. **Pure-function tests** — `planning.test.ts` covers the threshold logic without standing up GPU or network.
2. **Tier choice in one place** — the planner resolves explicit `detail` and `coarse` chunk levels per field/image; downstream layers receive tier-labeled chunk requests instead of inferring fallback from proxy catalogs.
3. **A single priority formula** that the CPU cache (fetch scheduling) and GPU worker (eviction distance) can both consume.

## Chunk Tiers

The default residency model is chunk-only coarse/detail, for both plate datasets and single-image datasets.

| Tier | Level source | Default behavior |
|---|---|---|
| **detail** | Source pyramid only | Defaults to the finest selectable source level, usually level 0. Users must explicitly choose a lower detail LOD. |
| **coarse** | Explicit source coarse level, or server-generated derived level | Used as the fallback/context tier. Generated coarse levels are advertised through generated availability metadata and fetched through normal chunk requests. |

For plate datasets, each field can resolve its own detail/coarse levels while preserving its well-relative transform and placement. There is no requirement that all fields in a well share a tier or a level. For single-image datasets, the same code path applies with one image member.

Legacy proxy promotion modes (`well-as-proxy`, `fields-with-proxy-fallback`) remain only behind the explicit legacy bridge flag and should not be described as the current model.

## LOD range

```
detailLevel = user override clamped to selectable source levels
           or finest selectable source level
coarseLevel = explicit compatible source coarse level
           or generated coarse level advertised by the server
           or null
wantedLodLevels = [detailLevel] plus [coarseLevel] when different
```

Generated levels are excluded from the detail selector. If a stale saved view or settings payload asks for a generated level as detail, the override clamps to the nearest selectable source level. The coarse tier may point at a generated level because generated coarse is a server-managed derived pyramid level served through the normal chunk path.

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
| PREFETCH | 1500 | Next-timepoint prefetch |
| COARSE | 2400 | Coarse chunk tier fill |
| OVERVIEW | 2500 | Historical overview lane; minimap now has a separate path |

Minimap wins outright on dataset open (~0); centered, important detail follows (~500); a far prefetch chunk loses (~1500+); coarse fill loses to interactive detail but stays ahead of the historical overview lane. Minimap chunks emit at exactly `MINIMAP_LANE_OFFSET` — they bypass the importance and distance terms because they're per-dataset, not per-entity. The constants are tuned, not arbitrary — changing them noticeably affects perceived snappiness on plates.

## Interactions

- **Inputs from WASM** (read every tick via the tick coordinator):
  - `scene.view_query(dsId)` → per-entity `projected_diagonal_px`, `projected_area_px2`, `centroid_world`, `ideal_target_lod`, `importance`
  - `scene.member_positions(dsId)` → per-entity 2D position for slice placement (translated to `layoutPositionVox` JS-side)
  - `scene.visible_region(dsId)` → `xyBoundsVox`, `zRangeVox`, `sortCenterVox`, `effectiveZoom`, `frustumPlanes`
- **Inputs from JS state**: generated availability metadata, the active layout, the per-channel visibility settings, per-dataset detail-level overrides, the per-image `minimapPending` map, the live `PlanningConfig` (from `planning/configStore.ts`), and the per-dataset `PlanningState` carry-forward.
- **Plan signature**: `plan(snapshot, state, config?)` — three-way decomposition. `snapshot` is the world this tick; `state: PlanningState` is what crossed from last tick (v1: `{ previousActiveSet }`); `config: PlanningConfig` is the tunables. The planner returns `RequestPlan & { nextState: PlanningState }`; callers store the opaque pointer. See [[decisions/0027-planning-state-as-the-carry-forward-seam]].
- **Outputs**: a `RequestPlan` per dataset — list of tier-labeled `ChunkRequest` with priorities (each carrying its own `datasetId`, no post-stamp), field/image active-set metadata for cold-state assembly, plus the opaque `nextState` for the next tick.
- **Consumers**: [[cpu-cache]] (`submit(plan)`), [[gpu-residency|gpu.worker.ts]] (via the cold-state message — see [[worker-protocol]]).
- **Snapshot assembly**: `planning/snapshot.ts` exports `buildPlanningSnapshot(args)` — a pure WASM→snapshot translator the tick coordinator calls each tick. Lets planning be tested with stub WASM scenes. Snapshot carries `datasetId` and constructs the matching discriminated `EntitySnapshot` variant (`ImageSnapshot | WellSnapshot | FieldSnapshot`) per WASM `kind()`.
- **Debug panel data**: `planning/debug.ts` exports `buildPlanningDatasetDebug` and `modeReason` — pure derivations from the plan + entity list, consumed by the DebugPanel "Planning" tab. The debug surface reports selected detail/coarse levels and generated readiness instead of treating proxy promotion as the primary state.
- **Live tuning**: `planning/configStore.ts` is a singleton with `get`/`set`/`reset`/`subscribe`, persisted to `localStorage["lucida.planning.config"]` with a schemaVersion envelope. The tick coordinator subscribes to clear its planning cache on config change; the render loop subscribes to fire an interactive-dirty frame.
- **Cross-subsystem types**: `SceneEpochs` lives in `pipeline/epochs.ts` (only the `request` field is planning-owned; the others are scene-state change counters consumed by render and worker pipelines too). `VisibleRegion` lives in `pipeline/viewport.ts` (viewport concept, not planning concept). See [[decisions/0028-scene-epochs-rename-and-relocation]].
- **Coordinate-frame discipline**: contract fields encode their frame in the name. `Vox` = voxel-space (dataset-local, pre-LOD); `World` = world-space (post-LOD, post-spacing — what the renderer draws in); `Px` = screen pixels. Applied JS-side at the `snapshot.ts` boundary; Rust source naming (`pub centroid_world`, `xy_bounds`, `sort_center`) is untouched. `BaseEntitySnapshot.layoutPositionVox` (grid placement, voxel) and `BaseEntitySnapshot.centroidWorld` (intrinsic spatial center, world) are *different* coordinates serving different purposes; the suffixes make this distinction visible at the use site. See [[decisions/0030-coordinate-frame-naming-discipline]].
- **Axis-index constants**: `lucida-web/src/axes.ts` exports `Axis = { T, C, Z, Y, X } as const`. Use `shape[Axis.X]` rather than `shape[4]` at every TCZYX-indexed access site. The Rust side mostly destructures (`let [t, c, z, y, x] = arr`) and isn't mirrored.
- **Dev-mode boundary check**: `pipeline/planning/validate.ts` exports `validatePlanningInputs(snapshot, state)`, called from `plan()` gated by `import.meta.env.DEV`. Seven semantic-invariant checks throw a descriptive `Error` on first violation. Vite dead-code-eliminates the call in production builds; the validator's helpers are fully tree-shakeable. Tests import the per-check helpers directly for per-invariant coverage. See [[decisions/0031-validate-planning-inputs-dev-mode-boundary-check]].

## Invariants

- **Fields/images are the residency unit.** Wells still provide layout and grouping context, but chunk-tier residency is per field/image in the default path.
- **Singles use the same tier model.** A single-image dataset emits the same detail/coarse tier requests as a plate field, with no well grouping special case.
- **Generated levels are coarse-only.** Detail overrides and detail option lists are source-backed only; generated levels are selected only for the coarse tier.
- **The plan is fresh every tick.** No caching across ticks; the [[scene-state-and-epochs|epoch fast-path]] in the tick coordinator decides whether to re-run planning at all.
- **Per-variant invariants are compile-time enforced.** `InvisibleEntry` is its own kind, never confused with a visible field/image entry. `FieldSnapshot` always has a `parentId: string`; `ImageSnapshot` and `WellSnapshot` don't have the field at all. Reads must narrow on `kind` first. See [[decisions/0026-discriminated-active-set-and-entity-types]].
- **Carry-forward state is explicit.** The planner consumes `state: PlanningState` (today: `{ previousActiveSet }`) and returns `nextState: PlanningState`. No globals, no module state, no implicit caches — see [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]].
- **`datasetId` is stamped at emit time, not post-hoc.** The snapshot carries `datasetId`; the planner stamps it on every `ChunkRequest` and `ProxyRequest` as it emits. The tick coordinator no longer mutates the result.
- **Inputs are validated in dev mode, not in production.** `validatePlanningInputs` runs at `plan()` entry under `import.meta.env.DEV`. In dev, malformed snapshots throw a crisp `Error` at the boundary; in production, the call is dead-code-eliminated. The validator catches semantic invariants the type system can't express (referential integrity of `parentId`, uniqueness of `entityId` / non-empty `imageId`, valid bbox + level shape arity, prev-active-set duplicates, prev-active-set kind agreement when entity present). Disappeared prev-active-set entities are explicitly NOT a violation — entities can come and go across ticks. Minimap pending coordinates are also NOT validated against the snapshot's entity set because they are populated at a producer scope that can exceed the per-tick view-query result.

## Gotchas

- **`importance` is per-entity per frame and comes from WASM** — don't try to compute it client-side. The math involves projected area and centroid distance from the viewport center; the WASM impl is the canonical one.
- **Projected size is advisory, not a proxy-mode switch.** The default coarse/detail path keeps chunk tiering explicit. Use `projected_diagonal_px` and importance for priority and debug reasoning, not to force an entire well into a proxy mode.
- **Generated coarse readiness is asynchronous.** Planning can request a generated coarse chunk before bytes exist. The server returns a generated chunk status (`pending`, `ready`, `failed_*`, `unavailable`); the CPU cache treats `pending` as non-failure and will re-request after later readiness.
- **Legacy hysteresis only matters when the proxy bridge is enabled.** The default path should not introduce mode flapping because fields/images keep stable detail/coarse tier identities.
- **Dev-mode-only assertions don't fire in production.** If a producer bug surfaces only via the validator's throw in development, fix the producer — production won't catch it. The validator is a developer-time guard, not a runtime safety net.
- **Visible field with absent parent is legitimate.** Production WASM `view_query` may surface a visible field whose parent well is invisible (and so absent from `entities`). The planner's `groupByWell` handles this gracefully via `wellEntity: null`. The validator's check 1 reflects this: it only enforces "if the parent IS in `entities`, it must be a `Well`," not "every field's parent must be present."
