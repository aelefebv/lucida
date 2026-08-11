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

import { StringPool } from "./stringPool.ts";
import {
  BOUNDARY_COUNT,
  LANE_NAMES,
  laneIndex,
  RESIDENCY_TIER_NAMES,
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
  /** Of the in-flight rows, how many have reached no boundary at all. */
  unstamped: number;
}

export class RowTable {
  /**
   * 3 interned ids + 6 coordinates + 7 boundary slots + the two-part wire
   * label, all uint32, plus three bytes.
   */
  static readonly BYTES_PER_ROW = (3 + COORDS_PER_ROW + BOUNDARY_COUNT + 2) * 4 + 3;

  private readonly strings = new StringPool();

  private datasetIds: Uint32Array;
  private entityIds: Uint32Array;
  private imageIds: Uint32Array;
  private coords: Uint32Array;
  private stamps: Uint32Array;
  private rids: Uint32Array;
  private connectionGenerations: Uint32Array;
  private tiers: Uint8Array;
  private lanes: Uint8Array;
  private outcomes: Uint8Array;

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
    this.tiers = new Uint8Array(this.capacity);
    this.lanes = new Uint8Array(this.capacity);
    this.outcomes = new Uint8Array(this.capacity);
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
    this.rids[index] = UNLABELLED.rid;
    this.connectionGenerations[index] = UNLABELLED.connectionGeneration;

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

  stamp(index: number, boundary: number, offsetUs: number): void {
    this.stamps[index * BOUNDARY_COUNT + boundary] = offsetUs;
  }

  stampAt(index: number, boundary: number): number {
    return this.stamps[index * BOUNDARY_COUNT + boundary];
  }

  setOutcome(index: number, outcome: RowOutcomeValue): void {
    this.outcomes[index] = outcome;
  }

  outcomeAt(index: number): number {
    return this.outcomes[index];
  }

  /**
   * One pass over the rows: how they ended, and where the unfinished ones are
   * sitting right now (#937).
   *
   * The live view's counters and phase bar, and the only read on this table
   * that happens while a run is still open. It is a walk rather than counters
   * kept on the write path deliberately: the write path is the pipeline's
   * hottest, and nobody is watching most of the time. The cost lands on the
   * reader, once per poll, and is bounded by the per-run cap.
   *
   * `occupancy` is the caller's vector, in {@link PHASES} order, zeroed here:
   * a poll reads this instant, not a sum of every poll before it. It is
   * passed in rather than returned so a page polling twice a second allocates
   * nothing.
   */
  liveTally(occupancy: Uint32Array): LiveTally {
    occupancy.fill(0);
    let complete = 0;
    let retired = 0;
    let unstamped = 0;
    for (let i = 0; i < this.rows; i++) {
      const outcome = this.outcomes[i];
      if (outcome === RowOutcome.Complete) {
        complete++;
        continue;
      }
      if (outcome === RowOutcome.Retired) {
        retired++;
        continue;
      }
      // A row is in the phase after the last boundary it stamped. Scanning
      // backwards finds it in one step for a row on the wire, which is where
      // most rows are while a run is open.
      let boundary = BOUNDARY_COUNT - 1;
      while (boundary >= 0 && this.stamps[i * BOUNDARY_COUNT + boundary] === UNSET_STAMP) {
        boundary--;
      }
      // Nothing stamped yet: the planner has asked for this chunk and no
      // boundary has been reached. Not `plan` — that would invent time in a
      // phase the row has not entered.
      if (boundary < 0) unstamped++;
      else if (boundary < PHASES.length) occupancy[boundary]++;
    }
    return { complete, retired, inFlight: this.rows - complete - retired, unstamped };
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
        residencyTier: RESIDENCY_TIER_NAMES[this.tiers[i]],
        level,
        t,
        c: ch,
        z,
        y,
        x,
        chunkKey: `${level}/${t}/${ch}/${z}/${y}/${x}`,
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
    this.tiers = copyInto(this.tiers, new Uint8Array(next));
    this.lanes = copyInto(this.lanes, new Uint8Array(next));
    this.outcomes = copyInto(this.outcomes, new Uint8Array(next));
    this.capacity = next;
  }
}

function copyInto<T extends Uint8Array | Uint32Array>(src: T, next: T): T {
  next.set(src as never);
  return next;
}
