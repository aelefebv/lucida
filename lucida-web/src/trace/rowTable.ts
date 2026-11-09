/**
 * The per-chunk lifecycle table: fixed-width rows in parallel typed arrays.
 *
 * A row, not a list of spans. Six phase objects per chunk cost
 * ~1.1 kB; seven uint32 boundary slots cost 28 B, which is what makes
 * unconditional recording affordable. Spans exist only at {@link serialise}.
 *
 * Buffers are preallocated and grow only by doubling, because an allocating
 * recorder produces GC pauses that appear as stalls in its own trace. A
 * doubling adds a block as large as the table rather than copying the table
 * into one twice its size: a copy would land on the one tick whose row crossed
 * the doubling, and that tick is a burst of thousands of rows.
 */

import { RESIDENCY_TIERS } from "../pipeline/residencyTier.ts";
import type { ChunkReading } from "./diagnose/chunkStates.ts";
import { nullableUsToMs } from "./diagnose/phaseRollup.ts";
import type { RowState } from "./diagnose/types.ts";
import { StringPool } from "./stringPool.ts";
import {
  Boundary,
  BOUNDARY_COUNT,
  LANE_NAMES,
  laneIndex,
  NEVER_ADMITTED,
  NOT_DISPATCHED,
  ROW_OUTCOME_NAMES,
  RowOutcome,
  UNSET_STAMP,
  PHASES,
  UNLABELLED,
  type AdmissionColumns,
  type ChunkCoordinates,
  type ChunkRowSource,
  type PhaseTiming,
  type Phase,
  type RowOutcomeValue,
  type TraceRow,
  type WireLabel,
} from "./types.ts";

/** Six coordinate columns per row: level, t, c, z, y, x. */
const COORDS_PER_ROW = 6;

/**
 * A row's state byte holds its last boundary in the low four bits and its
 * outcome above them, and its lane byte its lane in the low four bits and its
 * residency tier above: the two bytes that frees hold the unwanted wait's
 * share without widening the row.
 */
const BOUNDARY_MASK = 0x0f;
const OUTCOME_SHIFT = 4;
const LANE_MASK = 0x0f;
const TIER_SHIFT = 4;

/**
 * The last boundary a row that has stamped nothing holds. Not a boundary
 * index, and above every real one, so the four bits can hold either.
 */
const NO_BOUNDARY = BOUNDARY_MASK;

/** An empty slot in the identity index, and the end of a row's identity chain. */
const NO_ROW = -1;

/**
 * The decode worker's own time, kept as its share of the row's `decode` round
 * trip in sixteen bits. Four bytes would push a run's row-table doubling past
 * the per-run cap, and sixteen bits of microseconds would stop a slow decode
 * at 65 ms; a share is good to one part in 65,534 of any round trip.
 */
const WORK_SHARE_SCALE = 0xfffe;
/** The share column's value for a row whose worker never reported its time. */
const NO_WORK_SHARE = 0xffff;

/**
 * How long a chunk sat decoded before the view wanted it, kept as its share
 * of the row's `upload` in sixteen bits for the same reasons as the decode
 * work.
 */
const UNWANTED_SHARE_SCALE = 0xfffe;
/** The unwanted column's value for a row the view wanted as it was decoded. */
const NO_UNWANTED_SHARE = 0xffff;

/**
 * What the wire carried for a row, kept as its share of the bytes decoded in
 * sixteen bits, for the reason {@link WORK_SHARE_SCALE} gives. A chunk's
 * share is good to a few bytes in its hundreds of kilobytes, and one that
 * crossed decoded is exact.
 */
const WIRE_SHARE_SCALE = 0xffff;

const PLAN_PHASE = PHASES.indexOf("plan");
const QUEUE_PHASE = PHASES.indexOf("queue");

/**
 * The per-row paths read these, so they are copied from their imports
 * once. An import is a live binding, and the test runner's module loader
 * reads one through a getter on every use, which would charge each row a
 * call per read and make the cost gates measure the loader.
 */
