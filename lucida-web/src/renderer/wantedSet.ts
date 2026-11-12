/**
 * Diffs the planner's wanted chunks against what the atlases hold, and
 * reads off from the wanted target-level chunks which level serves each
 * entity's visible pixels. Pure and GPU-free.
 *
 * The chunks come from the cold state, never from view geometry, so this
 * wants exactly what the page delivers.
 */

import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  EntityLevelReport,
  LevelRange,
  MissingChunk,
} from "./workerProtocol.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import { RESIDENCY_TIERS } from "../pipeline/residencyTier.ts";
import { makeCompositeKey, parsePlaneChunkKey, planeChunkKey } from "./chunkKeys.ts";
import type { SpatialAxis } from "./slicePlane.ts";
import { memberIdForColdEntry } from "./descriptorBuffer.ts";
import { detailTierLevels, targetLevelOf } from "./entitySources.ts";
import { sliceChunkIndex, sliceLevelPlane } from "./slicePlane.ts";
import { wantedEntryKey, type WantedChunkIndex } from "./wantedChunks.ts";

/** One level's section metadata for a member in a shared pool. */
export interface AtlasLevelMeta {
  level: number;
  gridDims: [number, number, number];   // [Z, Y, X]
  chunkDims: [number, number, number];  // [Z, Y, X]
  offset: number;
}

/** Minimal shared-pool atlas state for wanted-set computation. */
export interface AtlasSnapshot {
  z?: number; // only for slice atlases
  /** Slots keyed by composite slot key (`chunkKeys.ts`). */
  slots: Map<string, number>;
  /**
   * Slice atlases only: the planes of each `"memberId|chunkKey"` the pool
   * holds. A chunk held only at planes other than the one `z` maps to holds
   * stale data and counts as missing.
   */
  planesByChunk?: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /** Per-entity level sections. */
  entityMetas?: ReadonlyMap<string, readonly AtlasLevelMeta[]>;
}

export interface WantedSetResult {
  missing: MissingChunk[];
  /** One report per tile entry with a target level, in active-set order. */
  levels: EntityLevelReport[];
}

/**
 * Which pool holds a member's section for one (tier, level). Mirrors
 * `ViewDraw.routes`; `undefined` when the view lays out no section for
 * that level.
 */
export type SourcePoolResolver = (
  memberId: string,
  tier: ResidencyTier,
  level: number,
) => string | undefined;

/**
 * Compute which wanted chunks the GPU worker is missing, and which level
 * serves each entity's visible pixels.
 *
 * Only the planner's wanted keys are reported missing. The coarser levels
 * kept under the target are sampled when resident but never wanted. A
 * position's serving level is the first in sampling order whose covering
 * chunks are all resident; a position no level covers is blank and counts
 * toward neither end of the entity's range.
 *
 * Each member's wanted chunks are worked out into the slot lookups they need
 * once, and `memo` keeps that work for the next call while what it read is
 * unchanged, so a call that follows a view move costs one lookup per wanted
 * chunk plus the members the move changed. Residency is read afresh on
 * every call.
 */
export function computeWantedSet(
  coldState: ColdStateMessage,
  wanted: WantedChunkIndex,
  volumeAtlases: Map<string, AtlasSnapshot>,
  sliceAtlases: Map<string, AtlasSnapshot>,
  poolFor: SourcePoolResolver,
  memo: WantedSetMemo = new WantedSetMemo(),
): WantedSetResult {
  const missing: MissingChunk[] = [];
  const levels: EntityLevelReport[] = [];

  if (coldState.activeSet.length === 0) {
    memo.clear();
    return { missing, levels };
  }

  const atlases = coldState.viewMode === "volume" ? volumeAtlases : sliceAtlases;
  // The slice worker's frame: keys read across the screen, down it, and
  // along the cut, as the cold state's geometry is laid out.
  const sliceAxis = coldState.viewMode === "slice" ? coldState.sliceAxis ?? "z" : "z";
  const scope: PlanScope = {
    datasetId: coldState.datasetId,
    t: coldState.currentT,
    viewMode: coldState.viewMode,
    sliceAxis,
  };
  memo.begin(scope);

  for (const entry of coldState.activeSet) {
    const targetLevel = targetLevelOf(entry);
    const tally = new LevelTally();

    for (const channel of coldState.visibleChannels) {
      const plan = memo.plan(entry, channel, wanted, atlases, poolFor);
      for (const lookup of plan.lookups) {
        if (!holds(atlases.get(lookup.poolKey)!, lookup.slotKey, lookup.plane)) missing.push(lookup.missing);
        if (lookup.serving) tally.record(servingLevel(lookup.serving, atlases));
      }
    }

    if (targetLevel !== undefined) {
      levels.push({
        entityId: entry.entityId,
        targetLevel,
        visible: tally.visible,
        displayed: tally.displayed(),
      });
    }
  }

  memo.end();
  return { missing, levels };
}

