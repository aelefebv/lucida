/**
 * The per-chunk lifecycle table: fixed-width rows in parallel typed arrays.
 *
 * A row, not a list of spans (ADR 0047). Six phase objects per chunk cost
 * ~1.1 kB; seven uint32 boundary slots cost 28 B, which is what makes
 * unconditional recording affordable. Spans exist only at {@link serialise}.
 *
 * Buffers are preallocated and grow only by doubling (ADR 0049). This is not
 * tidiness: an allocating recorder produces GC pauses that appear as stalls
 * in its own trace.
 */

import { RESIDENCY_TIERS } from "../pipeline/residencyTier.ts";
import { StringPool } from "./stringPool.ts";
import {
  BOUNDARY_COUNT,
  LANE_NAMES,
  laneIndex,
  ROW_OUTCOME_NAMES,
  RowOutcome,
  UNSET_STAMP,
  PHASES,
  UNLABELLED,
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
 * The last-boundary column's value for a row that has stamped nothing. Not a
 * boundary index, and above every real one, so the column can hold either.
 */
const NO_BOUNDARY = 0xff;

/**
 * The rows of a run in progress, tallied by how they ended (#937).
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
   * Structurally zero for anything the recorder made — since #949 a chunk row
   * is born at dispatch with `queue` stamped (`TraceRecorder.beginChunkRow`).
   * It is the walk's residual rather than a state the pipeline produces: this
   * table's own `append` makes an unstamped row, so the count is what stops
   * one going missing between `inFlight` and the phase vector.
   */
  unstamped: number;
}

export class RowTable {
  /**
   * 3 interned ids + 6 coordinates + 7 boundary slots + the two-part wire
   * label + the bytes the wire delivered, all uint32, plus four bytes: tier,
   * lane, outcome, last boundary.
   */
  static readonly BYTES_PER_ROW = (3 + COORDS_PER_ROW + BOUNDARY_COUNT + 2 + 1) * 4 + 4;

  private readonly strings = new StringPool();

  private datasetIds: Uint32Array;
  private entityIds: Uint32Array;
  private imageIds: Uint32Array;
  private coords: Uint32Array;
  private stamps: Uint32Array;
  private rids: Uint32Array;
  private connectionGenerations: Uint32Array;
  private bytes: Uint32Array;
  private tiers: Uint8Array;
  private lanes: Uint8Array;
  private outcomes: Uint8Array;
  /**
   * The highest boundary each row has stamped, or {@link NO_BOUNDARY}. A row
   * sits in the phase after its last boundary, so this one byte is what lets
   * a stamp move the row between the counters below without re-reading its
   * slots.
   */
  private lastBoundary: Uint8Array;

  /**
   * The live tally, kept as the rows are written (#937, #1057).
   *
   * It was a walk over the rows on every poll, on the argument that the
   * write path is the pipeline's hottest and nobody is watching most of the
   * time. That held while the only reader was a person polling twice a
   * second. The provisional reading, the watch stream, and the HUD read an
   * open run at the tick cadence, under the cost contract of ADR 0049 as
   * amended, which forbids them a row walk. So the tally moved to the
   * writer: a handful of typed-array increments per boundary, paid once,
   * instead of a walk over tens of thousands of rows paid per reader per
   * poll. The write path's cost is gated in `recorderCost.perf.test.ts`, and
   * a read is now a copy of six integers.
   */
  private readonly occupancy = new Uint32Array(PHASES.length);
  private complete = 0;
  private retired = 0;
  private unstamped = 0;

  private rows = 0;
  private capacity: number;

