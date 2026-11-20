/**
 * Diffs the planner's wanted chunks against what the atlases hold, and
 * reads off from the wanted detail chunks which level serves each entity's
 * visible pixels. GPU-free.
 *
 * The chunks come from the cold state, never from view geometry, so this
 * wants exactly what the page delivers.
 *
 * A {@link WantedSetTracker} keeps one view's reading from one update to the
 * next and redoes only what changed: a member whose wanted chunks, sections
 * or routes changed, and the chunks whose slots were held or let go. A view
 * holding thousands of chunks then costs each update what changed, not what
 * it holds or wants.
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
import { makeCompositeKey, parseCompositeKey, parsePlaneChunkKey, planeChunkKey } from "./chunkKeys.ts";
import type { SpatialAxis } from "./slicePlane.ts";
import { memberIdForColdEntry } from "./descriptorBuffer.ts";
import { detailTierLevels, finestLevelOf, selectedLevels } from "./entitySources.ts";
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
  /** One report per tile entry, in active-set order. */
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
 * What one pool held or let go since the last update: its slot keys, or
 * `"all"` when that is not known and every slot must be read again.
 */
export type SlotChanges = ReadonlySet<string> | "all";

export interface WantedSetUpdate {
  /**
   * The wanted chunks lacking that this update is the first to name: wanted
   * since the last one, or whose slot was held or let go since it. One the
   * view lacked at the last update and still lacks is not named again.
   */
  missing: MissingChunk[];
  /** One report per tile entry, in active-set order; null when the last update's still stands. */
  levels: EntityLevelReport[] | null;
}

/**
 * Compute which wanted chunks the GPU worker is missing, and which level
 * serves each entity's visible pixels, from nothing kept.
 *
 * Only the planner's wanted keys are reported missing. The coarser levels
 * kept under the finest are sampled when resident but never wanted. A
 * position's serving level is the first in sampling order whose covering
 * chunks are all resident; a position no level covers is blank and counts
 * toward neither end of the entity's range.
 */
export function computeWantedSet(
  coldState: ColdStateMessage,
  wanted: WantedChunkIndex,
  volumeAtlases: Map<string, AtlasSnapshot>,
  sliceAtlases: Map<string, AtlasSnapshot>,
  poolFor: SourcePoolResolver,
): WantedSetResult {
  const { missing, levels } = new WantedSetTracker().update(
    coldState, wanted, volumeAtlases, sliceAtlases, poolFor, () => undefined,
  );
  return { missing, levels: levels ?? [] };
}

/** What every member plan of one update shares; a change in any of it plans every member again. */
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
 * chunk of the detail tier, the sections that may serve its position. It
 * carries what was last read of it.
 */
interface ChunkLookup {
  poolKey: string;
  slotKey: string;
  /** The plane of the chunk the pool must hold, in a slice view; null in a volume view. */
  plane: number | null;
  /** What the report says when the pool lacks it. */
  missing: MissingChunk;
  /** The sampled sections' covering chunks, in sampling order; null for a chunk that is not a detail position. */
  serving: Coverage[] | null;
  /** Whether the pool held it when last read. */
  held: boolean;
  /** For a detail position, the level that served it when last read; null when none did. */
  servedBy: number | null;
  /** For a detail position, its entity's count of positions by level. */
  tally: LevelTally | null;
}

/** The chunks of one sampled level that cover a detail position, all of which it needs resident to serve it. */
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
  /** By {@link lookupId}, in the order they were planned. */
  lookups: Map<string, ChunkLookup>;
}

function lookupId(tier: ResidencyTier, chunkKey: string): string {
  return `${tier}|${chunkKey}`;
}

/** Lookups by pool and slot key. */
type LookupIndex = Map<string, Map<string, Set<ChunkLookup>>>;

function indexLookup(index: LookupIndex, poolKey: string, slotKey: string, lookup: ChunkLookup): void {
  let bySlot = index.get(poolKey);
  if (!bySlot) index.set(poolKey, (bySlot = new Map()));
  let lookups = bySlot.get(slotKey);
  if (!lookups) bySlot.set(slotKey, (lookups = new Set()));
  lookups.add(lookup);
}