/** What every member plan of one call shares; a change in any of it plans every member again. */
interface PlanScope {
  datasetId: string;
  t: number;
  viewMode: ColdStateMessage["viewMode"];
  sliceAxis: SpatialAxis;
}

function sameScope(a: PlanScope | null, b: PlanScope): boolean {
  return a !== null && a.datasetId === b.datasetId && a.t === b.t && a.viewMode === b.viewMode && a.sliceAxis === b.sliceAxis;
}

/**
 * One wanted chunk the view has a section for: where it lives and, for a
 * target-level chunk of the detail tier, the sections that may serve its
 * position.
 */
interface ChunkLookup {
  poolKey: string;
  slotKey: string;
  /** The plane of the chunk the pool must hold, in a slice view; null in a volume view. */
  plane: number | null;
  /** What the report says when the pool lacks it. */
  missing: MissingChunk;
  /** The sampled sections' covering chunks, in sampling order; null for a chunk that is not a target position. */
  serving: Coverage[] | null;
}

/** The chunks of one sampled level that cover a target position, all of which it needs resident to serve it. */
interface Coverage {
  level: number;
  poolKey: string;
  slotKeys: string[];
  plane: number | null;
}

/** One member's lookups, and the reads they were worked out from. */
interface MemberPlan {
  /** The member's keys into the wanted chunk index, and the sets it read there. */
  detailKey: string;
  coarseKey: string;
  detail: ReadonlySet<string> | undefined;
  coarse: ReadonlySet<string> | undefined;
  reads: SectionReads;
  lookups: ChunkLookup[];
}

/**
 * The member plans of one view's draw of a dataset, kept from one call to
 * the next. A plan holds while the member's entry, its wanted chunk sets and
 * every pool and section it read are the same objects and values; the cold
 * state replaces each of those, never changes one in place, when it changes.
 * Plans are found by entry and channel, so a call builds no strings for the
 * members it keeps.
 */
export class WantedSetMemo {
  private plans = new Map<ColdStateActiveEntry, Map<number, MemberPlan>>();
  private used = new Map<ColdStateActiveEntry, Map<number, MemberPlan>>();
  private scope: PlanScope | null = null;

  /** Forget every plan. */
  clear(): void {
    this.plans.clear();
    this.used.clear();
    this.scope = null;
  }

  begin(scope: PlanScope): void {
    if (!sameScope(this.scope, scope)) this.plans.clear();
    this.scope = scope;
    this.used = new Map();
  }

  /** Keep only the plans this call used: a member that left the active set is planned afresh if it returns. */
  end(): void {
    this.plans = this.used;
    this.used = new Map();
  }

  plan(
    entry: ColdStateActiveEntry,
    channel: number,
    wanted: WantedChunkIndex,
    atlases: ReadonlyMap<string, AtlasSnapshot>,
    poolFor: SourcePoolResolver,
  ): MemberPlan {
    const held = this.plans.get(entry)?.get(channel);
    const plan = held
        && held.detail === wanted.get(held.detailKey)
        && held.coarse === wanted.get(held.coarseKey)
        && held.reads.stillHold(atlases, poolFor)
      ? held
      : planMember(this.scope!, entry, channel, wanted, atlases, poolFor);
    let byChannel = this.used.get(entry);
    if (!byChannel) this.used.set(entry, (byChannel = new Map()));
    byChannel.set(channel, plan);
    return plan;
  }
}