const SLOTS_PER_ROW = BOUNDARY_COUNT;
const PHASE_COUNT = PHASES.length;
const UNSET = UNSET_STAMP;
const PLAN_START = Boundary.PlanStart;
const QUEUE_START = Boundary.QueueStart;
const WIRE_START = Boundary.WireStart;
const DECODE_START = Boundary.DecodeStart;
const UPLOAD_START = Boundary.UploadStart;
const PRESENT_START = Boundary.PresentStart;
const IN_FLIGHT = RowOutcome.InFlight;
const COMPLETE = RowOutcome.Complete;
const RETIRED = RowOutcome.Retired;
const NO_RID = UNLABELLED.rid;
const NO_CONNECTION = UNLABELLED.connectionGeneration;
const laneOf = laneIndex;

/**
 * The rows of a run in progress, tallied by how they ended.
 *
 * `inFlight` is the remainder rather than a fourth count: every row is
 * exactly one of the three, and deriving it here is what stops the live view
 * showing three numbers that do not add up to the fourth.
 */
export interface LiveTally {
  complete: number;
  retired: number;
  inFlight: number;
  /**
   * Of the in-flight rows, how many have reached no boundary at all.
   *
   * Zero for anything the recorder made, because a chunk row is born at
   * dispatch with `queue` stamped (`TraceRecorder.beginChunkRow`). This
   * table's own `append` makes an unstamped row, so the count is what stops
   * one going missing between `inFlight` and the phase vector.
   */
  unstamped: number;
}

/** Every column of a run of consecutive rows, starting at row `first`. */
class RowBlock {
  readonly datasetIds: Uint32Array;
  readonly entityIds: Uint32Array;
  readonly imageIds: Uint32Array;
  readonly coords: Uint32Array;
  readonly stamps: Uint32Array;
  readonly rids: Uint32Array;
  readonly connectionGenerations: Uint32Array;
  readonly bytes: Uint32Array;
  /** See {@link WORK_SHARE_SCALE}. */
  readonly decodeWorkShares: Uint16Array;
  /** See {@link WIRE_SHARE_SCALE}. */
  readonly wireShares: Uint16Array;
  /** See {@link UNWANTED_SHARE_SCALE}. */
  readonly unwantedShares: Uint16Array;
  /** Lane and residency tier; see {@link LANE_MASK}. */
  readonly lanes: Uint8Array;
  /**
   * The highest boundary each row has stamped, or {@link NO_BOUNDARY}, and
   * its outcome; see {@link BOUNDARY_MASK}. A row sits in the phase after its
   * last boundary, so this one byte is what lets a stamp move the row
   * between the table's counters without re-reading its slots.
   */
  readonly states: Uint8Array;
  readonly first: number;

  constructor(first: number, size: number) {
    this.first = first;
    // One allocation for every column, widest first, so each starts on a
    // boundary of its own width.
    const buffer = new ArrayBuffer(size * BLOCK_BYTES_PER_ROW);
    let offset = 0;
    const words = (perRow: number): Uint32Array => {
      const column = new Uint32Array(buffer, offset, size * perRow);
      offset += column.byteLength;
      return column;
    };
    const halves = (): Uint16Array => {
      const column = new Uint16Array(buffer, offset, size);
      offset += column.byteLength;
      return column;
    };
    const octets = (): Uint8Array => {
      const column = new Uint8Array(buffer, offset, size);
      offset += size;
      return column;
    };
    this.datasetIds = words(1);
    this.entityIds = words(1);
    this.imageIds = words(1);
    this.coords = words(COORDS_PER_ROW);
    this.stamps = words(SLOTS_PER_ROW);
    this.rids = words(1);
    this.connectionGenerations = words(1);
    this.bytes = words(1);
    this.decodeWorkShares = halves();
    this.wireShares = halves();
    this.unwantedShares = halves();
    this.lanes = octets();
    this.states = octets();
  }
}

/** The columns a block holds per row: the row width less the identity index, which lives outside the blocks. */
const BLOCK_BYTES_PER_ROW = (3 + COORDS_PER_ROW + SLOTS_PER_ROW + 2 + 1) * 4 + 3 * 2 + 2;

/** The ids the pool gave an entity and the image its rows last carried. */
interface EntityIds {
  entity: number;
  imageId: string;
  image: number;
}

export class RowTable {
  /**
   * 3 interned ids + 6 coordinates + 7 boundary slots + the two-part wire
   * label + the bytes the wire delivered, all uint32, plus the decode work's,
   * the wire bytes' and the unwanted wait's uint16 shares, plus two bytes:
   * lane with tier, and last boundary with outcome. Plus
   * the identity index: one int32 per row linking it to the previous row of
   * the same chunk, and two int32 slots per row of capacity in the
   * open-addressing table that finds the newest.
   */
  static readonly BYTES_PER_ROW = (3 + COORDS_PER_ROW + SLOTS_PER_ROW + 2 + 1) * 4 + 3 * 2 + 2 + 4 + 2 * 4;