function unindexLookup(index: LookupIndex, poolKey: string, slotKey: string, lookup: ChunkLookup): void {
  const bySlot = index.get(poolKey);
  const lookups = bySlot?.get(slotKey);
  if (!lookups?.delete(lookup) || lookups.size > 0) return;
  bySlot!.delete(slotKey);
  if (bySlot!.size === 0) index.delete(poolKey);
}

/** The slot objects a pool's residency was read from; another object means another slot map. */
interface PoolSeen {
  slots: Map<string, number>;
  planesByChunk: AtlasSnapshot["planesByChunk"];
}

/**
 * One view's wanted set and level reading, kept from one update to the next.
 *
 * A member plan holds while the member's entry, its wanted chunk sets and
 * every pool and section it read are the same objects and values; the cold
 * state replaces each of those, never changes one in place, when it changes.
 * When only its wanted sets changed, the lookups of the chunks still wanted
 * are kept. Plans are found by entry and channel, so an update builds no
 * strings for the members it keeps.
 *
 * Residency is read again only for the slot keys an update is told changed,
 * through an index from each pool's slot keys to the lookups that read them,
 * as a chunk of its own or as one covering a detail position.
 */
export class WantedSetTracker {
  private plans = new Map<ColdStateActiveEntry, Map<number, MemberPlan>>();
  private tallies = new Map<ColdStateActiveEntry, LevelTally>();
  private scope: PlanScope | null = null;
  private readonly own: LookupIndex = new Map();
  private readonly covering: LookupIndex = new Map();
  private readonly seen = new Map<string, PoolSeen>();
  private levels: EntityLevelReport[] | null = null;

  /**
   * Bring the reading up to date with the cold state, the wanted chunks,
   * the atlases, and the slot keys `changesOf` names for each pool since the
   * last update. A pool whose slot map is another object than last time is
   * read again whole.
   */
  update(
    coldState: ColdStateMessage,
    wanted: WantedChunkIndex,
    volumeAtlases: ReadonlyMap<string, AtlasSnapshot>,
    sliceAtlases: ReadonlyMap<string, AtlasSnapshot>,
    poolFor: SourcePoolResolver,
    changesOf: (poolKey: string) => SlotChanges | undefined,
  ): WantedSetUpdate {
    const named = new Set<ChunkLookup>();
    const missing: MissingChunk[] = [];
    const name = (lookup: ChunkLookup): void => {
      if (lookup.held || named.has(lookup)) return;
      named.add(lookup);
      missing.push(lookup.missing);
    };
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
    if (!sameScope(this.scope, scope) || coldState.activeSet.length === 0) this.forget();
    this.scope = scope;

    const plans = new Map<ColdStateActiveEntry, Map<number, MemberPlan>>();
    const tallies = new Map<ColdStateActiveEntry, LevelTally>();
    for (const entry of coldState.activeSet) {
      const tally = this.tallies.get(entry) ?? new LevelTally();
      tallies.set(entry, tally);
      const byChannel = new Map<number, MemberPlan>();
      plans.set(entry, byChannel);
      for (const channel of coldState.visibleChannels) {
        const prior = this.plans.get(entry)?.get(channel);
        const { plan, added, dropped } = this.plan(scope, entry, channel, wanted, atlases, poolFor, prior);
        byChannel.set(channel, plan);
        for (const lookup of dropped) this.drop(lookup, tally);
        for (const lookup of added) {
          this.add(lookup, tally, atlases);
          name(lookup);
        }
      }
    }
    // What left the active set, or the visible channels, leaves the index.
    for (const [entry, byChannel] of this.plans) {
      for (const [channel, plan] of byChannel) {
        if (plans.get(entry)?.has(channel)) continue;
        const tally = this.tallies.get(entry)!;
        for (const lookup of plan.lookups.values()) this.drop(lookup, tally);
      }
    }
    this.plans = plans;
    this.tallies = tallies;

    for (const [poolKey, atlas] of atlases) {
      const seen = this.seen.get(poolKey);
      this.seen.set(poolKey, { slots: atlas.slots, planesByChunk: atlas.planesByChunk });
      // A pool not read before holds no lookup older than this update's.
      if (!seen) continue;
      const changes = seen.slots === atlas.slots && seen.planesByChunk === atlas.planesByChunk
        ? changesOf(poolKey)
        : "all";
      if (changes !== undefined) this.reread(poolKey, atlas, changes, atlases, name);
    }
    for (const poolKey of this.seen.keys()) if (!atlases.has(poolKey)) this.seen.delete(poolKey);

    const levels = this.levelReports(coldState);
    const changed = this.levels === null || !sameLevelReports(this.levels, levels);
    this.levels = levels;
    return { missing, levels: changed ? levels : null };
  }

