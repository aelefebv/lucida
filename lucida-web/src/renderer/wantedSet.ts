/**
 * Wanted-set computation — pure function that diffs expected chunks against
 * actual atlas contents to determine what the GPU worker is missing, and
 * reads off those same chunk positions which level serves each entity's
 * visible pixels.
 *
 * Reports missing chunks and missing proxy assets via a discriminated
 * union (`MissingChunk | MissingProxy`), plus one {@link EntityLevelReport}
 * per image-bearing entry.
 */

import type {
  ColdStateMessage,
  ColdStateTileEntry,
  EntityLevelReport,
  LevelRange,
  MissingChunk,
  MissingProxy,
} from "./workerProtocol.ts";
import type { ProxyKind } from "../pipeline/assetCatalog.ts";
import {
  RENDER_RADIUS_DISABLED,
  chunkWithinRenderRadius,
} from "../pipeline/renderRadius.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import { makeCompositeKey } from "./chunkKeys.ts";
import { memberIdForColdEntry } from "./descriptorBuffer.ts";
import { detailTierLevels, targetLevelOf } from "./entitySources.ts";
import { sliceChunkZ } from "./slicePlane.ts";

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
  /** Slots keyed by composite "memberId|chunkKey". */
  slots: Map<string, number>;
  /** Per-entity level sections. */
  entityMetas?: Map<string, AtlasLevelMeta[]>;
}

/**
 * Minimal per-pool view of proxy residency for wanted-set queries.
 * Independent from `ProxyAtlasState` so this module stays GPU-free.
 *
 * The map key is the composite slot key `${entityId}|${t}|${c}` —
 * matches `proxySlotKey()` in `./proxyAtlas.ts`. `kind` is carried so
 * residency checks distinguish `GroupProxy3D` vs `TileProxy3D` pools
 * for entities that could appear as either (a defensive safeguard;
 * pool keying already separates them in practice).
 */
export interface ProxyAtlasSnapshot {
  kind: ProxyKind;
  slots: Map<string, number>;
}

export interface WantedSetResult {
  missing: Array<MissingChunk | MissingProxy>;
  /** One report per tile entry with a target level, in active-set order. */
  levels: EntityLevelReport[];
}

/**
 * Which pool holds a member's section for one (tier, level). Mirrors
 * `RendererState.memberSourcePools`; `undefined` when the worker
 * allocated no section for that level.
 */
export type SourcePoolResolver = (
  memberId: string,
  tier: ResidencyTier,
  level: number,
) => string | undefined;

/**
 * Compute which chunks AND proxies the GPU worker is missing, and which
 * level serves each entity's visible pixels.
 *
 * Pure function — no side effects, no GPU dependencies.
 *
 * Chunk wanted-set rules: for each level a tier requests on each visible
 * channel, enumerate the chunk positions inside the visible region and
 * report any whose composite slot key is missing from the pool that
 * holds the level's section. The detail tier requests `detailLevels`
 * only; the coarser levels the worker keeps sections for under the
 * target are sampled when resident but never asked for here.
 *
 * Displayed-level rules: for each visible target-level chunk position,
 * the serving level is the first in the renderer's sampling order (the
 * target, then the coarser detail-tier sections, then the coarse tier)
 * whose chunks covering that position are all resident. An entity's
 * report is the finest and coarsest serving level over its visible
 * positions and channels; a position no level covers is blank on screen
 * and counts toward neither.
 *
 * Proxy wanted-set rules: for each cold-state active entry, walk its
 * `mode`:
 *
 *   - `group-as-proxy` (entry.entityId IS the groupId)
 *       → emit a `MissingProxy { kind: GroupProxy3D }` per visible
 *         channel if the group's slot isn't resident.
 *   - `tiles-with-proxy-fallback` (entry.entityId is the tileId)
 *       → emit a `MissingProxy { kind: TileProxy3D }` for the tile
 *         per channel (if `proxyAvailable`), and a single
 *         `MissingProxy { kind: GroupProxy3D }` for the parent group per
 *         channel (if `groupProxyAvailable` and `parentGroupId` is set).
 *         Parent-group requests are deduped per (parentGroupId, t, c).
 *   - `tiles-with-detail`
 *       → existing chunk wanted-set + a per-channel tile-proxy
 *         request when the catalog advertises one but it isn't yet
 *         resident.
 */