  private readonly strings = new StringPool();

  /**
   * The first block holds the initial capacity, and each later one as many
   * rows as every block before it, so block `k > 0` starts at row
   * `initial << (k - 1)` and a row's block is the bit length of
   * `row >> shift`.
   */
  private readonly blocks: RowBlock[];
  private readonly shift: number;
  /** The last block, which every append writes into. */
  private tail: RowBlock;

  /**
   * A burst's rows share one dataset, and an entity's rows carry the same
   * image, so the pool is asked once per row rather than three times: the
   * dataset's id is remembered across rows, and the image's per entity.
   */
  private lastDatasetId: string | null = null;
  private lastDataset = 0;
  private readonly entities = new Map<string, EntityIds>();

  /**
   * The identity index: the newest row of every chunk the table holds, so a
   * surface coloring the chunks on screen reads each one in constant time
   * while the interval is open. `index` is an open-addressing table over a
   * hash of the interned dataset and entity ids and the six coordinates, at
   * most half full. `prevSame` links each row to the previous row of the
   * same chunk.
   *
   * Typed arrays sized with the table and rebuilt when it doubles, so the
   * index allocates nothing per row. It compares columns rather than
   * interning a string per chunk.
   *
   * Only a live read uses it, so it is built on the first one and kept
   * current from then on, and a run nobody reads never pays for it. It is
   * counted in the row width whether built or not: a reader must not move
   * the row at which the per-run cap truncates.
   */
  private index: Int32Array | null = null;
  private indexMask = 0;
  private prevSame: Int32Array | null = null;

  /**
   * The live tally, kept as the rows are written: a few typed-array
   * increments per boundary, so the surfaces that read an open run at the
   * tick cadence never walk the rows. The write path's cost is gated in
   * `recorderCost.perf.test.ts`.
   */
  private readonly occupancy = new Uint32Array(PHASE_COUNT);
  private complete = 0;
  private retired = 0;
  private unstamped = 0;

  private rows = 0;
  private capacity: number;

  /** `initialCapacity` is rounded up to a power of two, which the block arithmetic needs. */
  constructor(initialCapacity = 1024) {
    this.shift = Math.ceil(Math.log2(Math.max(1, initialCapacity)));
    this.capacity = 1 << this.shift;
    this.tail = new RowBlock(0, this.capacity);
    this.blocks = [this.tail];
  }

  get length(): number {
    return this.rows;
  }

  get capacityRows(): number {
    return this.capacity;
  }

  /** Bytes allocated, not bytes used, because the cap is on resident memory. */
  get byteLength(): number {
    return this.capacity * RowTable.BYTES_PER_ROW;
  }

  get internedStringCount(): number {
    return this.strings.size;
  }

  private blockOf(row: number): RowBlock {
    return this.blocks[32 - Math.clz32(row >> this.shift)];
  }

  /** Appends an in-flight row with every boundary unset. Returns its index. */
  append(src: ChunkRowSource, tier: 0 | 1): number {
    const index = this.place(src, tier);
    const block = this.tail;
    const at = index - block.first;
    const base = at * SLOTS_PER_ROW;
    for (let b = 0; b < SLOTS_PER_ROW; b++) block.stamps[base + b] = UNSET;
    block.states[at] = NO_BOUNDARY | (IN_FLIGHT << OUTCOME_SHIFT);
    this.unstamped++;
    return index;
  }

  /**
   * Appends a row born at dispatch, with `plan` and `queue` over and `wire`
   * open: what {@link append} and a {@link stamp} of each of the three
   * boundaries leave, written once. `planStartUs` is {@link UNSET_STAMP}
   * when no plan pass was measured. One submit can dispatch thousands of
   * rows, so each slot is written once and the tally moves once.
   */
  appendDispatched(
    src: ChunkRowSource,
    tier: 0 | 1,
    planStartUs: number,
    queueStartUs: number,
    wireStartUs: number,
  ): number {
    const index = this.place(src, tier);
    const block = this.tail;
    const at = index - block.first;
    const base = at * SLOTS_PER_ROW;
    const stamps = block.stamps;
    stamps[base + PLAN_START] = planStartUs;
    stamps[base + QUEUE_START] = queueStartUs;
    stamps[base + WIRE_START] = wireStartUs;
    for (let b = WIRE_START + 1; b < SLOTS_PER_ROW; b++) stamps[base + b] = UNSET;
    block.states[at] = WIRE_START | (IN_FLIGHT << OUTCOME_SHIFT);
    this.occupancy[WIRE_START]++;
    return index;
  }