/**
 * The pools and sections a plan read for one member, so a later call can
 * tell whether they would read the same.
 */
class SectionReads {
  private readonly pools = new Map<string, { tier: ResidencyTier; level: number; poolKey: string | undefined }>();
  private readonly sections = new Map<string, { metas: readonly AtlasLevelMeta[] | undefined; z: number | undefined }>();
  private readonly memberId: string;

  constructor(memberId: string) {
    this.memberId = memberId;
  }

  /** The pool and atlas holding the member's section for (tier, level), or undefined when the view lays out none. */
  section(
    tier: ResidencyTier,
    level: number,
    atlases: ReadonlyMap<string, AtlasSnapshot>,
    poolFor: SourcePoolResolver,
  ): { poolKey: string; atlas: AtlasSnapshot } | undefined {
    const key = `${tier}|${level}`;
    let read = this.pools.get(key);
    if (!read) {
      read = { tier, level, poolKey: poolFor(this.memberId, tier, level) };
      this.pools.set(key, read);
    }
    const { poolKey } = read;
    if (!poolKey) return undefined;
    const atlas = atlases.get(poolKey);
    const metas = atlas?.entityMetas?.get(this.memberId);
    this.sections.set(poolKey, { metas, z: atlas?.z });
    if (atlas === undefined || !(metas?.some((m) => m.level === level) ?? false)) return undefined;
    return { poolKey, atlas };
  }

  stillHold(atlases: ReadonlyMap<string, AtlasSnapshot>, poolFor: SourcePoolResolver): boolean {
    for (const { tier, level, poolKey } of this.pools.values()) {
      if (poolFor(this.memberId, tier, level) !== poolKey) return false;
    }
    for (const [poolKey, { metas, z }] of this.sections) {
      const atlas = atlases.get(poolKey);
      if (atlas?.entityMetas?.get(this.memberId) !== metas || atlas?.z !== z) return false;
    }
    return true;
  }
}

/** Work out the lookups one member's wanted chunks need. */
function planMember(
  scope: PlanScope,
  entry: ColdStateActiveEntry,
  channel: number,
  wanted: WantedChunkIndex,
  atlases: ReadonlyMap<string, AtlasSnapshot>,
  poolFor: SourcePoolResolver,
): MemberPlan {
  const memberId = memberIdForColdEntry(entry, channel);
  const detailKey = wantedEntryKey("detail", memberId);
  const coarseKey = wantedEntryKey("coarse", memberId);
  const keys = { detail: wanted.get(detailKey), coarse: wanted.get(coarseKey) };
  const reads = new SectionReads(memberId);
  const section = (tier: ResidencyTier, level: number) => reads.section(tier, level, atlases, poolFor);
  const grids = new Map<number, LevelGrid | undefined>();
  const gridOf = (level: number): LevelGrid | undefined => {
    if (!grids.has(level)) grids.set(level, levelGrid(entry, level));
    return grids.get(level);
  };
  const targetLevel = targetLevelOf(entry);
  const sampled = targetLevel === undefined ? [] : resolveSampledLevels(entry, section, gridOf);
  const lookups: ChunkLookup[] = [];

  for (const tier of RESIDENCY_TIERS) {
    const tierKeys = tier === "detail" ? keys.detail : keys.coarse;
    if (tierKeys === undefined) continue;
    for (const chunkKey of tierKeys) {
      const chunk = parsePlaneChunkKey(chunkKey, scope.sliceAxis);
      if (chunk === null) continue;
      const held = section(tier, chunk.level);
      if (held === undefined) continue;
      const grid = gridOf(chunk.level);
      if (grid === undefined) continue;

      const context: SampleContext = {
        memberId,
        channel,
        t: scope.t,
        viewMode: scope.viewMode,
        sliceZ: held.atlas.z ?? 0,
        sliceAxis: scope.sliceAxis,
      };
      const plane = context.viewMode === "slice" ? currentPlane(grid, context) : null;
      lookups.push({
        poolKey: held.poolKey,
        slotKey: makeCompositeKey(memberId, chunkKey),
        plane,
        missing: {
          datasetId: scope.datasetId,
          tier,
          entityId: entry.entityId,
          memberId,
          c: channel,
          chunkKey,
          ...(plane !== null ? { cut: { axis: scope.sliceAxis, plane } } : {}),
        },
        serving: tier === "detail" && chunk.level === targetLevel
          ? coverages(sampled, grid, [chunk.x, chunk.y, chunk.z], context)
          : null,
      });
    }
  }

  return { detailKey, coarseKey, detail: keys.detail, coarse: keys.coarse, reads, lookups };
}

