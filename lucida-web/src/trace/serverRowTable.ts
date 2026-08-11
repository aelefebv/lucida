/**
 * The fourth table: the server's lifecycle rows for this client's requests.
 *
 * The wire already hands these over as parallel columns, so ingest is a copy
 * into columns of the same shape — no per-row objects are created between
 * the socket and the table, which is the point of the columnar message.
 *
 * Nothing here interprets the numbers. Placing a server row against the
 * browser's own bracket is the exporter's job (`merge.ts`), because it needs
 * the browser table to do it.
 */

import {
  SERVER_ROW_FAMILIES,
  SERVER_ROW_OUTCOMES,
  type ServerRowFamily,
  type ServerRowOutcome,
} from "./types.ts";

/**
 * The wire vocabulary, which is Rust's `snake_case` rather than the
 * document's kebab-case. Mirrored rather than reused so the two can be
 * compared: the wire form is locked by the goldens, the document form is
 * what a reader sees, and the translation between them is one table here
 * instead of an assumption spread over both.
 */
export type WireRowFamily = "chunk" | "asset";
export type WireRowOutcome = "delivered" | "not_ready" | "failed";

const FAMILY_FROM_WIRE: Record<WireRowFamily, ServerRowFamily> = {
  chunk: "chunk",
  asset: "asset",
};

const OUTCOME_FROM_WIRE: Record<WireRowOutcome, ServerRowOutcome> = {
  delivered: "delivered",
  not_ready: "not-ready",
  failed: "failed",
};

/** The wire shape of one flush window, as `ServerMessage::TimingBatch` carries it. */
export interface ServerTimingBatch {
  dropped: number;
  rid: number[];
  family: WireRowFamily[];
  dispatch_offset_us: number[];
  duration_us: number[];
  outcome: WireRowOutcome[];
}

/** A row as stored: the server's numbers plus the connection it arrived on. */
export interface StoredServerRow {
  rid: number;
  connectionGeneration: number;
  family: ServerRowFamily;
  outcome: ServerRowOutcome;
  dispatchOffsetUs: number;
  durationUs: number;
}

export class ServerRowTable {
  /** 2 label + 2 duration columns as uint32, plus two enum bytes. */
  static readonly BYTES_PER_ROW = 4 * 4 + 2;

  private rids: Uint32Array;
  private connectionGenerations: Uint32Array;
  private dispatchOffsets: Uint32Array;
  private durations: Uint32Array;
  private families: Uint8Array;
  private outcomes: Uint8Array;

  private rows = 0;
  private capacity: number;
  private droppedByServer = 0;

  constructor(initialCapacity = 512) {
    this.capacity = Math.max(1, initialCapacity);
    this.rids = new Uint32Array(this.capacity);
    this.connectionGenerations = new Uint32Array(this.capacity);
    this.dispatchOffsets = new Uint32Array(this.capacity);
    this.durations = new Uint32Array(this.capacity);
    this.families = new Uint8Array(this.capacity);
    this.outcomes = new Uint8Array(this.capacity);
  }

  get length(): number {
    return this.rows;
  }

  get byteLength(): number {
    return this.capacity * ServerRowTable.BYTES_PER_ROW;
  }

  /** What the server declared it dropped before sending, summed over batches. */
  get droppedCount(): number {
    return this.droppedByServer;
  }

  /**
   * Copy one batch in. `connectionGeneration` is the browser's, not the
   * server's: the server has no idea connections are numbered, and the
   * generation is what makes a restarted `rid` counter unambiguous.
   *
   * A batch whose columns disagree in length is a protocol violation rather
   * than a partial reading; the shortest column wins so a malformed message
   * cannot produce rows made of other rows' numbers.
   */
  ingest(batch: ServerTimingBatch, connectionGeneration: number): void {
    this.droppedByServer += batch.dropped ?? 0;
    const count = Math.min(
      batch.rid.length,
      batch.family.length,
      batch.dispatch_offset_us.length,
      batch.duration_us.length,
      batch.outcome.length,
    );
    for (let i = 0; i < count; i++) {
      if (this.rows === this.capacity) this.grow();
      const index = this.rows++;
      this.rids[index] = batch.rid[i];
      this.connectionGenerations[index] = connectionGeneration;
      this.dispatchOffsets[index] = batch.dispatch_offset_us[i];
      this.durations[index] = batch.duration_us[i];
      // An unrecognised vocabulary word means the two sides have drifted,
      // which the goldens exist to prevent. It resolves to `failed` rather
      // than `delivered`: a word we cannot read must not be able to hide a
      // request that never landed.
      this.families[index] = SERVER_ROW_FAMILIES.indexOf(
        FAMILY_FROM_WIRE[batch.family[i]] ?? "chunk",
      );
      this.outcomes[index] = SERVER_ROW_OUTCOMES.indexOf(
        OUTCOME_FROM_WIRE[batch.outcome[i]] ?? "failed",
      );
    }
  }

  serialise(): StoredServerRow[] {
    const out: StoredServerRow[] = [];
    for (let i = 0; i < this.rows; i++) {
      out.push({
        rid: this.rids[i],
        connectionGeneration: this.connectionGenerations[i],
        family: SERVER_ROW_FAMILIES[this.families[i]],
        outcome: SERVER_ROW_OUTCOMES[this.outcomes[i]],
        dispatchOffsetUs: this.dispatchOffsets[i],
        durationUs: this.durations[i],
      });
    }
    return out;
  }

  private grow(): void {
    const next = this.capacity * 2;
    this.rids = copyInto(this.rids, new Uint32Array(next));
    this.connectionGenerations = copyInto(this.connectionGenerations, new Uint32Array(next));
    this.dispatchOffsets = copyInto(this.dispatchOffsets, new Uint32Array(next));
    this.durations = copyInto(this.durations, new Uint32Array(next));
    this.families = copyInto(this.families, new Uint8Array(next));
    this.outcomes = copyInto(this.outcomes, new Uint8Array(next));
    this.capacity = next;
  }
}

function copyInto<T extends Uint8Array | Uint32Array>(src: T, next: T): T {
  next.set(src as never);
  return next;
}