  constructor(initialCapacity = 1024) {
    this.capacity = Math.max(1, initialCapacity);
    this.datasetIds = new Uint32Array(this.capacity);
    this.entityIds = new Uint32Array(this.capacity);
    this.imageIds = new Uint32Array(this.capacity);
    this.coords = new Uint32Array(this.capacity * COORDS_PER_ROW);
    this.stamps = new Uint32Array(this.capacity * BOUNDARY_COUNT);
    this.rids = new Uint32Array(this.capacity);
    this.connectionGenerations = new Uint32Array(this.capacity);
    this.bytes = new Uint32Array(this.capacity);
    this.tiers = new Uint8Array(this.capacity);
    this.lanes = new Uint8Array(this.capacity);
    this.outcomes = new Uint8Array(this.capacity);
    this.lastBoundary = new Uint8Array(this.capacity);
  }

  get length(): number {
    return this.rows;
  }

  get capacityRows(): number {
    return this.capacity;
  }

  /** Bytes allocated, not bytes used — the cap in ADR 0049 is on resident memory. */
  get byteLength(): number {
    return this.capacity * RowTable.BYTES_PER_ROW;
  }

  get internedStringCount(): number {
    return this.strings.size;
  }

  /** Appends an in-flight row with every boundary unset. Returns its index. */
  append(src: ChunkRowSource, tier: 0 | 1): number {
    if (this.rows === this.capacity) this.grow();
    const index = this.rows++;

    this.datasetIds[index] = this.strings.intern(src.datasetId);
    this.entityIds[index] = this.strings.intern(src.entityId);
    this.imageIds[index] = this.strings.intern(src.imageId);
    this.tiers[index] = tier;
    this.lanes[index] = laneIndex(src.lane);
    this.outcomes[index] = RowOutcome.InFlight;
    this.lastBoundary[index] = NO_BOUNDARY;
    this.unstamped++;
    this.rids[index] = UNLABELLED.rid;
    this.connectionGenerations[index] = UNLABELLED.connectionGeneration;
    this.bytes[index] = 0;

    const c = index * COORDS_PER_ROW;
    this.coords[c] = src.level;
    this.coords[c + 1] = src.t;
    this.coords[c + 2] = src.c;
    this.coords[c + 3] = src.z;
    this.coords[c + 4] = src.y;
    this.coords[c + 5] = src.x;

    this.stamps.fill(UNSET_STAMP, index * BOUNDARY_COUNT, (index + 1) * BOUNDARY_COUNT);
    return index;
  }

  /**
   * Record which wire request this row's chunk rode on. Several rows can
   * carry the same label — the transport coalesces duplicate in-flight
   * fetches onto the first sender's request — so the join to the server's
   * table is a plain equi-join and the coalescing count is a group-by.
   */
  setLabel(index: number, label: WireLabel): void {
    this.rids[index] = label.rid;
    this.connectionGenerations[index] = label.connectionGeneration;
  }

  /**
   * Stamp a boundary. A row is in the phase after the highest boundary it
   * has stamped, so a stamp past that boundary moves the row's place in the
   * tally. A stamp at or below it is a late arrival for a slot already
   * passed: it records the time and moves nothing. A finished row keeps its
   * boundary up to date and stays out of every phase.
   */
  stamp(index: number, boundary: number, offsetUs: number): void {
    this.stamps[index * BOUNDARY_COUNT + boundary] = offsetUs;
    const previous = this.lastBoundary[index];
    if (previous !== NO_BOUNDARY && boundary <= previous) return;
    this.lastBoundary[index] = boundary;
    if (this.outcomes[index] !== RowOutcome.InFlight) return;
    this.leave(previous);
    this.enter(boundary);
  }

  /** The payload bytes the wire delivered for this row. */
  setBytes(index: number, bytes: number): void {
    this.bytes[index] = bytes;
  }

  stampAt(index: number, boundary: number): number {
    return this.stamps[index * BOUNDARY_COUNT + boundary];
  }

  setOutcome(index: number, outcome: RowOutcomeValue): void {
    const previous = this.outcomes[index];
    if (previous === outcome) return;
    this.outcomes[index] = outcome;
    if (previous === RowOutcome.InFlight) this.leave(this.lastBoundary[index]);
    else if (previous === RowOutcome.Complete) this.complete--;
    else this.retired--;
    if (outcome === RowOutcome.InFlight) this.enter(this.lastBoundary[index]);
    else if (outcome === RowOutcome.Complete) this.complete++;
    else this.retired++;
  }

