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

import { StringPool } from "./stringPool.ts";
import {
  LABEL_NONE,
  METADATA_READ_PHASES,
  PHASE_UNSET,
  SERVER_PHASES,
  SERVER_PHASE_WIRE_KEY,
  SERVER_ROW_FAMILIES,
  SERVER_ROW_OUTCOMES,
  type MetadataReadPhase,
  type ServerPhaseDurations,
  type ServerRowFamily,
  type ServerRowOutcome,
} from "./types.ts";

/** The wire columns the phases arrive in, in {@link SERVER_PHASES} order. */
const PHASE_COLUMNS = SERVER_PHASES.map(
  phase => SERVER_PHASE_WIRE_KEY[phase] as keyof ServerTimingBatch & string,
);

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

/** The same disagreement, one column over. */
export type WireRowFamily = "chunk" | "asset" | "metadata_read";

const FAMILY_FROM_WIRE: Record<WireRowFamily, ServerRowFamily> = {
  chunk: "chunk",
  asset: "asset",
  metadata_read: "metadata-read",
};

export type WireMetadataPhase = "cache_hit" | "coalesced_wait" | "backend_read";

const PHASE_FROM_WIRE: Record<WireMetadataPhase, MetadataReadPhase> = {
  cache_hit: "cache-hit",
  coalesced_wait: "coalesced-wait",
  backend_read: "backend-read",
};

/** Stored in the phase column when a row is not a metadata read. */
const NO_PHASE = 0xff;

/**
 * Stored in the bytes column when a row performed no backend read. The top
 * of the range, as {@link PHASE_UNSET} is for a duration, because zero is a
 * real answer: a failed round trip returned nothing. The server clamps a
 * read's byte count to one below this (`BACKEND_BYTES_MAX`).
 */
const BYTES_UNSET = 0xffff_ffff;

/** The wire shape of one flush window, as `ServerMessage::TimingBatch` carries it. */
export interface ServerTimingBatch {
  dropped: number;
  rid: number[];
  /** The open a metadata-read row belongs to; null on every other family. */
  request_id: (string | null)[];
  family: WireRowFamily[];
  metadata_phase: (WireMetadataPhase | null)[];
  /**
   * A metadata read's position inside its open and how long it took. Its own
   * pair of columns because the phase enum has no slot a metadata read can
   * fill; zero on every other family.
   */
  dispatch_offset_us: number[];
  duration_us: number[];
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
  /**
   * The bytes the row's own backend round trips returned; null on a row
   * that performed none. Set exactly when `backend_read_us` is, so a sum
   * over the column is the bytes the backend moved for this client.
   */
  backend_bytes: (number | null)[];
  /**
   * For a single-flight follower, the label of the read it waited on;
   * {@link LABEL_NONE} otherwise.
   */
  coalesced_onto: number[];
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
  /** The read this one waited on, for a follower; null otherwise. */
  coalescedOnto: number | null;
  /**
   * The bytes this row's own backend round trips returned; null when it
   * performed none. Absent rather than zero for the same reason a phase
   * is: a read that returned nothing and no read are different facts.
   */
  backendBytes: number | null;
  dispatchOffsetUs: number;
  durationUs: number;
  /** The dataset open a metadata-read row keys on; null on every other family. */
  requestId: string | null;
  metadataPhase: MetadataReadPhase | null;
}

/**
 * Whether one incoming row is worth storing. Called with the wire's own
 * values rather than a row object, because a batch is a burst and building an
 * object per row to ask a question about it would allocate on the socket's
 * path.
 */
export type AcceptServerRow = (
  rid: number,
  requestId: string | null,
  family: WireRowFamily,
) => boolean;

export class ServerRowTable {
  /**
   * 3 label columns + one column per phase as uint32, plus the bytes
   * column, the two metadata columns and the interned open id, and three
   * enum bytes. Request ids are interned rather than stored per row: an
   * open has one and files hundreds of reads under it, so the column is an
   * index and the pool stops growing after the first read of each open.
   */
  static readonly BYTES_PER_ROW = (3 + SERVER_PHASES.length + 4) * 4 + 3;

  private rids: Uint32Array;
  private connectionGenerations: Uint32Array;
  private coalescedOnto: Uint32Array;
  /** One column per phase, in {@link SERVER_PHASES} order. */
  private phaseColumns: Uint32Array[];
  private backendBytes: Uint32Array;
  private families: Uint8Array;
  private outcomes: Uint8Array;
  private metadataPhases: Uint8Array;
  private requestIds: Uint32Array;
  /** Metadata-read placement and span; zero on every other family. */
  private dispatchOffsets: Uint32Array;
  private durations: Uint32Array;
  private readonly openIds = new StringPool();

  private rows = 0;
  private capacity: number;
  private droppedByServer = 0;

