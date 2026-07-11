/**
 * Snapshot builder — translates live WASM scene state into a
 * {@link PlanningSnapshot}. Single boundary between WASM scene queries
 * and the pure planning core: snake_case normalised to camelCase here,
 * fallbacks explicit. Pure (no module state, no input mutation).
 * See `wiki/principles/planning.md` §4 and §5.
 */

import type { WasmScene } from "lucida-core";
import type { ImageSpec, DatasetManifest } from "../../manifestTypes.ts";
import type { DatasetSettings } from "../../tickCommon.ts";
import { getActiveChannels } from "../../tickCommon.ts";
import type {
  AssetCatalogSnapshot,
  EntitySnapshot,
  MinimapChunkCoord,
  PlanningSnapshot,
  SelectionState,
} from "./index.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { VisibleRegion } from "../viewport.ts";
import type { PlanningConfig } from "./config.ts";
import {
  makeEntitySnapshot,
  type SnapshotEntityDeps,
  type ViewQueryEntityJson,
} from "./snapshotDelta.ts";

// Re-export from canonical home in `./index.ts`.
export type { MinimapChunkCoord } from "./index.ts";
// Re-export the coarse-level resolver — its canonical home is the shared
// per-row translation module, but consumers historically import it here.
export { resolveCoarseLevel } from "./snapshotDelta.ts";

/** Wire shape of `view_query`'s top-level object. */
interface ViewQueryJson {
  visible_entities?: ViewQueryEntityJson[];
}

/** Wire shape of `visible_region`'s JSON output (snake_case). */
interface VisibleRegionJson {
  xy_bounds: [number, number, number, number];
  z_range: [number, number];
  effective_zoom: number;
  radius_basis_vox?: number;
  sort_center: [number, number, number] | null;
  frustum_planes: [number, number, number, number][] | null;
}

/**
 * Default {@link VisibleRegion} returned when WASM hands back `null`
 * for `visible_region(dsId)` (e.g. dataset not yet registered). The
 * 1024×1024 bounds match the historical orchestrator fallback.
 */
const DEFAULT_VISIBLE_REGION: VisibleRegion = {
  xyBoundsVox: [0, 0, 1024, 1024],
  zRangeVox: [0, 1],
  effectiveZoom: 1,
  sortCenterVox: null,
  frustumPlanes: null,
};

/**
 * Minimal `DatasetEntry` shape consumed by the snapshot builder.
 * Mirrors `renderLoopTypes.ts::DatasetEntry` but locally redeclared
 * to avoid a dependency on the render-loop types from the planning
 * directory.
 */
export interface SnapshotDatasetEntry {
  manifest: DatasetManifest;
}

/**
 * Inputs to {@link buildPlanningSnapshot}. Options-object signature so
 * callers can drop new tiles in without churning every test stub.
 */
export interface BuildPlanningSnapshotArgs {
  /** Live WASM scene — queried for view, positions, visible region, selection. */
  scene: WasmScene;
  /** Dataset id — passed to every per-dataset WASM query. */
  datasetId: string;
  /** Manifest entry for `datasetId`; supplies image specs + parent stitching. */
  dataset: SnapshotDatasetEntry;
  /** Per-dataset settings — drives multi-channel selection assembly. */
  dsSettings: DatasetSettings | undefined;
  /** Current asset catalog snapshot threaded through into the result. */
  assetCatalog: AssetCatalogSnapshot;
  /**
   * Per-image pending minimap fetches the orchestrator has
   * accumulated this tick. Forwarded verbatim into
   * {@link PlanningSnapshot.minimapPending}; the planner emits one
   * minimap-lane request per coord at {@link MINIMAP_LANE_OFFSET}
   * (highest priority).
   *
   * Pass `new Map()` if the caller has nothing to forward — the
   * planner then emits no minimap requests.
   */
  minimapPending: Map<string, MinimapChunkCoord[]>;
  /** Render mode of the current tick (`slice` vs `volume`). */
  mode: "slice" | "volume";
  /** True when the dataset is being viewed in multi-channel mode. */
  multiChannel: boolean;
  /** Epoch counters parsed by the orchestrator — passed through verbatim. */
  currentEpochs: SceneEpochs;
  /** The orchestrator's request epoch — copied into the snapshot's epochs. */
  requestEpoch: number;
  /** Per-tick planning tunables — threaded through into downstream callers. */
  config: PlanningConfig;
  /**
   * Optional precomputed camera-independent inputs. These derive solely
   * from the scene's fixed 2D layout placement and the immutable dataset
   * manifest — they change only when the content / layout / asset epoch
   * moves, never on a camera move. A caller that caches them per-dataset
   * across view-only replans passes them here so the snapshot builder
   * skips the `member_positions` serde and the two manifest-map rebuilds.
   *
   * All three are optional and independent. When a field is absent the
   * builder computes it internally, identically to a caller that never
   * caches — the internal path is the byte-for-byte default. When
   * provided, the value MUST equal what the internal path would produce
   * for the current scene state (same content / layout / asset epoch);
   * a stale value yields wrong tile positions or parent edges.
   */
  precomputed?: {
    /** Parsed `member_positions(datasetId)` — entityId → 2D layout position. */
    positions?: Record<string, [number, number]>;
    /** Manifest map: image_id → ImageSpec. */
    imageSpecById?: Map<string, ImageSpec>;
    /** Manifest map: entity id → parent id (or null for a root entity). */
    parentByEntityId?: Map<string, string | null>;
  };
  /**
   * Precomputed per-entity snapshots to use verbatim as `entities`, in place
   * of parsing `view_query` and translating each row here. Supplied by a
   * caller that reconstructs the entity set incrementally (folding
   * `view_query_delta`) so the O(N) full parse + per-row translation is
   * skipped on a camera move.
   *
   * When provided, the builder does NOT call `view_query`: `entities` is the
   * passed array (empty is valid — the dataset is registered but nothing is
   * visible). Every other output — `visibleRegion`, `selection`, the
   * assembled snapshot — is still derived FRESH from the live scene, so a
   * selection change (timepoint / channel / slice) is never served stale from
   * this override. The records MUST be assembled via the shared
   * {@link makeEntitySnapshot} so they are identical to the full path.
   */
  entitiesOverride?: EntitySnapshot[];
}