  /** Claims the next row and writes everything but its boundaries and their tally. */
  private place(src: ChunkRowSource, tier: 0 | 1): number {
    if (this.rows === this.capacity) this.grow();
    const index = this.rows++;
    const block = this.tail;
    const at = index - block.first;

    const datasetId = src.datasetId;
    if (datasetId !== this.lastDatasetId) {
      this.lastDataset = this.strings.intern(datasetId);
      this.lastDatasetId = datasetId;
    }
    let entity = this.entities.get(src.entityId);
    if (entity === undefined) {
      entity = {
        entity: this.strings.intern(src.entityId),
        imageId: src.imageId,
        image: this.strings.intern(src.imageId),
      };
      this.entities.set(src.entityId, entity);
    } else if (entity.imageId !== src.imageId) {
      entity.imageId = src.imageId;
      entity.image = this.strings.intern(src.imageId);
    }
    block.datasetIds[at] = this.lastDataset;
    block.entityIds[at] = entity.entity;
    block.imageIds[at] = entity.image;
    block.lanes[at] = laneOf(src.lane) | (tier << TIER_SHIFT);
    block.rids[at] = NO_RID;
    block.connectionGenerations[at] = NO_CONNECTION;
    block.bytes[at] = 0;
    block.wireShares[at] = WIRE_SHARE_SCALE;
    block.decodeWorkShares[at] = NO_WORK_SHARE;
    block.unwantedShares[at] = NO_UNWANTED_SHARE;

    const c = at * COORDS_PER_ROW;
    const coords = block.coords;
    coords[c] = src.level;
    coords[c + 1] = src.t;
    coords[c + 2] = src.c;
    coords[c + 3] = src.z;
    coords[c + 4] = src.y;
    coords[c + 5] = src.x;

    if (this.index !== null) this.link(this.index, index);
    return index;
  }

  /** The identity index, built over every row so far on the first read that needs it. */
  private identityIndex(): Int32Array {
    if (this.index !== null) return this.index;
    const index = new Int32Array(indexSizeFor(this.capacity)).fill(NO_ROW);
    this.index = index;
    this.indexMask = index.length - 1;
    this.prevSame = new Int32Array(this.capacity);
    for (let row = 0; row < this.rows; row++) this.link(index, row);
    return index;
  }

  private link(index: Int32Array, row: number): void {
    const slot = this.slotFor(index, row);
    this.prevSame![row] = index[slot];
    index[slot] = row;
  }

  /**
   * The index slot for a row's identity: the slot holding the newest row of
   * the same chunk, or the empty slot where it would go. Linear probing; the
   * table is at most half full, so a probe ends within a few slots.
   */
  private slotFor(index: Int32Array, row: number): number {
    let slot = this.hashOf(row) & this.indexMask;
    for (;;) {
      const held = index[slot];
      if (held === NO_ROW || this.sameIdentity(held, row)) return slot;
      slot = (slot + 1) & this.indexMask;
    }
  }

  private hashOf(row: number): number {
    const block = this.blockOf(row);
    const at = row - block.first;
    const c = at * COORDS_PER_ROW;
    const coords = block.coords;
    return hashIdentity(
      block.datasetIds[at],
      block.entityIds[at],
      coords[c],
      coords[c + 1],
      coords[c + 2],
      coords[c + 3],
      coords[c + 4],
      coords[c + 5],
    );
  }

  private sameIdentity(a: number, b: number): boolean {
    const blockA = this.blockOf(a);
    const blockB = this.blockOf(b);
    const atA = a - blockA.first;
    const atB = b - blockB.first;
    if (
      blockA.datasetIds[atA] !== blockB.datasetIds[atB] ||
      blockA.entityIds[atA] !== blockB.entityIds[atB]
    ) {
      return false;
    }
    const ca = atA * COORDS_PER_ROW;
    const cb = atB * COORDS_PER_ROW;
    for (let i = 0; i < COORDS_PER_ROW; i++) {
      if (blockA.coords[ca + i] !== blockB.coords[cb + i]) return false;
    }
    return true;
  }

