/**
 * Translates live WASM scene state into a {@link PlanningSnapshot}. The
 * one boundary between WASM scene queries and the pure planning core:
 * snake_case becomes camelCase here and fallbacks are explicit. Pure: no
 * module state, no input mutation.
 */

import type { WasmScene } from "lucida-core";
import type { ImageSpec, DatasetManifest } from "../../manifestTypes.ts";
import type { DatasetSettings } from "../../tickCommon.ts";
import { getActiveChannels } from "../../tickCommon.ts";
import type {
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

/** Inputs to {@link buildPlanningSnapshot}. */
export interface BuildPlanningSnapshotArgs {
  scene: WasmScene;
  datasetId: string;
  /** Manifest entry for `datasetId`; supplies image specs and parent edges. */
  dataset: SnapshotDatasetEntry;
  /** Drives multi-channel selection. */
  dsSettings: DatasetSettings | undefined;
  /**
   * Forwarded verbatim into {@link PlanningSnapshot.minimapPending}. Pass
   * `new Map()` for no minimap requests.
   */
  minimapPending: Map<string, MinimapChunkCoord[]>;
  mode: "slice" | "volume";
  multiChannel: boolean;
  /** Passed through verbatim. */
  currentEpochs: SceneEpochs;
  requestEpoch: number;
  config: PlanningConfig;
  /**
   * Camera-independent inputs a caller may cache per dataset across
   * view-only replans, to skip the `member_positions` parse and the
   * manifest-map rebuilds. Each is optional; an absent one is computed
   * here. A provided value must equal what this builder would compute for
   * the current content and layout epochs, or tile positions and parent
   * edges go wrong.
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
   * Entity snapshots to use verbatim instead of parsing `view_query`, from
   * a caller that folds `view_query_delta` incrementally. Empty is valid.
   * `visibleRegion` and `selection` are still read fresh, so a selection
   * change is never served stale. Records must come from
   * {@link makeEntitySnapshot} so they match the full path.
   */
  entitiesOverride?: EntitySnapshot[];
}

/**
 * The snapshot plus the parts the orchestrator uses directly: `entities`
 * for telemetry and the roster, `visibleRegion` for the
 * coordinate-diagnostic panel.
 */
export interface BuildPlanningSnapshotResult {
  snapshot: PlanningSnapshot;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
}

/**
 * Translate live WASM scene state into a {@link PlanningSnapshot}. Returns
 * `null` when `view_query` has no `visible_entities`; the caller skips the dataset.
 */
export function buildPlanningSnapshot(
  args: BuildPlanningSnapshotArgs,
): BuildPlanningSnapshotResult | null {
  const {
    scene,
    datasetId,
    dataset,
    dsSettings,
    minimapPending,
    mode,
    multiChannel,
    currentEpochs,
  } = args;
  // Not read here: the caller already folded `requestEpoch` into
  // `currentEpochs`, and `plan()` reads `config`.
  void args.requestEpoch;
  void args.config;

  // With `entitiesOverride`, steps 1 to 4 are skipped. Steps 5 and 6 still
  // run so the region and selection stay fresh.
  const entitiesOverride = args.entitiesOverride;

  // 1. view_query: null or empty before the dataset is registered.
  let vq: ViewQueryJson | null = null;
  if (!entitiesOverride) {
    const vqJson = scene.view_query(datasetId);
    vq = JSON.parse(vqJson) as ViewQueryJson | null;
    if (!vq || !vq.visible_entities) return null;
  }

  // 2. member_positions: entityId to 2D layout placement.
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

  // 6. Selection. Single-channel mode plans only the current channel: the
  //    upload path sends one atlas config with one channel, and other
  //    channels' data would contaminate the atlas. Multi-channel mode fans
  //    out to every visible channel.
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

  // `previousActiveSet` is not on the snapshot; it travels in
  // {@link PlanningState}.
  const snapshot: PlanningSnapshot = {
    datasetId,
    epochs: currentEpochs,
    entities,
    visibleRegion,
    selection,
    minimapPending,
  };

  return { snapshot, entities, visibleRegion, selection };
}