  outcomeAt(index: number): number {
    return this.outcomes[index];
  }

  /**
   * How the rows ended, and where the unfinished ones are sitting right now
   * (#937): the live view's counters and phase bar, read from the counters
   * the write path keeps rather than by walking the rows. A read costs the
   * same at ten rows and at the per-run cap, which is what lets the surfaces
   * that read an open run do so at the tick cadence.
   *
   * `occupancy` is the caller's vector, in {@link PHASES} order, overwritten
   * here: a poll reads this instant, not a sum of every poll before it. It is
   * passed in rather than returned so a reader polling at the tick cadence
   * allocates nothing.
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
    else if (boundary < PHASES.length) this.occupancy[boundary]--;
  }

  /** Put an in-flight row in the place its last boundary puts it. */
  private enter(boundary: number): void {
    if (boundary === NO_BOUNDARY) this.unstamped++;
    else if (boundary < PHASES.length) this.occupancy[boundary]++;
  }

  /** Fans each row out into its phases. The only place that knows about spans. */
  serialise(): TraceRow[] {
    const out: TraceRow[] = [];
    for (let i = 0; i < this.rows; i++) {
      const c = i * COORDS_PER_ROW;
      const level = this.coords[c];
      const t = this.coords[c + 1];
      const ch = this.coords[c + 2];
      const z = this.coords[c + 3];
      const y = this.coords[c + 4];
      const x = this.coords[c + 5];

      const phases: Partial<Record<Phase, PhaseTiming>> = {};
      for (let p = 0; p < PHASES.length; p++) {
        const startUs = this.stamps[i * BOUNDARY_COUNT + p];
        const endUs = this.stamps[i * BOUNDARY_COUNT + p + 1];
        if (startUs === UNSET_STAMP || endUs === UNSET_STAMP) continue;
        phases[PHASES[p]] = { startUs, endUs, durationUs: endUs - startUs };
      }

      out.push({
        rid: this.rids[i],
        connectionGeneration: this.connectionGenerations[i],
        datasetId: this.strings.get(this.datasetIds[i]),
        entityId: this.strings.get(this.entityIds[i]),
        imageId: this.strings.get(this.imageIds[i]),
        lane: LANE_NAMES[this.lanes[i]],
        residencyTier: RESIDENCY_TIERS[this.tiers[i]],
        level,
        t,
        c: ch,
        z,
        y,
        x,
        chunkKey: `${level}/${t}/${ch}/${z}/${y}/${x}`,
        bytes: this.bytes[i],
        outcome: ROW_OUTCOME_NAMES[this.outcomes[i]],
        phases,
      });
    }
    return out;
  }

  private grow(): void {
    const next = this.capacity * 2;
    this.datasetIds = copyInto(this.datasetIds, new Uint32Array(next));
    this.entityIds = copyInto(this.entityIds, new Uint32Array(next));
    this.imageIds = copyInto(this.imageIds, new Uint32Array(next));
    this.coords = copyInto(this.coords, new Uint32Array(next * COORDS_PER_ROW));
    this.stamps = copyInto(this.stamps, new Uint32Array(next * BOUNDARY_COUNT));
    this.rids = copyInto(this.rids, new Uint32Array(next));
    this.connectionGenerations = copyInto(this.connectionGenerations, new Uint32Array(next));
    this.bytes = copyInto(this.bytes, new Uint32Array(next));
    this.tiers = copyInto(this.tiers, new Uint8Array(next));
    this.lanes = copyInto(this.lanes, new Uint8Array(next));
    this.outcomes = copyInto(this.outcomes, new Uint8Array(next));
    this.lastBoundary = copyInto(this.lastBoundary, new Uint8Array(next));
    this.capacity = next;
  }
}

function copyInto<T extends Uint8Array | Uint32Array>(src: T, next: T): T {
  next.set(src as never);
  return next;
}