  /**
   * The newest row of one chunk, or -1 when the table holds none. A dataset
   * or entity the pool never interned has no row, so the answer is given
   * without hashing anything.
   */
  newestRowOf(chunk: ChunkCoordinates): number {
    const datasetIndex = this.strings.lookup(chunk.datasetId);
    const entityIndex = this.strings.lookup(chunk.entityId);
    if (datasetIndex === undefined || entityIndex === undefined) return NO_ROW;
    const index = this.identityIndex();
    const { level, t, c, z, y, x } = chunk;
    let slot = hashIdentity(datasetIndex, entityIndex, level, t, c, z, y, x) & this.indexMask;
    for (;;) {
      const held = index[slot];
      if (held === NO_ROW) return NO_ROW;
      const block = this.blockOf(held);
      const at = held - block.first;
      const cc = at * COORDS_PER_ROW;
      const coords = block.coords;
      if (
        block.datasetIds[at] === datasetIndex &&
        block.entityIds[at] === entityIndex &&
        coords[cc] === level &&
        coords[cc + 1] === t &&
        coords[cc + 2] === c &&
        coords[cc + 3] === z &&
        coords[cc + 4] === y &&
        coords[cc + 5] === x
      ) {
        return held;
      }
      slot = (slot + 1) & this.indexMask;
    }
  }

  /** Every row of the chunk whose newest row is `newest`, oldest first. */
  rowsOf(newest: number): number[] {
    const prevSame = this.chains();
    const out: number[] = [];
    for (let row = newest; row !== NO_ROW; row = prevSame[row]) out.push(row);
    return out.reverse();
  }

  private chains(): Int32Array {
    this.identityIndex();
    return this.prevSame!;
  }

  /**
   * What one chunk's rows say about it, read from the index without a walk
   * over the table: the newest row's state and age, and how many rows there
   * are and how many of them fetched. The same reading `deriveChunkStates`
   * makes from the serialised rows, for the interval still being written.
   * Null when the table holds no row for the chunk.
   */
  readChunk(chunk: ChunkCoordinates, closeUs: number): ChunkReading | null {
    const newest = this.newestRowOf(chunk);
    if (newest === NO_ROW) return null;
    const prevSame = this.chains();
    let rows = 0;
    let fetches = 0;
    for (let row = newest; row !== NO_ROW; row = prevSame[row]) {
      rows += 1;
      if (this.fetched(row)) fetches += 1;
    }
    return {
      state: this.stateAt(newest),
      rows,
      fetches,
      ageMs: nullableUsToMs(this.ageUsAt(newest, closeUs)),
    };
  }

  /** A fetch is a row whose wire closed, the rule `rowFetched` applies to a serialised row. */
  private fetched(index: number): boolean {
    const block = this.blockOf(index);
    const base = (index - block.first) * SLOTS_PER_ROW;
    return (
      block.stamps[base + WIRE_START] !== UNSET &&
      block.stamps[base + DECODE_START] !== UNSET
    );
  }

  private hasPhase(index: number, p: number): boolean {
    const block = this.blockOf(index);
    return hasPhaseAt(block.stamps, (index - block.first) * SLOTS_PER_ROW, p);
  }

  /**
   * Where the row stands, by the rule `rowState` applies to a serialised row:
   * how it ended if it ended, otherwise the phase after the last one it
   * finished, or `unstamped` when it finished none.
   */
  stateAt(index: number): RowState {
    const block = this.blockOf(index);
    const at = index - block.first;
    const outcome = block.states[at] >> OUTCOME_SHIFT;
    if (outcome === COMPLETE) return "complete";
    if (outcome === RETIRED) return "retired";
    const base = at * SLOTS_PER_ROW;
    let last = -1;
    for (let p = 0; p < PHASE_COUNT; p++) if (hasPhaseAt(block.stamps, base, p)) last = p;
    if (last < 0) return "unstamped";
    return PHASES[Math.min(last + 1, PHASE_COUNT - 1)];
  }

