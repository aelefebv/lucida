---
created: 2026-04-18
modified: 2026-05-15
---

# Planning Domain

`lucida-web/src/pipeline/planning/` — decides which chunks the renderer wants this tick. Inputs are pulled from WASM (view query + member positions + visible region) and from the orchestrator (asset catalog, minimap pending coords, carry-forward state); output is a `RequestPlan` consumed by [[cpu-cache]] and the [[gpu-residency|GPU worker]]. PRD #545 split the previously-monolithic `planning.ts` into a small directory; PRD #563 reshaped the contracts (discriminated `ActiveSetEntry` and `EntitySnapshot` unions, explicit `PlanningState`, `datasetId` carried in the snapshot, `SceneEpochs` / `VisibleRegion` relocated to `pipeline/epochs.ts` / `pipeline/viewport.ts`); PRD #578 finished the polish — `index.ts` split per-concern into `types.ts` / `modes.ts` / `chunks.ts` / `emit.ts` / `plan.ts` (with `index.ts` as a barrel re-export), trailing `Vox` / `World` / `Px` suffixes on coordinate fields, `Axis.{T,C,Z,Y,X}` namespace constants for the TCZYX 5D layout, and a dev-mode `validatePlanningInputs` boundary check.

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

- **Module layout** (post-PRD #578 / Slice 1):
  - `types.ts` — every interface and type alias (entities, snapshot, state, requests, active-set variants)
  - `modes.ts` — promotion-mode decision logic (`chooseEntityMode`, `groupByWell`, `assignModes`, …)
  - `chunks.ts` — chunk enumeration + culling primitives (`chunkKey`, `iterateChunks`, …)
  - `emit.ts` — lane emission helpers + `computePriority`
  - `plan.ts` — top-level `plan()` composition
  - `config.ts` / `configStore.ts` / `snapshot.ts` / `debug.ts` / `synthetic.ts` / `validate.ts` — supporting modules
  - `index.ts` — barrel re-export for the public surface; no definitions of its own
- **Inputs from WASM** (read every tick via the orchestrator):
  - `scene.view_query(dsId)` → per-entity `projected_diagonal_px`, `projected_area_px2`, `centroid_world`, `ideal_target_lod`, `importance`
  - `scene.member_positions(dsId)` → per-entity 2D position for slice placement (translated to `layoutPositionVox` JS-side)
  - `scene.visible_region(dsId)` → `xyBoundsVox`, `zRangeVox`, `sortCenterVox`, `effectiveZoom`, `frustumPlanes`
- **Inputs from JS state**: the dataset's `AssetCatalog` (for catalog-aware degradation), the active layout, the per-channel visibility settings, the per-image `minimapPending` map, the live `PlanningConfig` (from `planning/configStore.ts`), and the per-dataset `PlanningState` carry-forward (introduced by PRD #563).
- **Plan signature**: `plan(snapshot, state, config?)` — three-way decomposition (PRD #563). `snapshot` is the world this tick; `state: PlanningState` is what crossed from last tick (v1: `{ previousActiveSet }`); `config: PlanningConfig` is the tunables. The planner returns `RequestPlan & { nextState: PlanningState }`; callers store the opaque pointer.
- **Outputs**: a `RequestPlan` per dataset — list of `ChunkRequest` with priorities (each carrying its own `datasetId`, no post-stamp), per-well mode metadata for cold-state assembly, plus the opaque `nextState` for the next tick.
- **Consumers**: [[cpu-cache]] (`submit(plan)`), [[gpu-residency|gpu.worker.ts]] (via the cold-state message — see [[worker-protocol]]).
- **Snapshot assembly**: `planning/snapshot.ts` exports `buildPlanningSnapshot(args)` — a pure WASM→snapshot translator the orchestrator calls each tick. Lets planning be tested with stub WASM scenes. Snapshot carries `datasetId` (PRD #563) and constructs the matching discriminated `EntitySnapshot` variant (`ImageSnapshot | WellSnapshot | FieldSnapshot`) per WASM `kind()`.
- **Debug panel data**: `planning/debug.ts` exports `buildPlanningDatasetDebug` and `modeReason` — pure derivations from the plan + entity list, consumed by the DebugPanel "Planning" tab. `modeReason` reads thresholds from `PlanningConfig` so it can't drift from `chooseEntityMode`.
- **Live tuning**: `planning/configStore.ts` is a singleton with `get`/`set`/`reset`/`subscribe`, persisted to `localStorage["lucida.planning.config"]` with a schemaVersion envelope. The orchestrator subscribes to clear its planning cache on config change; the render loop subscribes to fire an interactive-dirty frame.
- **Cross-subsystem types**: `SceneEpochs` lives in `pipeline/epochs.ts` (relocated from planning by PRD #563 — only the `request` field is planning-owned; the others are scene-state change counters consumed by render and worker pipelines too). `VisibleRegion` lives in `pipeline/viewport.ts` (also relocated — viewport concept, not planning concept).
- **Coordinate-frame discipline** (PRD #578 / Slice 2): contract fields encode their frame in the name. `Vox` = voxel-space (dataset-local, pre-LOD); `World` = world-space (post-LOD, post-spacing — what the renderer draws in); `Px` = screen pixels. Applied JS-side at the `snapshot.ts` boundary; Rust source naming (`pub centroid_world`, `xy_bounds`, `sort_center`) is untouched. `BaseEntitySnapshot.layoutPositionVox` (grid placement, voxel) and `BaseEntitySnapshot.centroidWorld` (intrinsic spatial center, world) are *different* coordinates serving different purposes; the suffixes make this distinction visible at the use site.
- **Axis-index constants**: `lucida-web/src/axes.ts` exports `Axis = { T, C, Z, Y, X } as const`. Use `shape[Axis.X]` rather than `shape[4]` at every TCZYX-indexed access site. The Rust side mostly destructures (`let [t, c, z, y, x] = arr`) and isn't mirrored.
- **Dev-mode boundary check**: `pipeline/planning/validate.ts` exports `validatePlanningInputs(snapshot, state)`, called from `plan()` gated by `import.meta.env.DEV`. Nine semantic-invariant checks throw a descriptive `Error` on first violation. Vite dead-code-eliminates the call in production builds; the validator's helpers are fully tree-shakeable. Tests import the per-check helpers directly for per-invariant coverage.

## Invariants

- **Wells are the planning unit for plates.** All field-level decisions cascade from the well's mode. A well in `well-as-proxy` mode does not enumerate field chunks regardless of any field's individual visibility.
- **Singles are treated as a singleton "well group" with one field.** `planning/index.ts::groupByWell` synthesizes an `__image__${entityId}` group key for `kind === "Image"` entities — same code path as plates, simpler shape.
- **Catalog degradation is one tier at a time.** If well-as-proxy isn't available, drop to fields-with-proxy-fallback; if that's not available, drop to fields-with-detail. Never skip a tier.
- **The plan is fresh every tick.** No caching across ticks; the [[scene-state-and-epochs|epoch fast-path]] in the orchestrator decides whether to re-run planning at all.
- **Per-variant invariants are compile-time enforced** (PRD #563). `WellAsProxyEntry` carries no `imageId` / LOD fields / proxy fields — the well IS the proxy. `InvisibleEntry` is its own kind, never confused with `mode: "fields-with-detail"` for visible fields. `FieldSnapshot` always has a `parentId: string`; `ImageSnapshot` and `WellSnapshot` don't have the field at all. Reads must narrow on `kind` first.
- **Carry-forward state is explicit.** The planner consumes `state: PlanningState` (today: `{ previousActiveSet }`) and returns `nextState: PlanningState`. No globals, no module state, no implicit caches — see [[principles/planning#4-planning-is-pure-carry-forward-state-is-explicit]].
- **`datasetId` is stamped at emit time, not post-hoc** (PRD #563). The snapshot carries `datasetId`; the planner stamps it on every `ChunkRequest` and `ProxyRequest` as it emits. The orchestrator no longer mutates the result.
- **Inputs are validated in dev mode, not in production** (PRD #578). `validatePlanningInputs` runs at `plan()` entry under `import.meta.env.DEV`. In dev, malformed snapshots throw a crisp `Error` at the boundary; in production, the call is dead-code-eliminated. The validator catches semantic invariants the type system can't express (referential integrity of `parentId`, uniqueness of `entityId` / non-empty `imageId`, valid bbox, asset-catalog/minimap key references, prev-active-set duplicates, prev-active-set kind agreement when entity present). Disappeared prev-active-set entities are explicitly NOT a violation — entities can come and go across ticks.

## Gotchas

- **`importance` is per-entity per frame and comes from WASM** — don't try to compute it client-side. The math involves projected area and centroid distance from the viewport center; the WASM impl is the canonical one.
- **`projected_diagonal_px` is the well's diagonal, not a field's.** Threshold comparisons use the well diagonal even when fielding the well's children. Field-level projected sizes don't enter the mode decision.
- **Mode transitions can produce a brief "no detail, no proxy" frame** if the server-side proxy hasn't arrived yet. The shader's [[gpu-residency#semantic-fallback-chain|fallback chain]] handles this — coarser LODs draw if available, otherwise blank. Don't try to block planning waiting for the proxy.
- **Hysteresis is asymmetric** — the band is +5/-5 around the threshold, but the *initial* state on dataset open is the centered mode for whatever diagonal the well first projects to. There's no "warm-up" mode.
- **Dev-mode-only assertions don't fire in production** (PRD #578). If a producer bug surfaces only via the validator's throw in development, fix the producer — production won't catch it. The validator is a developer-time guard, not a runtime safety net.
- **Visible field with absent parent is legitimate** (PRD #578 / Slice 3 finding). Production WASM `view_query` may surface a visible field whose parent well is invisible (and so absent from `entities`). The planner's `groupByWell` handles this gracefully via `wellEntity: null`. The validator's check 1 reflects this: it only enforces "if the parent IS in `entities`, it must be a `Well`," not "every field's parent must be present."
- **Wells use `imageId: ""` by convention** — the well IS the proxy; there's no per-image wire-side keying. The validator's uniqueness check on `imageId` (check 3) carves out empty strings so multi-well plate snapshots remain valid.
