/**
 * Snapshot builder — translates live WASM scene state into a
 * {@link PlanningSnapshot}.
 *
 * This module is the single boundary between WASM scene queries
 * (`view_query`, `member_positions`, `visible_region`, `epochs`, `c`,
 * `t`, `z`) and the pure planning core. It honours
 * `wiki/principles/planning.md` §4 (planning is pure) and §5 (WASM
 * owns truth) — every snake_case field returned by WASM is normalised
 * to camelCase here, every fallback is explicit, and the resulting
 * {@link PlanningSnapshot} is the only thing {@link plan} ever sees.
 *
 * Slice 4 of the planning refactor (PRD #545) extracted this from the
 * orchestrator's `planAndFetch` body. Behaviour is preserved verbatim:
 * the same JSON parses, the same fallback shape when `visible_region`
 * is null, the same single-channel vs multi-channel selection rules.
 *
 * The function is pure: it touches no module state, mutates none of
 * its inputs, and produces a fresh {@link PlanningSnapshot} per call.
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

// Re-export {@link MinimapChunkCoord} so existing snapshot.ts callers
// keep working unchanged. Slice 5 of PRD #545 consolidated the
// duplicated declarations (this module + orchestrator.ts) into the
// single canonical definition in `./index.ts` since the type is now
// part of the planning snapshot's public shape.
export type { MinimapChunkCoord } from "./index.ts";

/**
 * Wire shape of one row in the `view_query` JSON output. Mirrors the
 * Rust `VisibleEntity` struct in `lucida-core/src/scene/view_query.rs`
 * (snake_case). Locally typed so this module has no runtime dependency
 * on the orchestrator's private interfaces.
 */
interface VisibleEntityRow {
  entity_id: string;
  image_id: string;
  kind: "Image" | "Well" | "Field";
  visible: boolean;
  projected_diagonal_px: number;
  projected_area_px2: number;
  centroid_world: [number, number, number];
  ideal_target_lod: number;
  importance: number;
}

/** Wire shape of `view_query`'s top-level object. */
interface ViewQueryJson {
  visible_entities?: VisibleEntityRow[];
}

/** Wire shape of `visible_region`'s JSON output (snake_case). */
interface VisibleRegionJson {
  xy_bounds: [number, number, number, number];
  z_range: [number, number];
  effective_zoom: number;
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
 * callers can drop new fields in (see Slice 5 + 6) without churning
 * every test stub.
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
   * accumulated this tick. Slice 5 of PRD #545 wires this through
   * into {@link PlanningSnapshot.minimapPending}; the planner emits
   * one minimap-lane request per coord at
   * {@link MINIMAP_LANE_OFFSET} (highest priority).
   *
   * Pass `new Map()` if the caller has nothing to forward — that
   * value is forwarded verbatim to the snapshot, so the planner
   * emits no minimap requests.
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
 * The body mirrors the historical orchestrator inline assembly step
 * for step (`view_query` → `member_positions` → `visible_region` →
 * stitch in `imageSpec` + `parentId` → assemble `EntitySnapshot[]` →
 * compute selection). Slice 5 of PRD #545 wires `minimapPending`
 * through into {@link PlanningSnapshot.minimapPending} so the
 * planner can emit minimap-lane requests at the highest priority.
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
  // `requestEpoch` and `config` are accepted in the arg shape so the
  // orchestrator's call site is forwards-compatible with Slice 6,
  // but Slice 4/5 don't read them here — the caller already folded
  // `requestEpoch` into `currentEpochs`, and the config is consumed
  // by `plan()` (not the snapshot).
  void args.requestEpoch;
  void args.config;

  // 1. view_query — may be null / empty when the dataset isn't yet
  //    registered in the scene. Caller treats this as "skip this
  //    dataset" (matches the historical `continue`).
  const vqJson = scene.view_query(datasetId);
  const vq = JSON.parse(vqJson) as ViewQueryJson | null;
  if (!vq || !vq.visible_entities) return null;

  // 2. member_positions — keyed by entityId, 2D layout placement.
  const posJson = scene.member_positions(datasetId);
  const positions: Record<string, [number, number]> = JSON.parse(posJson);

  // 3. Build helper maps from the dataset manifest:
  //   - imageSpecById: per-image multiscale levels
  //   - parentByEntityId: stitches `Field.parent === wellId` so promotion
  //     can group fields by their parent well (ADR 0025).
  const imageSpecById = new Map<string, ImageSpec>();
  for (const img of dataset.manifest.images) {
    imageSpecById.set(img.image_id, img);
  }
  const parentByEntityId = new Map<string, string | null>();
  for (const ent of dataset.manifest.entities) {
    parentByEntityId.set(ent.id, ent.parent ?? null);
  }

  // 4. Snake-case → camelCase translation for every visible entity.
  //    Joins the WASM payload with the manifest to pick up `levels` and
  //    `parentId` (neither of which are part of `view_query`). PRD #563
  //    / Slice 1 dropped the redundant `numLevels` field — consumers
  //    derive it from `levels.length`.
  //
  //    PRD #563 / Slice 5: {@link EntitySnapshot} is a discriminated
  //    union. Branch on the WASM-reported `kind` and construct the
  //    matching variant. Field entities require a non-null parent edge
  //    in the manifest — we throw on the missing-edge case rather than
  //    silently coercing, so producer bugs surface during snapshot
  //    assembly rather than later in `groupByWell`.
  const entities: EntitySnapshot[] = vq.visible_entities.map((e) => {
    const imgSpec = imageSpecById.get(e.image_id);
    const levels = imgSpec ? imgSpec.multiscale.levels : [];
    const layoutPositionVox =
      positions[e.entity_id] ?? ([0, 0] as [number, number]);
    const base = {
      entityId: e.entity_id,
      imageId: e.image_id,
      visible: e.visible,
      projectedDiagonalPx: e.projected_diagonal_px,
      projectedAreaPx2: e.projected_area_px2,
      centroidWorld: e.centroid_world,
      idealTargetLod: e.ideal_target_lod,
      importance: e.importance,
      layoutPositionVox,
      levels,
    };
    if (e.kind === "Field") {
      const parentId = parentByEntityId.get(e.entity_id);
      if (parentId === undefined || parentId === null) {
        throw new Error(
          `[planning] Field entity "${e.entity_id}" has no parent edge ` +
            `in the manifest — FieldSnapshot.parentId is required (non-null) ` +
            `as of PRD #563 / Slice 5.`,
        );
      }
      return { kind: "Field", parentId, ...base } satisfies EntitySnapshot;
    }
    if (e.kind === "Well") {
      return { kind: "Well", ...base } satisfies EntitySnapshot;
    }
    return { kind: "Image", ...base } satisfies EntitySnapshot;
  });

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
  //    snapshot so the planner stamps it onto every emitted request
  //    (PRD #563 / Slice 1). PRD #563 / Slice 3: `previousActiveSet`
  //    no longer lives on the snapshot — it moved to {@link PlanningState}
  //    which the orchestrator passes separately to `plan()`.
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