  /** Run-relative microseconds of the row's first stamped boundary, or null when it has none. */
  firstBoundaryUsAt(index: number): number | null {
    const block = this.blockOf(index);
    const base = (index - block.first) * SLOTS_PER_ROW;
    const stamps = block.stamps;
    let first: number | null = null;
    for (let p = 0; p < PHASE_COUNT; p++) {
      if (!hasPhaseAt(stamps, base, p)) continue;
      const startUs = stamps[base + p];
      if (first === null || startUs < first) first = startUs;
    }
    return first;
  }

  /**
   * The row's age by the rule `rowAgeUs` applies to a serialised row: first
   * boundary to last for a row that ended, first boundary to `closeUs` for
   * one still in flight, and null for a row that finished no phase.
   */
  ageUsAt(index: number, closeUs: number): number | null {
    const first = this.firstBoundaryUsAt(index);
    if (first === null) return null;
    let end = closeUs;
    const block = this.blockOf(index);
    const at = index - block.first;
    if (block.states[at] >> OUTCOME_SHIFT !== IN_FLIGHT) {
      const base = at * SLOTS_PER_ROW;
      const stamps = block.stamps;
      let last: number | null = null;
      for (let p = 0; p < PHASE_COUNT; p++) {
        if (!hasPhaseAt(stamps, base, p)) continue;
        const endUs = stamps[base + p + 1];
        if (last === null || endUs > last) last = endUs;
      }
      end = last ?? closeUs;
    }
    return Math.max(0, end - first);
  }

  /**
   * The admission columns over the table's rows, by the rule `admissionOf`
   * applies to a serialised row, answered from the stamps so ranking one row
   * against thirty thousand allocates nothing.
   */
  admissionColumns(): AdmissionColumns {
    const admittedUs = (index: number): number => {
      // A row that finished `queue`, or one still in it: admitted where its
      // plan phase ended, which is the queue's start.
      if (this.hasPhase(index, QUEUE_PHASE)) return this.stampAt(index, QUEUE_START);
      if (this.stateAt(index) === "queue" && this.hasPhase(index, PLAN_PHASE)) {
        return this.stampAt(index, QUEUE_START);
      }
      return NEVER_ADMITTED;
    };
    const dispatchedUs = (index: number): number =>
      this.hasPhase(index, QUEUE_PHASE) ? this.stampAt(index, WIRE_START) : NOT_DISPATCHED;
    return { length: this.rows, admittedUs, dispatchedUs };
  }

  /**
   * Record which wire request this row's chunk rode on. Several rows can
   * carry the same label — the transport coalesces duplicate in-flight
   * fetches onto the first sender's request — so the join to the server's
   * table is a plain equi-join and the coalescing count is a group-by.
   */
  setLabel(index: number, label: WireLabel): void {
    const block = this.blockOf(index);
    const at = index - block.first;
    block.rids[at] = label.rid;
    block.connectionGenerations[at] = label.connectionGeneration;
  }

  /**
   * Stamp a boundary. A row is in the phase after the highest boundary it
   * has stamped, so a stamp past that boundary moves the row's place in the
   * tally. A stamp at or below it is a late arrival for a slot already
   * passed: it records the time and moves nothing. A finished row keeps its
   * boundary up to date and stays out of every phase.
   */
  stamp(index: number, boundary: number, offsetUs: number): void {
    const block = this.blockOf(index);
    const at = index - block.first;
    block.stamps[at * SLOTS_PER_ROW + boundary] = offsetUs;
    const state = block.states[at];
    const previous = state & BOUNDARY_MASK;
    if (previous !== NO_BOUNDARY && boundary <= previous) return;
    block.states[at] = (state & ~BOUNDARY_MASK) | boundary;
    if (state >> OUTCOME_SHIFT !== IN_FLIGHT) return;
    this.leave(previous);
    this.enter(boundary);
  }

  /** The payload bytes the wire delivered for this row, decoded and as carried. */
  setBytes(index: number, bytes: number, wireBytes: number = bytes): void {
    const block = this.blockOf(index);
    const at = index - block.first;
    block.bytes[at] = bytes;
    const share = bytes > 0 ? Math.min(1, Math.max(0, wireBytes / bytes)) : 1;
    block.wireShares[at] = Math.round(share * WIRE_SHARE_SCALE);
  }