export function computeWantedSet(
  coldState: ColdStateMessage,
  volumeAtlases: Map<string, AtlasSnapshot>,
  sliceAtlases: Map<string, AtlasSnapshot>,
  poolFor: SourcePoolResolver,
  proxyAtlases?: Map<string, ProxyAtlasSnapshot>,
): WantedSetResult {
  const missing: Array<MissingChunk | MissingProxy> = [];
  const levels: EntityLevelReport[] = [];
  const desiredProxyKeys =
    coldState.desiredProxyKeys === undefined
      ? null
      : new Set(coldState.desiredProxyKeys);

  if (coldState.activeSet.length === 0) {
    return { missing, levels };
  }

  const isMultiChannel = coldState.multiChannel;
  const atlases = coldState.viewMode === "volume" ? volumeAtlases : sliceAtlases;

  // Dedup per (groupId, t, c) so multiple tile entries of the same
  // parent only emit one parent-group-proxy request.
  const groupProxyEmitted = new Set<string>();

  for (const entry of coldState.activeSet) {
    // Proxy wanted-set. `entry.kind` discriminates so the tile
    // branches see the tile variant typed-out.
    if (entry.kind === "group-as-proxy") {
      for (const c of coldState.visibleChannels) {
        if (
          isProxyDesired(desiredProxyKeys, coldState.datasetId, entry.entityId, "GroupProxy3D", coldState.currentT, c) &&
          !isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "GroupProxy3D")
        ) {
          missing.push({
            kind: "proxy",
            datasetId: coldState.datasetId,
            entityId: entry.entityId,
            proxyKind: "GroupProxy3D",
            t: coldState.currentT,
            c,
          });
        }
      }
      continue;
    }

    if (entry.mode === "tiles-with-proxy-fallback") {
      if (entry.proxyAvailable && entry.proxyKind === "TileProxy3D") {
        for (const c of coldState.visibleChannels) {
          if (
            isProxyDesired(desiredProxyKeys, coldState.datasetId, entry.entityId, "TileProxy3D", coldState.currentT, c) &&
            !isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "TileProxy3D")
          ) {
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: entry.entityId,
              proxyKind: "TileProxy3D",
              t: coldState.currentT,
              c,
            });
          }
        }
      }
      const groupId = entry.parentGroupId ?? null;
      if (entry.groupProxyAvailable && groupId) {
        for (const c of coldState.visibleChannels) {
          const dk = `${groupId}|${coldState.currentT}|${c}`;
          if (groupProxyEmitted.has(dk)) continue;
          if (
            isProxyDesired(desiredProxyKeys, coldState.datasetId, groupId, "GroupProxy3D", coldState.currentT, c) &&
            !isProxyResident(proxyAtlases, groupId, coldState.currentT, c, "GroupProxy3D")
          ) {
            groupProxyEmitted.add(dk);
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: groupId,
              proxyKind: "GroupProxy3D",
              t: coldState.currentT,
              c,
            });
          } else {
            // Already resident; mark dedup to avoid re-checking.
            groupProxyEmitted.add(dk);
          }
        }
      }
    } else if (entry.mode === "tiles-with-detail") {
      // Tile proxy fallback for the worker to use while detail chunks
      // are still loading. Only request if catalog advertises one.
      if (entry.proxyAvailable && entry.proxyKind === "TileProxy3D") {
        for (const c of coldState.visibleChannels) {
          if (
            isProxyDesired(desiredProxyKeys, coldState.datasetId, entry.entityId, "TileProxy3D", coldState.currentT, c) &&
            !isProxyResident(proxyAtlases, entry.entityId, coldState.currentT, c, "TileProxy3D")
          ) {
            missing.push({
              kind: "proxy",
              datasetId: coldState.datasetId,
              entityId: entry.entityId,
              proxyKind: "TileProxy3D",
              t: coldState.currentT,
              c,
            });
          }
        }
      }
    }

    // Chunk wanted-set. memberIdForColdEntry centralizes the
    // group-as-proxy → entityId convention even though those entries are
    // narrowed out above.
    const members: Array<{ memberId: string; channel: number }> = [];
    if (isMultiChannel) {
      for (const c of coldState.visibleChannels) {
        members.push({
          memberId: memberIdForColdEntry(entry, c, true),
          channel: c,
        });
      }
    } else {
      const channel = coldState.visibleChannels[0];
      members.push({
        memberId: memberIdForColdEntry(entry, channel, false),
        channel,
      });
    }

    const targetLevel = targetLevelOf(entry);
    const tally = new LevelTally();

    for (const { memberId, channel } of members) {
      const sampled = targetLevel === undefined
        ? []
        : resolveSampledLevels(entry, memberId, atlases, poolFor);

      for (const source of chunkSourcesForEntry(entry)) {
        for (const lvl of source.levels) {
          const poolKey = poolFor(memberId, source.tier, lvl);
          if (!poolKey) continue;
          const atlas = atlases.get(poolKey);
          if (atlas === undefined || !hasSection(atlas, memberId, lvl)) continue;

          const grid = levelGrid(entry, lvl);
          if (grid === undefined) continue;

          const layoutPositionVox = entry.layoutPositionVox ?? ([0, 0] as [number, number]);
          const context: SampleContext = {
            memberId,
            channel,
            t: coldState.currentT,
            viewMode: coldState.viewMode,
            sliceZ: atlas.z ?? 0,
          };
          const range = visibleChunkRange(coldState, grid, layoutPositionVox, context);
          const isTarget = source.tier === "detail" && lvl === targetLevel;

          const radiusView = renderRadiusForTier(coldState, source.tier);
          for (let iz = range.zStart; iz < range.zEnd; iz++) {
            for (let iy = range.rowStart; iy < range.rowEnd; iy++) {
              for (let ix = range.colStart; ix < range.colEnd; ix++) {
                if (
                  !chunkWithinRenderRadius({
                    region: coldState.visibleRegion,
                    radiusView,
                    layoutPositionVox,
                    geometry: {
                      fullDims: grid.fullDims,
                      levelDims: grid.levelDims,
                      chunkDims: grid.chunkDims,
                    },
                    chunk: { x: ix, y: iy, z: iz },
                  })
                ) {
                  continue;
                }
                const chunkKey = `${lvl}/${coldState.currentT}/${channel}/${iz}/${iy}/${ix}`;
                const slotKey = makeCompositeKey(memberId, chunkKey);
                if (!atlas.slots.has(slotKey)) {
                  missing.push({
                    kind: "chunk",
                    datasetId: coldState.datasetId,
                    tier: source.tier,
                    entityId: entry.entityId,
                    memberId,
                    c: channel,
                    chunkKey,
                  });
                }
                if (isTarget) {
                  tally.record(servingLevel(sampled, grid, [ix, iy, iz], context));
                }
              }
            }
          }
        }
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

  return { missing, levels };
}

/** The finest and coarsest serving level seen over one entity's visible chunks. */
class LevelTally {
  visible = false;
  private finest = Infinity;
  private coarsest = -Infinity;

  /** Record one visible chunk position: `null` for one no level covers. */
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

function levelGrid(entry: ColdStateTileEntry, lvl: number): LevelGrid | undefined {
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

function hasSection(atlas: AtlasSnapshot, memberId: string, level: number): boolean {
  return atlas.entityMetas?.get(memberId)?.some((m) => m.level === level) ?? false;
}

/** The half-open Z chunk range holding the current plane at one level: one chunk. */
function sliceChunkRange(grid: LevelGrid, sliceZ: number): [number, number] {
  const chunkIdx = sliceChunkZ(sliceZ, grid.fullDims[2], grid.levelDims[2], grid.chunkDims[2]);
  return [Math.max(0, chunkIdx), Math.min(grid.grid[2], chunkIdx + 1)];
}

interface ChunkRange {
  colStart: number;
  colEnd: number;
  rowStart: number;
  rowEnd: number;
  zStart: number;
  zEnd: number;
}

/** The half-open chunk index ranges of one level's grid that touch the visible region. */
function visibleChunkRange(
  coldState: ColdStateMessage,
  grid: LevelGrid,
  layoutPositionVox: [number, number],
  context: SampleContext,
): ChunkRange {
  const [minVoxX, minVoxY, maxVoxX, maxVoxY] = coldState.visibleRegion.xyBoundsVox;
  const localMinVoxX = minVoxX - layoutPositionVox[0];
  const localMinVoxY = minVoxY - layoutPositionVox[1];
  const localMaxVoxX = maxVoxX - layoutPositionVox[0];
  const localMaxVoxY = maxVoxY - layoutPositionVox[1];
  const [chunkWorldX, chunkWorldY, chunkWorldZ] = grid.chunkWorld;
  const [gridX, gridY, gridZ] = grid.grid;

  const colStart = Math.max(0, Math.floor(localMinVoxX / chunkWorldX));
  const colEnd = Math.min(gridX, Math.ceil(localMaxVoxX / chunkWorldX));
  const rowStart = Math.max(0, Math.floor(localMinVoxY / chunkWorldY));
  const rowEnd = Math.min(gridY, Math.ceil(localMaxVoxY / chunkWorldY));

  let zStart: number;
  let zEnd: number;
  if (context.viewMode === "slice") {
    [zStart, zEnd] = sliceChunkRange(grid, context.sliceZ);
  } else {
    zStart = Math.max(0, Math.floor(coldState.visibleRegion.zRangeVox[0] / chunkWorldZ));
    zEnd = Math.min(gridZ, Math.ceil(coldState.visibleRegion.zRangeVox[1] / chunkWorldZ));
  }
  return { colStart, colEnd, rowStart, rowEnd, zStart, zEnd };
}

/** One section the shader may sample for a member, with the pool it reads. */
interface SampledLevel {
  grid: LevelGrid;
  atlas: AtlasSnapshot;
}

/**
 * The sections the renderer samples for one member, in sampling order:
 * the detail-tier levels finest first (the target, then the coarser
 * levels kept under it), then the coarse tier. A level the worker holds
 * no section for is skipped, as `selectEntitySources` skips it.
 */
function resolveSampledLevels(
  entry: ColdStateTileEntry,
  memberId: string,
  atlases: Map<string, AtlasSnapshot>,
  poolFor: SourcePoolResolver,
): SampledLevel[] {
  const order: Array<{ tier: ResidencyTier; level: number }> = detailTierLevels(entry)
    .map((level) => ({ tier: "detail" as const, level }));
  if (entry.coarseLevel !== null) {
    order.push({ tier: "coarse", level: entry.coarseLevel });
  }
  const sampled: SampledLevel[] = [];
  for (const { tier, level } of order) {
    const poolKey = poolFor(memberId, tier, level);
    if (!poolKey) continue;
    const atlas = atlases.get(poolKey);
    if (atlas === undefined || !hasSection(atlas, memberId, level)) continue;
    const grid = levelGrid(entry, level);
    if (grid === undefined) continue;
    sampled.push({ grid, atlas });
  }
  return sampled;
}

/**
 * The level that serves one target-level chunk position: the first
 * sampled level whose chunks covering that footprint are all resident,
 * or `null` when no level covers it and it is blank on screen.
 */
function servingLevel(
  sampled: readonly SampledLevel[],
  target: LevelGrid,
  position: [number, number, number],
  context: SampleContext,
): number | null {
  for (const candidate of sampled) {
    if (covers(candidate, target, position, context)) return candidate.grid.level;
  }
  return null;
}

function covers(
  candidate: SampledLevel,
  target: LevelGrid,
  [ix, iy, iz]: [number, number, number],
  context: SampleContext,
): boolean {
  const { grid, atlas } = candidate;
  const [x0, x1] = coveringRange(ix, target.chunkWorld[0], grid.chunkWorld[0], grid.grid[0]);
  const [y0, y1] = coveringRange(iy, target.chunkWorld[1], grid.chunkWorld[1], grid.grid[1]);
  const [z0, z1] = context.viewMode === "slice"
    ? sliceChunkRange(grid, context.sliceZ)
    : coveringRange(iz, target.chunkWorld[2], grid.chunkWorld[2], grid.grid[2]);
  if (x1 <= x0 || y1 <= y0 || z1 <= z0) return false;
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const chunkKey = `${grid.level}/${context.t}/${context.channel}/${z}/${y}/${x}`;
        if (!atlas.slots.has(makeCompositeKey(context.memberId, chunkKey))) return false;
      }
    }
  }
  return true;
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

function renderRadiusForTier(
  coldState: ColdStateMessage,
  tier: ResidencyTier,
): number {
  return coldState.renderRadiusView?.[tier] ?? RENDER_RADIUS_DISABLED;
}

/** The levels each tier requests for a tile entry, detail first. */
function chunkSourcesForEntry(
  entry: ColdStateTileEntry,
): Array<{ tier: ResidencyTier; levels: number[] }> {
  const sources: Array<{ tier: ResidencyTier; levels: number[] }> = [
    { tier: "detail", levels: entry.detailLevels },
  ];
  if (entry.coarseLevel !== null) {
    sources.push({ tier: "coarse", levels: [entry.coarseLevel] });
  }
  return sources;
}

/**
 * Check whether a proxy is resident across any pool with matching
 * `(entityId, t, c)`. We don't know the pool key from cold state alone
 * (it depends on slot dims and channel); instead we scan all pools
 * indexed by the channel + composite key.
 *
 * In practice the orchestrator provides `proxyAtlases` indexed by
 * `proxyPoolKey()` strings; the slot composite key is unique per
 * `(entityId, t, c)`, so a single hit anywhere counts.
 */
function isProxyResident(
  proxyAtlases: Map<string, ProxyAtlasSnapshot> | undefined,
  entityId: string,
  t: number,
  c: number,
  proxyKind: ProxyKind,
): boolean {
  if (!proxyAtlases || proxyAtlases.size === 0) return false;
  const slotKey = `${entityId}|${t}|${c}`;
  for (const atlas of proxyAtlases.values()) {
    if (atlas.kind !== proxyKind) continue;
    if (atlas.slots.has(slotKey)) return true;
  }
  return false;
}

function isProxyDesired(
  desiredProxyKeys: Set<string> | null,
  datasetId: string,
  entityId: string,
  proxyKind: ProxyKind,
  t: number,
  c: number,
): boolean {
  if (desiredProxyKeys === null) return true;
  return desiredProxyKeys.has(`${datasetId}|${entityId}|${proxyKind}|${t}|${c}`);
}