  /** Every wanted chunk lacking as last read, member by member in active-set order. */
  lacking(): MissingChunk[] {
    const out: MissingChunk[] = [];
    for (const byChannel of this.plans.values()) {
      for (const plan of byChannel.values()) {
        for (const lookup of plan.lookups.values()) if (!lookup.held) out.push(lookup.missing);
      }
    }
    return out;
  }

  private forget(): void {
    this.plans.clear();
    this.tallies.clear();
    this.own.clear();
    this.covering.clear();
  }

  /**
   * The member's plan now, and the lookups it gained and lost since `prior`.
   * A plan whose reads still hold keeps its lookups and changes only those
   * of the chunks its wanted sets gained or lost, so a move costs what it
   * changed rather than what the member wants.
   */
  private plan(
    scope: PlanScope,
    entry: ColdStateActiveEntry,
    channel: number,
    wanted: WantedChunkIndex,
    atlases: ReadonlyMap<string, AtlasSnapshot>,
    poolFor: SourcePoolResolver,
    prior: MemberPlan | undefined,
  ): { plan: MemberPlan; added: Iterable<ChunkLookup>; dropped: Iterable<ChunkLookup> } {
    if (!prior || !prior.reads.stillHold(atlases, poolFor)) {
      const plan = planMember(scope, entry, channel, wanted, atlases, poolFor);
      return { plan, added: plan.lookups.values(), dropped: prior?.lookups.values() ?? [] };
    }
    const detail = wanted.get(prior.detailKey);
    const coarse = wanted.get(prior.coarseKey);
    if (prior.detail === detail && prior.coarse === coarse) return { plan: prior, added: [], dropped: [] };
    const added: ChunkLookup[] = [];
    const dropped: ChunkLookup[] = [];
    const lookups = new Map(prior.lookups);
    const plan: MemberPlan = { ...prior, detail, coarse, lookups };
    const planner = new MemberPlanner(scope, entry, channel, atlases, poolFor, prior.reads);
    for (const tier of RESIDENCY_TIERS) {
      const before = tier === "detail" ? prior.detail : prior.coarse;
      const after = tier === "detail" ? detail : coarse;
      if (before === after) continue;
      for (const chunkKey of before ?? []) {
        if (after?.has(chunkKey)) continue;
        const id = lookupId(tier, chunkKey);
        const lookup = lookups.get(id);
        if (lookup === undefined) continue;
        lookups.delete(id);
        dropped.push(lookup);
      }
      for (const chunkKey of after ?? []) {
        if (before?.has(chunkKey)) continue;
        const lookup = planner.lookup(tier, chunkKey);
        if (lookup === null) continue;
        lookups.set(lookupId(tier, chunkKey), lookup);
        added.push(lookup);
      }
    }
    return { plan, added, dropped };
  }

  private add(lookup: ChunkLookup, tally: LevelTally, atlases: ReadonlyMap<string, AtlasSnapshot>): void {
    indexLookup(this.own, lookup.poolKey, lookup.slotKey, lookup);
    lookup.held = holds(atlases.get(lookup.poolKey), lookup.slotKey, lookup.plane);
    if (!lookup.serving) return;
    for (const { poolKey, slotKeys } of lookup.serving) {
      for (const slotKey of slotKeys) indexLookup(this.covering, poolKey, slotKey, lookup);
    }
    lookup.servedBy = servingLevel(lookup.serving, atlases);
    lookup.tally = tally;
    tally.add(lookup.servedBy);
  }

  private drop(lookup: ChunkLookup, tally: LevelTally): void {
    unindexLookup(this.own, lookup.poolKey, lookup.slotKey, lookup);
    if (!lookup.serving) return;
    for (const { poolKey, slotKeys } of lookup.serving) {
      for (const slotKey of slotKeys) unindexLookup(this.covering, poolKey, slotKey, lookup);
    }
    tally.remove(lookup.servedBy);
    lookup.tally = null;
  }