/**
 * Result from {@link buildPlanningSnapshot}. Consumers receive both the
 * assembled {@link PlanningSnapshot} and the raw helper artifacts the
 * orchestrator still needs (the parsed `entities` list — for telemetry
 * and roster construction — and the `visibleRegion` it stashes for the
 * coordinate-diagnostic panel). `null` when this dataset has no
 * visible entities (the orchestrator should `continue` past it).
 */
export interface BuildPlanningSnapshotResult {
  snapshot: PlanningSnapshot;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
}

/**
 * Translate live WASM scene state into a {@link PlanningSnapshot}.
 *
 * Pure with respect to its inputs: identical args produce identical
 * outputs, no module state is touched, no parameter is mutated. Returns
 * `null` if `view_query(datasetId)` produces a missing or empty
 * `visible_entities` payload — the caller should skip this dataset.
 *
 * Assembly order: `view_query` → `member_positions` → `visible_region`
 * → stitch in `imageSpec` + `parentId` → assemble `EntitySnapshot[]` →
 * compute selection. `minimapPending` is forwarded into
 * {@link PlanningSnapshot.minimapPending} so the planner can emit
 * minimap-lane requests at the highest priority.
 */
export function buildPlanningSnapshot(
  args: BuildPlanningSnapshotArgs,
): BuildPlanningSnapshotResult | null {
  const {
    scene,
    datasetId,
    dataset,
    dsSettings,
    assetCatalog,
    minimapPending,
    mode,
    multiChannel,
    currentEpochs,
  } = args;
  // `requestEpoch` and `config` are accepted in the arg shape for
  // forward compatibility but aren't read here: the caller has
  // already folded `requestEpoch` into `currentEpochs`, and the
  // config is consumed by `plan()` (not the snapshot).
  void args.requestEpoch;
  void args.config;

  // When the caller supplies `entitiesOverride`, the entity set is taken
  // verbatim (it was reconstructed incrementally from `view_query_delta`) and
  // steps 1–4 below — the full `view_query` parse, `member_positions`, the
  // manifest maps, and the per-row translation — are all skipped. Only
  // `visibleRegion` and `selection` (steps 5–6) run, so they stay fresh.
  const entitiesOverride = args.entitiesOverride;

  // 1. view_query — may be null / empty when the dataset isn't yet
  //    registered in the scene. Caller treats this as "skip this
  //    dataset" (matches the historical `continue`). Skipped entirely on
  //    the override path.
  let vq: ViewQueryJson | null = null;
  if (!entitiesOverride) {
    const vqJson = scene.view_query(datasetId);
    vq = JSON.parse(vqJson) as ViewQueryJson | null;
    if (!vq || !vq.visible_entities) return null;
  }

  // 2. member_positions — keyed by entityId, 2D layout placement. Reuse a
  //    caller-cached parse when one is supplied (it is camera-independent,
  //    keyed by the layout epoch); otherwise parse it here. Not needed on
  //    the override path (the caller already joined placement into the rows).
  const precomputed = args.precomputed;
  let positions: Record<string, [number, number]> = {};
  if (!entitiesOverride) {
    if (precomputed?.positions) {
      positions = precomputed.positions;
    } else {
      const posJson = scene.member_positions(datasetId);
      positions = JSON.parse(posJson);
    }
  }

  // 3. Build helper maps from the dataset manifest:
  //   - imageSpecById: per-image multiscale levels
  //   - parentByEntityId: stitches `Tile.parent === groupId` so promotion
  //     can group tiles by their parent group (ADR 0025).
  //   Both derive from the immutable manifest (camera-independent), so a
  //   caller may supply them prebuilt; otherwise build them here. Not needed
  //   on the override path (the rows were already joined with the manifest).
  // 4. Snake-case → camelCase translation for every visible entity, via the
  //    shared per-row builder so the full path and the delta fold produce
  //    byte-identical records. Joins the WASM payload with the manifest for
  //    `levels`, `detailLevel`, `coarseLevel`, and `parentId`, and with the
  //    layout for `layoutPositionVox`. A `Tile` with no parent edge throws
  //    inside {@link makeEntitySnapshot}, surfacing the producer-invariant
  //    violation at assembly rather than later in `groupMembers`.
  let entities: EntitySnapshot[];
  if (entitiesOverride) {
    entities = entitiesOverride;
  } else {
    let imageSpecById: Map<string, ImageSpec>;
    if (precomputed?.imageSpecById) {
      imageSpecById = precomputed.imageSpecById;
    } else {
      imageSpecById = new Map<string, ImageSpec>();
      for (const img of dataset.manifest.images) {
        imageSpecById.set(img.image_id, img);
      }
    }
    let parentByEntityId: Map<string, string | null>;
    if (precomputed?.parentByEntityId) {
      parentByEntityId = precomputed.parentByEntityId;
    } else {
      parentByEntityId = new Map<string, string | null>();
      for (const ent of dataset.manifest.entities) {
        parentByEntityId.set(ent.id, ent.parent ?? null);
      }
    }
    const deps: SnapshotEntityDeps = {
      imageSpecById,
      parentByEntityId,
      positions,
      dsSettings,
    };
    // `vq` is non-null here — the override branch is the only path that
    // leaves it null, and it's taken above.
    entities = vq!.visible_entities!.map((e) => makeEntitySnapshot(e, deps));
  }

  // 5. visible_region — null when WASM has nothing yet for this dataset.
  //    Snake_case → camelCase; fall back to the historical
  //    1024×1024 default so downstream xy/z culling has finite bounds.
  const vrJson = scene.visible_region(datasetId);
  const vr = vrJson && vrJson !== "null"
    ? (JSON.parse(vrJson) as VisibleRegionJson | null)
    : null;
  const visibleRegion: VisibleRegion = vr
    ? {
        xyBoundsVox: vr.xy_bounds,
        zRangeVox: vr.z_range,
        effectiveZoom: vr.effective_zoom,
        ...(vr.radius_basis_vox !== undefined ? { radiusBasisVox: vr.radius_basis_vox } : {}),
        sortCenterVox: vr.sort_center,
        frustumPlanes: vr.frustum_planes,
      }
    : DEFAULT_VISIBLE_REGION;

  // 6. Selection — single-channel mode plans only for the current C
  //    (the upload path sends one atlas config with one channel; other
  //    channels' data would contaminate the atlas). Multi-channel mode
  //    fans out to every visible channel via composite member keys.
  let visibleChannels: number[];
  if (multiChannel && dsSettings?.channel_settings?.length) {
    visibleChannels = getActiveChannels(dsSettings);
  } else {
    visibleChannels = [scene.c()];
  }
  const selection: SelectionState = {
    t: scene.t(),
    c: scene.c(),
    z: scene.z(),
    visibleChannels,
    renderMode: mode,
    interactionState: "idle",
  };

  // 7. Assemble the final snapshot. `currentEpochs` already carries
  //    the orchestrator's `requestEpoch` (folded in by the caller).
  //    `minimapPending` is forwarded verbatim — the planner consumes
  //    it via `emitMinimapLane` to build minimap-lane requests at
  //    {@link MINIMAP_LANE_OFFSET}. `datasetId` is plumbed onto the
  //    snapshot so the planner stamps it onto every emitted request.
  //    `previousActiveSet` does not live on the snapshot — it travels
  //    via {@link PlanningState} which the orchestrator passes
  //    separately to `plan()`.
  const snapshot: PlanningSnapshot = {
    datasetId,
    epochs: currentEpochs,
    entities,
    visibleRegion,
    selection,
    assetCatalog,
    minimapPending,
  };

  return { snapshot, entities, visibleRegion, selection };
}
