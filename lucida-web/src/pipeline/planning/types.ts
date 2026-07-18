/** Pure planning-domain types for the single chunk residency path. */

import type { LevelGeometry } from "../../manifestTypes.ts";
import type { ChunkContract, ChunkSourceDType } from "../../chunkContract.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { VisibleRegion } from "../viewport.ts";

export interface BaseEntitySnapshot {
  entityId: string;
  imageId: string;
  visible: boolean;
  projectedDiagonalPx: number;
  projectedAreaPx2: number;
  centroidWorld: [number, number, number];
  idealTargetLod: number;
  /** Source/generated-ready pyramid level used for the detail tier. */
  detailLevel: number;
  /** Compatible source/generated-ready coarse level, or no coarse fallback. */
  coarseLevel: number | null;
  importance: number;
  layoutPositionVox: [number, number];
  levels: LevelGeometry[];
  /** Admitted source dtype used to create each request's immutable contract. */
  sourceDtype: ChunkSourceDType;
}

export interface ImageSnapshot extends BaseEntitySnapshot {
  kind: "Image";
}

export interface GroupSnapshot extends BaseEntitySnapshot {
  kind: "Group";
}

export interface TileSnapshot extends BaseEntitySnapshot {
  kind: "Tile";
  parentId: string;
}

export type EntitySnapshot = ImageSnapshot | GroupSnapshot | TileSnapshot;

export interface SelectionState {
  t: number;
  c: number;
  z: number;
  visibleChannels: number[];
  renderMode: "slice" | "volume";
  interactionState: "idle" | "panning" | "zooming" | "scrubbing";
}

export interface CacheStateSnapshot {
  cached: Map<string, Set<string>>;
  inFlight: Map<string, Set<string>>;
}

export interface MinimapChunkCoord {
  level: number;
  x: number;
  y: number;
  z: number;
  t: number;
  c: number;
  key: string;
}

export interface PlanningSnapshot {
  datasetId: string;
  epochs: SceneEpochs;
  entities: EntitySnapshot[];
  visibleRegion: VisibleRegion;
  selection: SelectionState;
  minimapPending: Map<string, MinimapChunkCoord[]>;
}

/** Opaque carry-forward seam retained for future chunk-planning state. */
export interface PlanningState {
  previousActiveSet: ActiveSetEntry[];
}

export interface RequestPlan {
  requests: ChunkRequest[];
  activeSet: ActiveSetEntry[];
  epochs: SceneEpochs;
  stats: PlanStats;
  nextState: PlanningState;
}

export interface PlanStats {
  culling: PlanCullingStats;
}

export interface PlanCullingStats {
  considered: number;
  afterXyBounds: number;
  afterZRange: number;
  afterFrustum: number;
}

export function emptyPlanStats(): PlanStats {
  return {
    culling: { considered: 0, afterXyBounds: 0, afterZRange: 0, afterFrustum: 0 },
  };
}

export interface ChunkRequest {
  datasetId: string;
  entityId: string;
  imageId: string;
  level: number;
  t: number;
  c: number;
  z: number;
  y: number;
  x: number;
  lane: "minimap" | "detail" | "coarse" | "prefetch";
  tier?: "detail" | "coarse";
  priority: number;
  chunkKey: string;
  /** Immutable pixel/shape contract carried through every downstream seam. */
  contract: ChunkContract;
}

/** The one surviving visible residency mode: ordinary pyramid chunks. */
export type EntityMode = "tiles-with-detail";

export type ActiveSetEntry = TileEntry | InvisibleEntry;

export interface TileEntry {
  kind: "tile";
  entityId: string;
  imageId: string;
  mode: EntityMode;
  targetLod: number;
  coarsestDetailLod: number;
  detailOwnedLodRange: [number, number];
  detailLevel: number;
  coarseLevel: number | null;
  wantedLodLevels: number[];
}

export interface InvisibleEntry {
  kind: "invisible";
  entityId: string;
  imageId: string;
  coarsestLod: number;
}

export interface MemberGroup {
  groupId: string;
  groupEntity: EntitySnapshot | null;
  tiles: EntitySnapshot[];
  projectedDiagonalPx: number;
}