  constructor(initialCapacity = 512) {
    this.capacity = Math.max(1, initialCapacity);
    this.rids = new Uint32Array(this.capacity);
    this.connectionGenerations = new Uint32Array(this.capacity);
    this.coalescedOnto = new Uint32Array(this.capacity);
    this.phaseColumns = SERVER_PHASES.map(() => new Uint32Array(this.capacity));
    this.backendBytes = new Uint32Array(this.capacity).fill(BYTES_UNSET);
    this.families = new Uint8Array(this.capacity);
    this.outcomes = new Uint8Array(this.capacity);
    this.metadataPhases = new Uint8Array(this.capacity).fill(NO_PHASE);
    this.requestIds = new Uint32Array(this.capacity);
    this.dispatchOffsets = new Uint32Array(this.capacity);
    this.durations = new Uint32Array(this.capacity);
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
   * Copy one batch in, skipping the rows `accept` refuses. Returns how many
   * it refused.
   *
   * `connectionGeneration` is the browser's, not the server's: the server has
   * no idea connections are numbered, and the generation is what makes a
   * restarted `rid` counter unambiguous.
   *
   * A batch whose columns disagree in length is a protocol violation rather
   * than a partial reading; the shortest column wins so a malformed message
   * cannot produce rows made of other rows' numbers.
   *
   * The caller owns the accept decision because only the recorder knows which
   * labels and which opens the interval holds. This side only knows not to
   * store what it is told nothing can place.
   */
  ingest(
    batch: ServerTimingBatch,
    connectionGeneration: number,
    accept: AcceptServerRow,
  ): number {
    this.droppedByServer += batch.dropped ?? 0;
    let count = Math.min(
      batch.rid.length,
      batch.request_id.length,
      batch.family.length,
      batch.metadata_phase.length,
      batch.dispatch_offset_us.length,
      batch.duration_us.length,
      batch.outcome.length,
      batch.backend_bytes.length,
      batch.coalesced_onto?.length ?? 0,
    );
    for (const key of PHASE_COLUMNS) {
      count = Math.min(count, (batch[key] as number[] | undefined)?.length ?? 0);
    }
    let refused = 0;
    for (let i = 0; i < count; i++) {
      const requestId = batch.request_id[i] ?? null;
      if (!accept(batch.rid[i], requestId, batch.family[i])) {
        refused++;
        continue;
      }
      if (this.rows === this.capacity) this.grow();
      const index = this.rows++;
      this.rids[index] = batch.rid[i];
      this.connectionGenerations[index] = connectionGeneration;
      this.coalescedOnto[index] = batch.coalesced_onto[i];
      this.dispatchOffsets[index] = batch.dispatch_offset_us[i];
      this.durations[index] = batch.duration_us[i];
      for (let p = 0; p < SERVER_PHASES.length; p++) {
        this.phaseColumns[p][index] = (batch[PHASE_COLUMNS[p]] as number[])[i];
      }
      const bytes = batch.backend_bytes[i];
      this.backendBytes[index] = bytes === null ? BYTES_UNSET : bytes;
      // An unrecognised vocabulary word means the two sides have drifted,
      // which the goldens exist to prevent. An unreadable outcome resolves
      // to `failed`: a word we cannot read must not be able to hide a
      // request that never landed.
      this.families[index] = Math.max(
        0,
        SERVER_ROW_FAMILIES.indexOf(FAMILY_FROM_WIRE[batch.family[i]]),
      );
      this.outcomes[index] = SERVER_ROW_OUTCOMES.indexOf(
        OUTCOME_FROM_WIRE[batch.outcome[i]] ?? "failed",
      );
      const phase = batch.metadata_phase[i];
      // An unreadable phase word leaves the slot unset rather than
      // resolving to a guess: the row's placement does not depend on it,
      // and a wrong phase would misreport a coalesced wait as a round trip.
      const phaseName = phase === null || phase === undefined ? undefined : PHASE_FROM_WIRE[phase];
      this.metadataPhases[index] =
        phaseName === undefined ? NO_PHASE : METADATA_READ_PHASES.indexOf(phaseName);
      // Index 0 is a real pool entry, so the column stores id + 1 and
      // reserves 0 for "this row is not keyed on an open".
      this.requestIds[index] = requestId ? this.openIds.intern(requestId) + 1 : 0;
    }
    return refused;
  }

  serialise(): StoredServerRow[] {
    const out: StoredServerRow[] = [];
    for (let i = 0; i < this.rows; i++) {
      const requestIndex = this.requestIds[i];
      const phase = this.metadataPhases[i];
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
        coalescedOnto: this.coalescedOnto[i] === LABEL_NONE ? null : this.coalescedOnto[i],
        backendBytes: this.backendBytes[i] === BYTES_UNSET ? null : this.backendBytes[i],
        dispatchOffsetUs: this.dispatchOffsets[i],
        durationUs: this.durations[i],
        requestId: requestIndex === 0 ? null : this.openIds.get(requestIndex - 1),
        metadataPhase: phase === NO_PHASE ? null : METADATA_READ_PHASES[phase],
      });
    }
    return out;
  }

  private grow(): void {
    const next = this.capacity * 2;
    this.rids = copyInto(this.rids, new Uint32Array(next));
    this.connectionGenerations = copyInto(this.connectionGenerations, new Uint32Array(next));
    this.coalescedOnto = copyInto(this.coalescedOnto, new Uint32Array(next));
    this.phaseColumns = this.phaseColumns.map(column => copyInto(column, new Uint32Array(next)));
    this.backendBytes = copyInto(this.backendBytes, new Uint32Array(next).fill(BYTES_UNSET));
    this.families = copyInto(this.families, new Uint8Array(next));
    this.outcomes = copyInto(this.outcomes, new Uint8Array(next));
    this.metadataPhases = copyInto(this.metadataPhases, new Uint8Array(next).fill(NO_PHASE));
    this.requestIds = copyInto(this.requestIds, new Uint32Array(next));
    this.dispatchOffsets = copyInto(this.dispatchOffsets, new Uint32Array(next));
    this.durations = copyInto(this.durations, new Uint32Array(next));
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