/** Whether the atlas holds this slot key, at `plane` in a slice pool that tracks planes. */
function holds(atlas: AtlasSnapshot, slotKey: string, plane: number | null): boolean {
  if (plane === null || atlas.planesByChunk === undefined) return atlas.slots.has(slotKey);
  return atlas.planesByChunk.get(slotKey)?.has(plane) ?? false;
}

/** The finest and coarsest serving level seen over one entity's wanted target-level chunks. */
class LevelTally {
  visible = false;
  private finest = Infinity;
  private coarsest = -Infinity;

  /** Record one wanted chunk position: `null` for one no level covers. */
  record(level: number | null): void {
    this.visible = true;
    if (level === null) return;
    this.finest = Math.min(this.finest, level);
    this.coarsest = Math.max(this.coarsest, level);
  }

  displayed(): LevelRange | null {
    if (!Number.isFinite(this.finest)) return null;
    return { min: this.finest, max: this.coarsest };
  }
}

/** What identifies the chunks one member samples at the current selection. */
interface SampleContext {
  memberId: string;
  channel: number;
  t: number;
  viewMode: ColdStateMessage["viewMode"];
  /** The pool's full-resolution plane; ignored in volume mode. */
  sliceZ: number;
  /** The axis a slice view cuts, the frame its grids are in. */
  sliceAxis: SpatialAxis;
}

/**
 * One level's chunk grid for an entry, with its footprint in level-0 voxels.
 * Every triple is ordered [X, Y, Z]; the cold-state metas are [Z, Y, X].
 */
interface LevelGrid {
  level: number;
  /** Voxels per chunk at this level. */
  chunkDims: [number, number, number];
  /** Level-0 voxels per chunk. */
  chunkWorld: [number, number, number];
  /** Chunks per axis. */
  grid: [number, number, number];
  /** Level-0 voxel dimensions. */
  fullDims: [number, number, number];
  /** This level's voxel dimensions. */
  levelDims: [number, number, number];
}