  /** Read again what reads `changes` of `poolKey`, and name each chunk that lacks its slot now. */
  private reread(
    poolKey: string,
    atlas: AtlasSnapshot,
    changes: SlotChanges,
    atlases: ReadonlyMap<string, AtlasSnapshot>,
    name: (lookup: ChunkLookup) => void,
  ): void {
    const own = this.own.get(poolKey);
    const covering = this.covering.get(poolKey);
    if (!own && !covering) return;
    const rereadOwn = (lookups: Iterable<ChunkLookup> | undefined): void => {
      for (const lookup of lookups ?? []) {
        lookup.held = holds(atlas, lookup.slotKey, lookup.plane);
        name(lookup);
      }
    };
    const rereadCovering = (lookups: Iterable<ChunkLookup> | undefined): void => {
      for (const lookup of lookups ?? []) {
        const servedBy = servingLevel(lookup.serving!, atlases);
        if (servedBy === lookup.servedBy) continue;
        lookup.tally!.remove(lookup.servedBy);
        lookup.tally!.add(servedBy);
        lookup.servedBy = servedBy;
      }
    };
    if (changes === "all") {
      for (const lookups of own?.values() ?? []) rereadOwn(lookups);
      for (const lookups of covering?.values() ?? []) rereadCovering(lookups);
      return;
    }
    // A slice pool's slot keys name a plane; its lookups read the chunk's planes.
    const sliced = atlas.planesByChunk !== undefined;
    for (const changed of changes) {
      const slotKey = sliced ? chunkSlotKey(changed) : changed;
      if (slotKey === null) continue;
      rereadOwn(own?.get(slotKey));
      rereadCovering(covering?.get(slotKey));
    }
  }

  private levelReports(coldState: ColdStateMessage): EntityLevelReport[] {
    const levels: EntityLevelReport[] = [];
    for (const entry of coldState.activeSet) {
      const targetLevel = entry.targetLevel ?? finestLevelOf(entry);
      if (targetLevel === undefined) continue;
      const tally = this.tallies.get(entry)!;
      levels.push({
        entityId: entry.entityId,
        targetLevel,
        selected: selectedLevels(entry),
        visible: tally.visible,
        displayed: tally.displayed(),
      });
    }
    return levels;
  }
}

/** A slice slot key's chunk, `"memberId|chunkKey"`, as a slice pool's planes are keyed. */
function chunkSlotKey(sliceSlotKey: string): string | null {
  const parsed = parseCompositeKey(sliceSlotKey);
  return parsed === null ? null : makeCompositeKey(parsed.memberId, parsed.chunkKey);
}

function sameLevelReports(a: readonly EntityLevelReport[], b: readonly EntityLevelReport[]): boolean {
  return a.length === b.length && a.every((report, i) => {
    const other = b[i];
    return report.entityId === other.entityId &&
      report.targetLevel === other.targetLevel &&
      report.selected?.min === other.selected?.min &&
      report.selected?.max === other.selected?.max &&
      report.visible === other.visible &&
      report.displayed?.min === other.displayed?.min &&
      report.displayed?.max === other.displayed?.max;
  });
}

/**
 * The pools and sections a plan read for one member, so a later update can
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

/** Work out the lookups one member's wanted chunks need, from nothing kept. */
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
  const planner = new MemberPlanner(scope, entry, channel, atlases, poolFor, new SectionReads(memberId));
  const lookups = new Map<string, ChunkLookup>();
  for (const tier of RESIDENCY_TIERS) {
    for (const chunkKey of (tier === "detail" ? keys.detail : keys.coarse) ?? []) {
      const lookup = planner.lookup(tier, chunkKey);
      if (lookup !== null) lookups.set(lookupId(tier, chunkKey), lookup);
    }
  }
  return { detailKey, coarseKey, detail: keys.detail, coarse: keys.coarse, reads: planner.reads, lookups };
}

/** The lookup of each of one member's wanted chunks, sharing what the member's chunks read alike. */
class MemberPlanner {
  readonly reads: SectionReads;
  private readonly scope: PlanScope;
  private readonly entry: ColdStateActiveEntry;
  private readonly channel: number;
  private readonly memberId: string;
  private readonly atlases: ReadonlyMap<string, AtlasSnapshot>;
  private readonly poolFor: SourcePoolResolver;
  private readonly grids = new Map<number, LevelGrid | undefined>();
  private sampled: SampledLevel[] | null = null;