  /**
   * The decode worker's own time on the row's chunk, once both ends of its
   * `decode` round trip are stamped. A row missing either keeps none.
   */
  setDecodeWork(index: number, workUs: number): void {
    const block = this.blockOf(index);
    const at = index - block.first;
    const base = at * SLOTS_PER_ROW;
    const startUs = block.stamps[base + DECODE_START];
    const endUs = block.stamps[base + UPLOAD_START];
    if (startUs === UNSET || endUs === UNSET) return;
    const roundTripUs = endUs - startUs;
    const share = roundTripUs > 0 ? Math.min(1, Math.max(0, workUs / roundTripUs)) : 0;
    block.decodeWorkShares[at] = Math.round(share * WORK_SHARE_SCALE);
  }

  /**
   * When the row's chunk joined the wanted set, once both ends of its
   * `upload` are stamped. A row missing either keeps none.
   */
  setWantedAt(index: number, offsetUs: number): void {
    const block = this.blockOf(index);
    const at = index - block.first;
    const base = at * SLOTS_PER_ROW;
    const startUs = block.stamps[base + UPLOAD_START];
    const endUs = block.stamps[base + PRESENT_START];
    if (startUs === UNSET || endUs === UNSET) return;
    const uploadUs = endUs - startUs;
    const share = uploadUs > 0 ? Math.min(1, Math.max(0, (offsetUs - startUs) / uploadUs)) : 0;
    block.unwantedShares[at] = Math.round(share * UNWANTED_SHARE_SCALE);
  }

  stampAt(index: number, boundary: number): number {
    const block = this.blockOf(index);
    return block.stamps[(index - block.first) * SLOTS_PER_ROW + boundary];
  }

  setOutcome(index: number, outcome: RowOutcomeValue): void {
    const block = this.blockOf(index);
    const at = index - block.first;
    const state = block.states[at];
    const previous = state >> OUTCOME_SHIFT;
    if (previous === outcome) return;
    const boundary = state & BOUNDARY_MASK;
    block.states[at] = boundary | (outcome << OUTCOME_SHIFT);
    if (previous === IN_FLIGHT) this.leave(boundary);
    else if (previous === COMPLETE) this.complete--;
    else this.retired--;
    if (outcome === IN_FLIGHT) this.enter(boundary);
    else if (outcome === COMPLETE) this.complete++;
    else this.retired++;
  }

  outcomeAt(index: number): number {
    const block = this.blockOf(index);
    return block.states[index - block.first] >> OUTCOME_SHIFT;
  }

  /**
   * How the rows ended, and where the unfinished ones sit right now: the
   * live view's counters and phase bar, read from the counters the write
   * path keeps, so a read costs the same at ten rows and at the per-run cap.
   *
   * `occupancy` is the caller's vector, in {@link PHASES} order, overwritten
   * here. It is passed in rather than returned so a reader polling at the
   * tick cadence allocates nothing.
   */
  liveTally(occupancy: Uint32Array): LiveTally {
    occupancy.set(this.occupancy);
    return {
      complete: this.complete,
      retired: this.retired,
      inFlight: this.rows - this.complete - this.retired,
      unstamped: this.unstamped,
    };
  }

  /** Take an in-flight row out of the place its last boundary put it. */
  private leave(boundary: number): void {
    if (boundary === NO_BOUNDARY) this.unstamped--;
    // The boundary after the last phase is an end, not a phase: a row past
    // it is in flight until its outcome says otherwise, and in no phase.
    else if (boundary < PHASE_COUNT) this.occupancy[boundary]--;
  }

  /** Put an in-flight row in the place its last boundary puts it. */
  private enter(boundary: number): void {
    if (boundary === NO_BOUNDARY) this.unstamped++;
    else if (boundary < PHASE_COUNT) this.occupancy[boundary]++;
  }

  /** Fans every row out into its phases, through {@link rowAt}, the only place that knows about spans. */
  serialise(): TraceRow[] {
    const out: TraceRow[] = [];
    for (let i = 0; i < this.rows; i++) out.push(this.rowAt(i));
    return out;
  }

