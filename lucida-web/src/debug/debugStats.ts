/**
 * Global debug stats sink.
 *
 * The render loop writes stats here during each tick. The DebugOverlay
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
  renderPassCount: number;
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
  renderPassCount: 0,
  visibleMembers: 0,
  totalMembers: 0,
  activeChannels: 1,
  planCacheHits: 0,
  planCacheMisses: 0,
  memberStats: [],
  mode: "",
};

/** Reset per-frame counters. Call at the start of each tick. */
export function resetFrameStats(): void {
  debugStats.planCacheHits = 0;
  debugStats.planCacheMisses = 0;
  debugStats.memberStats = [];
  debugStats.visibleMembers = 0;
  debugStats.totalMembers = 0;
  debugStats.renderPassCount = 0;
  debugStats.uploadBytesUsed = 0;
  debugStats.budgetExhausted = false;
}
