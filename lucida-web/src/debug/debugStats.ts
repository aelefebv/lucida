/**
 * Global debug stats sink.
 *
 * The render loop writes stats here during each tick. The DebugPanel
 * component polls them on a timer. This keeps instrumentation decoupled
 * from rendering — the only coupling is this flat, write-anywhere object.
 */

export interface MemberStat {
  id: string;
  level: number;
  numLevels: number;
  chunksNeeded: number;
  chunksSent: number;
}

/** Per-member debug data from the Orchestrator's adapter translation. */
export interface OrchMemberDebug {
  imageId: string;
  position: [number, number];
  neededCount: number;
  prefetchCount: number;
  /** Level selected by upload path: needed[0]?.level */
  uploadLevel: number | undefined;
  /** Breakdown: how many needed chunks at each level */
  levelCounts: Record<number, number>;
  /** True if needed[] contains chunks at more than one level */
  mixedLevels: boolean;
}

/**
 * Per-dataset planning snapshot. Populated by the orchestrator after each
 * full plan() run; replayed onto cache-hit ticks so the panel doesn't
 * blink to zero between non-planning frames.
 *
 * Single datasets and plates use the same shape. For single, `wellsByMode`
 * collapses to a single "fields-with-detail" count; the per-LOD breakdown
 * carries the heavy lifting (it's the dominant signal for "is my LOD
 * selection sane").
 */
export interface PlanningDatasetDebug {
  datasetId: string;
  /** Total chunk requests in the plan, broken down by lane. */
  lanes: { detail: number; runway: number; overview: number };
  /** Proxy requests in the plan (separate from chunk lanes). */
  proxyCount: number;
  /** Total chunk requests in the plan (sum of `lanes`). */
  totalChunks: number;
  /** Chunk requests grouped by LOD level — independent of lane. */
  byLevel: Record<number, number>;
  /**
   * Per-LOD breakdown for the focused dataset. One entry per LOD that
   * appears in the plan, with cross-references against the CPU cache.
   */
  lodBreakdown: Array<{
    level: number;
    planned: number;
    cached: number;
    inFlight: number;
  }>;
  /** Frustum / xy / z culling stages, summed across all entities. */
  culling: {
    considered: number;
    afterXyBounds: number;
    afterZRange: number;
    afterFrustum: number;
  };
  /** Number of times catalog-aware promotion downgraded a well's mode. */
  catalogDegradations: number;
  /** Active-set entries grouped by S6 promotion mode. */
  wellsByMode: {
    wellAsProxy: number;
    fieldsWithProxyFallback: number;
    fieldsWithDetail: number;
  };
  /**
   * Entity nearest the viewport center (or null if no visible entities).
   * Drives the focal-entity inspector in the Planning tab.
   */
  focalEntity: {
    entityId: string;
    parentWellId: string | null;
    kind: string;
    projectedDiagonalPx: number;
    projectedAreaPx2: number;
    importance: number;
    idealTargetLod: number;
    detailOwnedRange: [number, number];
    mode: string;
    /** Human-readable reason for the chosen mode (threshold band). */
    modeReason: string;
    /** Lowest priority value across this entity's chunk requests, or null. */
    topPriority: number | null;
    /** How many chunk requests this entity contributed to the plan. */
    chunkCount: number;
  } | null;
}