  constructor(
    scope: PlanScope,
    entry: ColdStateActiveEntry,
    channel: number,
    atlases: ReadonlyMap<string, AtlasSnapshot>,
    poolFor: SourcePoolResolver,
    reads: SectionReads,
  ) {
    this.scope = scope;
    this.entry = entry;
    this.channel = channel;
    this.memberId = memberIdForColdEntry(entry, channel);
    this.atlases = atlases;
    this.poolFor = poolFor;
    this.reads = reads;
  }

  /** The lookup of one wanted chunk, or null when the view lays out no section for it. */
  lookup(tier: ResidencyTier, chunkKey: string): ChunkLookup | null {
    const { scope, entry, memberId } = this;
    const chunk = parsePlaneChunkKey(chunkKey, scope.sliceAxis);
    if (chunk === null) return null;
    const held = this.section(tier, chunk.level);
    if (held === undefined) return null;
    const grid = this.gridOf(chunk.level);
    if (grid === undefined) return null;

    const context: SampleContext = {
      memberId,
      channel: this.channel,
      t: scope.t,
      viewMode: scope.viewMode,
      sliceZ: held.atlas.z ?? 0,
      sliceAxis: scope.sliceAxis,
    };
    const plane = context.viewMode === "slice" ? currentPlane(grid, context) : null;
    return {
      poolKey: held.poolKey,
      slotKey: makeCompositeKey(memberId, chunkKey),
      plane,
      missing: {
        datasetId: scope.datasetId,
        tier,
        entityId: entry.entityId,
        memberId,
        c: this.channel,
        chunkKey,
        ...(plane !== null ? { cut: { axis: scope.sliceAxis, plane } } : {}),
      },
      // A wanted chunk is served by its own level once resident, or a
      // coarser one until then, or by the level one finer the selection
      // just coarsened it from, still resident. Levels finer than that
      // are left out: a chunk's cover two levels down runs to dozens.
      serving: tier === "detail"
        ? coverages(
          this.sampledLevels().filter((level) => level.grid.level >= chunk.level - 1),
          grid, [chunk.x, chunk.y, chunk.z], context,
        )
        : null,
      held: false,
      servedBy: null,
      tally: null,
    };
  }

  private section(tier: ResidencyTier, level: number) {
    return this.reads.section(tier, level, this.atlases, this.poolFor);
  }

  private gridOf(level: number): LevelGrid | undefined {
    if (!this.grids.has(level)) this.grids.set(level, levelGrid(this.entry, level));
    return this.grids.get(level);
  }

  private sampledLevels(): SampledLevel[] {
    if (this.sampled === null) {
      this.sampled = finestLevelOf(this.entry) === undefined
        ? []
        : resolveSampledLevels(this.entry, (tier, level) => this.section(tier, level), (level) => this.gridOf(level));
    }
    return this.sampled;
  }
}

/** Whether the atlas holds this slot key, at `plane` in a slice pool that tracks planes. */
function holds(atlas: AtlasSnapshot | undefined, slotKey: string, plane: number | null): boolean {
  if (atlas === undefined) return false;
  if (plane === null || atlas.planesByChunk === undefined) return atlas.slots.has(slotKey);
  return atlas.planesByChunk.get(slotKey)?.has(plane) ?? false;
}

/**
 * How many of one entity's wanted detail positions each level serves, so
 * the finest and coarsest come out as positions change level one at a time.
 */
class LevelTally {
  private positions = 0;
  /** Positions served, by level. */
  private readonly served: number[] = [];

  /** Count one position, served by `level`, or by none when null. */
  add(level: number | null): void {
    this.positions++;
    if (level !== null) this.served[level] = (this.served[level] ?? 0) + 1;
  }

  remove(level: number | null): void {
    this.positions--;
    if (level !== null) this.served[level]--;
  }

  get visible(): boolean {
    return this.positions > 0;
  }

  displayed(): LevelRange | null {
    let min = -1;
    let max = -1;
    for (let level = 0; level < this.served.length; level++) {
      if (!this.served[level]) continue;
      if (min < 0) min = level;
      max = level;
    }
    return min < 0 ? null : { min, max };
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
 * the detail-tier levels finest first (the finest chosen, then the coarser
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
 * The chunks of each sampled level that cover one wanted chunk's position,
 * in sampling order. A level whose covering range is empty can never serve
 * the position and is left out.
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
    const atlas = atlases.get(poolKey);
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
