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
  PHASE_UNSET,
  SERVER_PHASES,
  SERVER_PHASE_WIRE_KEYS,
  SERVER_ROW_FAMILIES,
  SERVER_ROW_OUTCOMES,
  type ServerPhaseDurations,
  type ServerRowFamily,
  type ServerRowOutcome,
} from "./types.ts";

/**
 * The one word where the wire and the document disagree: Rust spells it
 * `not_ready`, the document spells every multi-word name kebab-case. The
 * families need no translation, so they have none.
 */
export type WireRowOutcome = "delivered" | "not_ready" | "failed";

const OUTCOME_FROM_WIRE: Record<WireRowOutcome, ServerRowOutcome> = {
  delivered: "delivered",
  not_ready: "not-ready",
  failed: "failed",
};

/**
 * The wire shape of one flush window, as `ServerMessage::TimingBatch` carries
 * it: one column per server phase (see `SERVER_PHASES`), in microseconds,
 * {@link PHASE_UNSET} where the row never entered that phase.
 */
export interface ServerTimingBatch {
  dropped: number;
  rid: number[];
  family: ServerRowFamily[];
  outcome: WireRowOutcome[];
  arrival_us: number[];
  binding_lookup_us: number[];
  dispatch_us: number[];
  cache_lookup_us: number[];
  permit_wait_us: number[];
  backend_read_us: number[];
  coalesced_wait_us: number[];
  decompress_us: number[];
  slice_encode_us: number[];
  handoff_us: number[];
}

/**
 * A row as stored: the server's numbers plus the connection it arrived on.
 * Phases the request never entered are absent from `phases` rather than
 * zero — an unentered stage and an instant one are different facts.
 */
export interface StoredServerRow {
  rid: number;
  connectionGeneration: number;
  family: ServerRowFamily;
  outcome: ServerRowOutcome;
  phases: ServerPhaseDurations;
}

export class ServerRowTable {
  /** 2 label columns + one column per phase as uint32, plus two enum bytes. */
  static readonly BYTES_PER_ROW = (2 + SERVER_PHASES.length) * 4 + 2;

  private rids: Uint32Array;
  private connectionGenerations: Uint32Array;
  /** One column per phase, in {@link SERVER_PHASES} order. */
  private phaseColumns: Uint32Array[];
  private families: Uint8Array;
  private outcomes: Uint8Array;

  private rows = 0;
  private capacity: number;
  private droppedByServer = 0;

  constructor(initialCapacity = 512) {
    this.capacity = Math.max(1, initialCapacity);
    this.rids = new Uint32Array(this.capacity);
    this.connectionGenerations = new Uint32Array(this.capacity);
    this.phaseColumns = SERVER_PHASES.map(() => new Uint32Array(this.capacity));
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
    let count = Math.min(batch.rid.length, batch.family.length, batch.outcome.length);
    for (const key of SERVER_PHASE_WIRE_KEYS) {
      count = Math.min(count, batch[key]?.length ?? 0);
    }
    for (let i = 0; i < count; i++) {
      if (this.rows === this.capacity) this.grow();
      const index = this.rows++;
      this.rids[index] = batch.rid[i];
      this.connectionGenerations[index] = connectionGeneration;
      for (let p = 0; p < SERVER_PHASES.length; p++) {
        this.phaseColumns[p][index] = batch[SERVER_PHASE_WIRE_KEYS[p]][i];
      }
      // An unrecognised vocabulary word means the two sides have drifted,
      // which the goldens exist to prevent. An unreadable outcome resolves
      // to `failed`: a word we cannot read must not be able to hide a
      // request that never landed.
      this.families[index] = Math.max(0, SERVER_ROW_FAMILIES.indexOf(batch.family[i]));
      this.outcomes[index] = SERVER_ROW_OUTCOMES.indexOf(
        OUTCOME_FROM_WIRE[batch.outcome[i]] ?? "failed",
      );
    }
  }

  serialise(): StoredServerRow[] {
    const out: StoredServerRow[] = [];
    for (let i = 0; i < this.rows; i++) {
      const phases: ServerPhaseDurations = {};
      for (let p = 0; p < SERVER_PHASES.length; p++) {
        const value = this.phaseColumns[p][i];
        if (value !== PHASE_UNSET) phases[SERVER_PHASES[p]] = value;
      }
      out.push({
        rid: this.rids[i],
        connectionGeneration: this.connectionGenerations[i],
        family: SERVER_ROW_FAMILIES[this.families[i]],
        outcome: SERVER_ROW_OUTCOMES[this.outcomes[i]],
        phases,
      });
    }
    return out;
  }

  private grow(): void {
    const next = this.capacity * 2;
    this.rids = copyInto(this.rids, new Uint32Array(next));
    this.connectionGenerations = copyInto(this.connectionGenerations, new Uint32Array(next));
    this.phaseColumns = this.phaseColumns.map(column => copyInto(column, new Uint32Array(next)));
    this.families = copyInto(this.families, new Uint8Array(next));
    this.outcomes = copyInto(this.outcomes, new Uint8Array(next));
    this.capacity = next;
  }
}

/** The server's total time on a request: the phases it actually entered. */
export function serverRowTotalUs(phases: ServerPhaseDurations): number {
  let total = 0;
  for (const phase of SERVER_PHASES) {
    total += phases[phase] ?? 0;
  }
  return total;
}

function copyInto<T extends Uint8Array | Uint32Array>(src: T, next: T): T {
  next.set(src as never);
  return next;
}