function levelGrid(entry: ColdStateActiveEntry, lvl: number): LevelGrid | undefined {
  const levelMeta = entry.levels.find((l) => l.level === lvl);
  if (levelMeta === undefined) return undefined;
  const [chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
  const [gridZ, gridY, gridX] = levelMeta.gridShape;
  const level0Meta = entry.levels.find((l) => l.level === 0);
  const fullDims: [number, number, number] = [
    level0Meta?.levelDims[2] ?? levelMeta.levelDims[2],
    level0Meta?.levelDims[1] ?? levelMeta.levelDims[1],
    level0Meta?.levelDims[0] ?? levelMeta.levelDims[0],
  ];
  const levelDims: [number, number, number] = [
    levelMeta.levelDims[2],
    levelMeta.levelDims[1],
    levelMeta.levelDims[0],
  ];
  return {
    level: lvl,
    chunkDims: [chunkX, chunkY, chunkZ],
    chunkWorld: [
      chunkX * (fullDims[0] / Math.max(1, levelDims[0])),
      chunkY * (fullDims[1] / Math.max(1, levelDims[1])),
      chunkZ * (fullDims[2] / Math.max(1, levelDims[2])),
    ],
    grid: [gridX, gridY, gridZ],
    fullDims,
    levelDims,
  };
}

/** The half-open Z chunk range holding the current plane at one level: one chunk. */
function sliceChunkRange(grid: LevelGrid, sliceZ: number): [number, number] {
  const chunkIdx = sliceChunkIndex(sliceZ, grid.fullDims[2], grid.levelDims[2], grid.chunkDims[2]);
  return [Math.max(0, chunkIdx), Math.min(grid.grid[2], chunkIdx + 1)];
}

/** The plane of a level the view's Z maps to. */
function currentPlane(grid: LevelGrid, context: SampleContext): number {
  return sliceLevelPlane(context.sliceZ, grid.fullDims[2], grid.levelDims[2]);
}

/** One section the shader may sample for a member, with the pool it reads. */
interface SampledLevel {
  grid: LevelGrid;
  poolKey: string;
}

/**
 * The sections the renderer samples for one member, in sampling order:
 * the detail-tier levels finest first (the target, then the coarser
 * levels kept under it), then the coarse tier. A level the worker holds
 * no section for is skipped, as `selectEntitySources` skips it.
 */
function resolveSampledLevels(
  entry: ColdStateActiveEntry,
  sectionOf: (tier: ResidencyTier, level: number) => { poolKey: string } | undefined,
  gridOf: (level: number) => LevelGrid | undefined,
): SampledLevel[] {
  const order: Array<{ tier: ResidencyTier; level: number }> = detailTierLevels(entry)
    .map((level) => ({ tier: "detail" as const, level }));
  if (entry.coarseLevel !== null) {
    order.push({ tier: "coarse", level: entry.coarseLevel });
  }
  const sampled: SampledLevel[] = [];
  for (const { tier, level } of order) {
    const section = sectionOf(tier, level);
    if (section === undefined) continue;
    const grid = gridOf(level);
    if (grid === undefined) continue;
    sampled.push({ grid, poolKey: section.poolKey });
  }
  return sampled;
}

/**
 * The chunks of each sampled level that cover one target-level chunk
 * position, in sampling order. A level whose covering range is empty can
 * never serve the position and is left out.
 */
function coverages(
  sampled: readonly SampledLevel[],
  target: LevelGrid,
  [ix, iy, iz]: [number, number, number],
  context: SampleContext,
): Coverage[] {
  const out: Coverage[] = [];
  for (const { grid, poolKey } of sampled) {
    const [x0, x1] = coveringRange(ix, target.chunkWorld[0], grid.chunkWorld[0], grid.grid[0]);
    const [y0, y1] = coveringRange(iy, target.chunkWorld[1], grid.chunkWorld[1], grid.grid[1]);
    const [z0, z1] = context.viewMode === "slice"
      ? sliceChunkRange(grid, context.sliceZ)
      : coveringRange(iz, target.chunkWorld[2], grid.chunkWorld[2], grid.grid[2]);
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) continue;
    const slotKeys: string[] = [];
    for (let z = z0; z < z1; z++) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const chunkKey = planeChunkKey(grid.level, context.t, context.channel, [x, y, z], context.sliceAxis);
          slotKeys.push(makeCompositeKey(context.memberId, chunkKey));
        }
      }
    }
    out.push({
      level: grid.level,
      poolKey,
      slotKeys,
      plane: context.viewMode === "slice" ? currentPlane(grid, context) : null,
    });
  }
  return out;
}

/**
 * The level that serves one target-level chunk position: the first
 * sampled level whose chunks covering that footprint are all resident,
 * or `null` when no level covers it and it is blank on screen.
 */
function servingLevel(serving: readonly Coverage[], atlases: ReadonlyMap<string, AtlasSnapshot>): number | null {
  for (const { level, poolKey, slotKeys, plane } of serving) {
    const atlas = atlases.get(poolKey)!;
    if (slotKeys.every((slotKey) => holds(atlas, slotKey, plane))) return level;
  }
  return null;
}

/**
 * The half-open index range of a candidate level's chunks that the target
 * chunk `index` spans along one axis, in level-0 voxels, clipped to the
 * candidate's grid. Usually one chunk: a coarser chunk is at least as wide
 * as a target chunk unless the pyramid shrinks chunk shapes faster than it
 * shrinks levels.
 */
function coveringRange(
  index: number,
  targetWorld: number,
  candidateWorld: number,
  candidateGrid: number,
): [number, number] {
  const start = Math.max(0, Math.floor((index * targetWorld) / candidateWorld));
  const end = Math.min(candidateGrid, Math.ceil(((index + 1) * targetWorld) / candidateWorld));
  return [start, end];
}
