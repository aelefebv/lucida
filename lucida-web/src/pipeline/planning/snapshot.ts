/**
 * Translates live WASM scene state into one view's half of a
 * {@link PlanningSnapshot}. The one boundary between WASM scene queries and
 * the pure planning core: snake_case becomes camelCase here and fallbacks are
 * explicit. Pure: no module state, no input mutation.
 */

import type { WasmScene } from "lucida-core";
import type { ImageSpec, DatasetManifest } from "../../manifestTypes.ts";
import { layerCut, shownChannels, type ResolvedLayer } from "../../resolvedLayers.ts";
import { cutAxis, type SliceCut, type SlicePlane, type SpatialAxis } from "../../renderer/slicePlane.ts";
import type { EntitySnapshot, SelectionState, ViewSnapshot } from "./index.ts";
import type { VisibleRegion } from "../viewport.ts";
import {
  makeEntitySnapshot,
  type SnapshotEntityDeps,
  type ViewQueryEntityJson,
} from "./snapshotDelta.ts";

export type { MinimapChunkCoord } from "./index.ts";
// Kept for consumers that import the resolver from this module.
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
  side_planes?: [number, number, number, number][];
  cut_axis?: SpatialAxis;
}

/**
 * Used when `visible_region(dsId)` returns `null`, as before the dataset
 * is registered. Finite bounds keep xy/z culling defined.
 */
const DEFAULT_VISIBLE_REGION: VisibleRegion = {
  xyBoundsVox: [0, 0, 1024, 1024],
  zRangeVox: [0, 1],
  effectiveZoom: 1,
  sortCenterVox: null,
  frustumPlanes: null,
};

/**
 * The part of `renderLoopTypes.ts::DatasetEntry` the builder reads,
 * redeclared so planning does not depend on render-loop types.
 */
export interface SnapshotDatasetEntry {
  manifest: DatasetManifest;
}

/** Inputs to {@link buildViewSnapshot}. */
export interface BuildViewSnapshotArgs {
  scene: WasmScene;
  /** The view whose camera and axis positions the snapshot reads. */
  view: number;
  datasetId: string;
  /** Manifest entry for `datasetId`; supplies image specs and parent edges. */
  dataset: SnapshotDatasetEntry;
  /** The layer as the view resolves it: the channels to plan, and the clamped t and z. */
  layer: ResolvedLayer | undefined;
  mode: "slice" | "volume";
  /**
   * Camera-independent inputs a caller may cache per dataset across
   * view-only replans, to skip the `plane_positions` parse and the
   * manifest-map rebuilds. Each is optional; an absent one is computed
   * here. A provided value must equal what this builder would compute for
   * the current content and layout epochs, or tile positions and parent
   * edges go wrong.
   */
  precomputed?: {
    /** Parsed `plane_positions(view, datasetId)`: entityId → where the view places it. */
    positions?: Record<string, [number, number]>;
    /** Manifest map: image_id → ImageSpec. */
    imageSpecById?: Map<string, ImageSpec>;
    /** Manifest map: entity id → parent id (or null for a root entity). */
    parentByEntityId?: Map<string, string | null>;
  };
  /**
   * Entity snapshots to use verbatim instead of parsing `view_query`, from
   * a caller that folds `view_query_delta` incrementally. Empty is valid.
   * `visibleRegion` and `selection` are still read fresh, so a selection
   * change is never served stale. Records must come from
   * {@link makeEntitySnapshot} so they match the full path.
   */
  entitiesOverride?: EntitySnapshot[];
}

/**
 * Where `view`'s slice cut meets `layer`: along the view's slice plane at the
 * layer's clamped axis position, or the view's own for a layer it lacks.
 */
export function sliceCut(
  scene: Pick<WasmScene, "slice_plane" | "cut_index">,
  view: number,
  layer: ResolvedLayer | undefined,
): SliceCut {
  const plane = scene.slice_plane(view) as SlicePlane;
  return layer ? layerCut(layer, plane) : { axis: cutAxis(plane), index: scene.cut_index(view) };
}

/**
 * Translate live WASM scene state into what `view` sees of a dataset.
 * Returns `null` when `view_query` has no `visible_entities`, as for a
 * dataset the view does not show; the caller leaves the view out.
 */
export function buildViewSnapshot(args: BuildViewSnapshotArgs): ViewSnapshot | null {
  const { scene, view, datasetId, dataset, layer, mode } = args;

  // With `entitiesOverride`, steps 1 to 4 are skipped. Steps 5 and 6 still
  // run so the region and selection stay fresh.
  const entitiesOverride = args.entitiesOverride;

  // 1. view_query: null or empty before the dataset is registered.
  let vq: ViewQueryJson | null = null;
  if (!entitiesOverride) {
    const vqJson = scene.view_query(view, datasetId);
    vq = JSON.parse(vqJson) as ViewQueryJson | null;
    if (!vq || !vq.visible_entities) return null;
  }

  // 2. plane_positions: entityId to where the view places it.
  const precomputed = args.precomputed;
  let positions: Record<string, [number, number]> = {};
  if (!entitiesOverride) {
    if (precomputed?.positions) {
      positions = precomputed.positions;
    } else {
      const posJson = scene.plane_positions(view, datasetId);
      positions = JSON.parse(posJson);
    }
  }

  // 3. Manifest maps: image specs, and the parent edges that group tiles.
  // 4. Translate rows with the shared builder so the full path and the
  //    delta fold produce identical records. A Tile with no parent edge
  //    throws in {@link makeEntitySnapshot}, at assembly, not in `groupMembers`.
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
    const deps: SnapshotEntityDeps = { imageSpecById, parentByEntityId, positions };
    // Only the override branch leaves `vq` null.
    entities = vq!.visible_entities!.map((e) => makeEntitySnapshot(e, deps));
  }

  // 5. visible_region: null until WASM has one for this dataset.
  const vrJson = scene.visible_region(view, datasetId);
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
        ...(vr.side_planes !== undefined ? { sidePlanes: vr.side_planes } : {}),
        ...(vr.cut_axis !== undefined ? { cutAxis: vr.cut_axis } : {}),
      }
    : DEFAULT_VISIBLE_REGION;

  // 6. Selection: the channels the layer shows, at the scene's t and z
  //    clamped into the layer.
  const selection: SelectionState = {
    t: layer?.t ?? scene.t(),
    z: layer?.z_range.start ?? scene.z(),
    cut: sliceCut(scene, view, layer),
    visibleChannels: shownChannels(layer),
    renderMode: mode,
    interactionState: "idle",
  };

  return { view, entities, visibleRegion, selection };
}