  /** One row, serialised on its own, for a reader that wants a handful of an open interval's rows. */
  rowAt(i: number): TraceRow {
    const block = this.blockOf(i);
    const at = i - block.first;
    const c = at * COORDS_PER_ROW;
    const level = block.coords[c];
    const t = block.coords[c + 1];
    const ch = block.coords[c + 2];
    const z = block.coords[c + 3];
    const y = block.coords[c + 4];
    const x = block.coords[c + 5];

    const base = at * SLOTS_PER_ROW;
    const phases: Partial<Record<Phase, PhaseTiming>> = {};
    for (let p = 0; p < PHASE_COUNT; p++) {
      const startUs = block.stamps[base + p];
      const endUs = block.stamps[base + p + 1];
      if (startUs === UNSET || endUs === UNSET) continue;
      phases[PHASES[p]] = { startUs, endUs, durationUs: endUs - startUs };
    }
    const share = block.decodeWorkShares[at];
    const decode = phases.decode;
    const unwanted = block.unwantedShares[at];
    const upload = phases.upload;
    const laneTier = block.lanes[at];

    return {
      rid: block.rids[at],
      connectionGeneration: block.connectionGenerations[at],
      datasetId: this.strings.get(block.datasetIds[at]),
      entityId: this.strings.get(block.entityIds[at]),
      imageId: this.strings.get(block.imageIds[at]),
      lane: LANE_NAMES[laneTier & LANE_MASK],
      residencyTier: RESIDENCY_TIERS[laneTier >> TIER_SHIFT],
      level,
      t,
      c: ch,
      z,
      y,
      x,
      chunkKey: `${level}/${t}/${ch}/${z}/${y}/${x}`,
      bytes: block.bytes[at],
      wireBytes: Math.round((block.wireShares[at] / WIRE_SHARE_SCALE) * block.bytes[at]),
      outcome: ROW_OUTCOME_NAMES[block.states[at] >> OUTCOME_SHIFT],
      phases,
      ...(share !== NO_WORK_SHARE && decode
        ? { decodeWorkUs: Math.round((share / WORK_SHARE_SCALE) * decode.durationUs) }
        : {}),
      ...(unwanted !== NO_UNWANTED_SHARE && upload
        ? { unwantedUs: Math.round((unwanted / UNWANTED_SHARE_SCALE) * upload.durationUs) }
        : {}),
    };
  }

  private grow(): void {
    this.tail = new RowBlock(this.capacity, this.capacity);
    this.blocks.push(this.tail);
    this.capacity *= 2;
    if (this.index !== null) {
      const prevSame = new Int32Array(this.capacity);
      prevSame.set(this.prevSame!);
      this.prevSame = prevSame;
      this.rebuildIndex(this.index);
    }
  }

  /**
   * Re-place the head of every chain in an index sized for the new capacity.
   * The chains are already right, and the heads are distinct identities, so
   * each takes the first empty slot from its hash without comparing columns.
   */
  private rebuildIndex(previous: Int32Array): void {
    const index = new Int32Array(indexSizeFor(this.capacity)).fill(NO_ROW);
    const mask = index.length - 1;
    for (let s = 0; s < previous.length; s++) {
      const head = previous[s];
      if (head === NO_ROW) continue;
      let slot = this.hashOf(head) & mask;
      while (index[slot] !== NO_ROW) slot = (slot + 1) & mask;
      index[slot] = head;
    }
    this.index = index;
    this.indexMask = mask;
  }
}

/** Whether phase `p` of the row whose slots start at `base` has both its boundaries. */
function hasPhaseAt(stamps: Uint32Array, base: number, p: number): boolean {
  return stamps[base + p] !== UNSET && stamps[base + p + 1] !== UNSET;
}

/** Two slots per row of capacity, at a power of two, so the table is at most half full. */
function indexSizeFor(capacity: number): number {
  let size = 2;
  while (size < capacity * 2) size *= 2;
  return size;
}

/**
 * Each column is folded in with a multiply and a shift, so rows that differ
 * in one coordinate land apart.
 */
function hashIdentity(
  datasetIndex: number,
  entityIndex: number,
  level: number,
  t: number,
  c: number,
  z: number,
  y: number,
  x: number,
): number {
  let h = 0x811c9dc5;
  h = fold(h, datasetIndex);
  h = fold(h, entityIndex);
  h = fold(h, level);
  h = fold(h, t);
  h = fold(h, c);
  h = fold(h, z);
  h = fold(h, y);
  h = fold(h, x);
  return h >>> 0;
}

function fold(h: number, value: number): number {
  h = Math.imul(h ^ value, 0x9e3779b1);
  return h ^ (h >>> 15);
}