/** Orchestrator debug snapshot, populated per planning cycle. */
export interface OrchDebug {
  /** Active set entries from plan() */
  activeSet: Array<{
    entityId: string;
    /** S6 promotion mode — see {@link import("../pipeline/planning.ts").WellMode}. */
    mode: string;
    targetLod: number;
    seedDetailLod: number;
    detailOwnedLodRange: [number, number];
  }>;
  /** Request counts by lane */
  laneCount: { detail: number; runway: number; overview: number };
  /** Request counts by level */
  levelCount: Record<number, number>;
  /** First N requests for inspection */
  topRequests: Array<{
    entityId: string;
    level: number;
    t: number; c: number; z: number; y: number; x: number;
    lane: string;
    priority: number;
    chunkKey: string;
  }>;
  /** Per-member roster entry (for debug display) */
  members: OrchMemberDebug[];
  /** True if any member has mixed levels in needed[] */
  hasMixedLevels: boolean;
  /** Whether this was an epoch cache hit (plan() skipped) */
  epochCacheHit: boolean;
  /** VisibleRegion from WASM (for coordinate debugging) */
  visibleRegion: { xyBounds: [number, number, number, number]; zRange: [number, number]; effectiveZoom: number } | null;
  /** First few entity positions + level0 shape (for overlap debugging) */
  entityDiag: Array<{
    entityId: string;
    position: [number, number];
    fullShape: [number, number] | null; // [fullX, fullY] from level 0
    cachedKeys: number; // how many keys getCachedKeys returned
  }>;
}

export interface DebugStats {
  enabled: boolean;

  // Frame timing
  frameTimeMs: number;
  planTimeMs: number;
  uploadTimeMs: number;

  // LOD
  effectiveZoom: number;
  zoomPerVoxel: number;
  selectedLevel: number;
  numLevels: number;

  // Upload budget
  uploadBytesUsed: number;
  uploadBudgetTotal: number;
  budgetExhausted: boolean;

  // Render passes
  renderPasses: {
    total: number;
    /**
     * Per-dataset breakdown using the original `dsId` from the layer-build
     * loop, not the layer's `datasetId` (which may be a composite key
     * `imageId:chN` in multi-channel mode).
     */
    byDataset: Record<string, number>;
  };
  visibleMembers: number;
  totalMembers: number;

  // Multi-channel
  activeChannels: number;

  // Plan cache
  planCacheHits: number;
  planCacheMisses: number;

  // Per-member breakdown
  memberStats: MemberStat[];

  // Mode
  mode: "slice" | "volume" | "";

  // Orchestrator debug
  orch: OrchDebug | null;

  /**
   * Planning section. Per-dataset because both the lane counts and the
   * LOD breakdown vary per dataset; a single key gives us a panel that
   * groups naturally and avoids the "last dataset wins" aliasing in
   * `orch`. Empty object until the first plan() runs.
   */
  planning: {
    byDataset: Record<string, PlanningDatasetDebug>;
  };

  // Upload path debug (per frame)
  uploadDebug: {
    atlasConfigSent: boolean;
    stateKey: string;
    prevStateKey: string;
    chunksAttempted: number;
    chunksUploaded: number;
    chunksCacheHit: number;
    chunksCacheMiss: number;
    chunksSentSkip: number;
  } | null;
}

export const debugStats: DebugStats = {
  enabled: false,
  frameTimeMs: 0,
  planTimeMs: 0,
  uploadTimeMs: 0,
  effectiveZoom: 0,
  zoomPerVoxel: 0,
  selectedLevel: 0,
  numLevels: 0,
  uploadBytesUsed: 0,
  uploadBudgetTotal: 8 * 1024 * 1024,
  budgetExhausted: false,
  renderPasses: { total: 0, byDataset: {} },
  visibleMembers: 0,
  totalMembers: 0,
  activeChannels: 1,
  planCacheHits: 0,
  planCacheMisses: 0,
  memberStats: [],
  mode: "",
  orch: null,
  planning: { byDataset: {} },
  uploadDebug: null,
};

/** Reset per-frame counters. Call at the start of each tick. */
export function resetFrameStats(): void {
  debugStats.planCacheHits = 0;
  debugStats.planCacheMisses = 0;
  debugStats.memberStats = [];
  debugStats.visibleMembers = 0;
  debugStats.totalMembers = 0;
  debugStats.renderPasses = { total: 0, byDataset: {} };
  debugStats.uploadBytesUsed = 0;
  debugStats.budgetExhausted = false;
}
