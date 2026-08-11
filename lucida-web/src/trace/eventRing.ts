/**
 * Tier three: point events, on a drop-oldest ring.
 *
 * Eviction, rejection, retry and failure are the least-understood part of the
 * pipeline precisely because nobody has caught them happening — #899 observed
 * zero retries and zero real failures across 3,781 remote reads, so those
 * paths have never executed under measurement. That is the argument against
 * designing a rich surface for them: they get one shape, and their diagnostic
 * value is that they appear at all.
 *
 * Like the tick ring and unlike the per-chunk tier, this drops oldest. It is
 * a steady-state stream with no privileged start, and it reports what it
 * dropped so a wrapped ring is visible rather than inferred.
 */

import { RingSlots } from "./ring.ts";
import { StringPool } from "./stringPool.ts";
import {
  POINT_EVENT_KINDS,
  POINT_EVENT_REASONS,
  RESIDENCY_TIER_NAMES,
  type ChunkEventSource,
  type PointEventIndex,
  type PointEventReason,
  type TracePointEvent,
} from "./types.ts";

/** Six coordinate columns per event: level, t, c, z, y, x. */
const COORDS_PER_EVENT = 6;

/**
 * How many point events a run keeps. Generous against the observed rate of
 * approximately none, and small enough that the ring is a rounding error
 * against the per-chunk tier.
 */
export const DEFAULT_EVENT_CAPACITY = 1024;

const REASON_CODES = new Map<PointEventReason, number>(
  POINT_EVENT_REASONS.map((reason, index) => [reason, index]),
);

export class EventRing {
  /** 3 interned ids + 6 coordinates + timestamp, all uint32, plus three bytes. */
  static readonly BYTES_PER_EVENT = (3 + COORDS_PER_EVENT + 1) * 4 + 3;

  private readonly strings = new StringPool();
  private readonly slots: RingSlots;
  private readonly capacity: number;
  private readonly atUs: Uint32Array;
  private readonly datasetIds: Uint32Array;
  private readonly entityIds: Uint32Array;
  private readonly imageIds: Uint32Array;
  private readonly coords: Uint32Array;
  private readonly kinds: Uint8Array;
  private readonly reasons: Uint8Array;
  private readonly tiers: Uint8Array;
  /** Zero when the event is not about one chunk. */
  private readonly hasChunk: Uint8Array;

  constructor(capacity = DEFAULT_EVENT_CAPACITY) {
    this.slots = new RingSlots(capacity);
    this.capacity = this.slots.capacity;
    this.atUs = new Uint32Array(this.capacity);
    this.datasetIds = new Uint32Array(this.capacity);
    this.entityIds = new Uint32Array(this.capacity);
    this.imageIds = new Uint32Array(this.capacity);
    this.coords = new Uint32Array(this.capacity * COORDS_PER_EVENT);
    this.kinds = new Uint8Array(this.capacity);
    this.reasons = new Uint8Array(this.capacity);
    this.tiers = new Uint8Array(this.capacity);
    this.hasChunk = new Uint8Array(this.capacity);
  }

  get dropped(): number {
    return this.slots.dropped;
  }

  get length(): number {
    return this.slots.length;
  }

  get byteLength(): number {
    return this.capacity * EventRing.BYTES_PER_EVENT;
  }

  append(
    atUs: number,
    kind: PointEventIndex,
    reason: PointEventReason,
    chunk: ChunkEventSource | null,
    tier: 0 | 1,
  ): void {
    const slot = this.slots.claim();

    this.atUs[slot] = atUs;
    this.kinds[slot] = kind;
    this.reasons[slot] = REASON_CODES.get(reason) ?? 0;
    this.tiers[slot] = tier;
    this.hasChunk[slot] = chunk === null ? 0 : 1;

    const c = slot * COORDS_PER_EVENT;
    if (chunk === null) {
      this.datasetIds[slot] = 0;
      this.entityIds[slot] = 0;
      this.imageIds[slot] = 0;
      this.coords.fill(0, c, c + COORDS_PER_EVENT);
      return;
    }

    this.datasetIds[slot] = this.strings.intern(chunk.datasetId ?? "");
    this.entityIds[slot] = this.strings.intern(chunk.entityId);
    this.imageIds[slot] = this.strings.intern(chunk.imageId);
    this.coords[c] = chunk.level;
    this.coords[c + 1] = chunk.t;
    this.coords[c + 2] = chunk.c;
    this.coords[c + 3] = chunk.z;
    this.coords[c + 4] = chunk.y;
    this.coords[c + 5] = chunk.x;
  }

  /** Oldest-first, matching the tick ring. */
  serialise(): TracePointEvent[] {
    const out: TracePointEvent[] = [];
    for (const slot of this.slots.ordered()) {
      const c = slot * COORDS_PER_EVENT;
      const level = this.coords[c];
      const t = this.coords[c + 1];
      const ch = this.coords[c + 2];
      const z = this.coords[c + 3];
      const y = this.coords[c + 4];
      const x = this.coords[c + 5];

      out.push({
        atUs: this.atUs[slot],
        kind: POINT_EVENT_KINDS[this.kinds[slot]],
        reason: POINT_EVENT_REASONS[this.reasons[slot]],
        chunk: this.hasChunk[slot] === 0
          ? null
          : {
              datasetId: this.strings.get(this.datasetIds[slot]),
              entityId: this.strings.get(this.entityIds[slot]),
              imageId: this.strings.get(this.imageIds[slot]),
              residencyTier: RESIDENCY_TIER_NAMES[this.tiers[slot]],
              level,
              t,
              c: ch,
              z,
              y,
              x,
              chunkKey: `${level}/${t}/${ch}/${z}/${y}/${x}`,
            },
      });
    }
    return out;
  }
}
