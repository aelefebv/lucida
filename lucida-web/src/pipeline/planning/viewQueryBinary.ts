/**
 * Decoder for `lucida-core/src/view_query_binary.rs` version 1.
 *
 * The WASM methods return one `Uint8Array` containing either the authoritative
 * full set or an incremental delta. Decoding is a single linear walk: no full
 * JSON string, token tree, or duplicate snake-case object graph is materialized
 * before the rows the planner needs. The returned row shape intentionally
 * remains the same one consumed by `makeEntitySnapshot`, so changing transport
 * cannot change set semantics.
 */

import type {
  ViewQueryDeltaJson,
  ViewQueryEntityJson,
  ViewQueryEpochs,
} from "./snapshotDelta.ts";

const FULL_MAGIC = [0x4c, 0x56, 0x51, 0x31] as const; // "LVQ1"
const DELTA_MAGIC = [0x4c, 0x56, 0x44, 0x31] as const; // "LVD1"
const VERSION = 1;
const FULL_HEADER_BYTES = 56;
const DELTA_HEADER_BYTES = 64;
const RECORD_PREFIX_BYTES = 64;
const LEFT_ID_PREFIX_BYTES = 4;
const FLAG_PRESENT = 1;
const MAX_SAFE_EPOCH = BigInt(Number.MAX_SAFE_INTEGER);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ViewQueryBinaryEpochs = ViewQueryEpochs;

export interface ViewQueryBinaryResult {
  epochs: ViewQueryBinaryEpochs;
  visible_entities: ViewQueryEntityJson[];
}

export class ViewQueryBinaryError extends Error {
  constructor(message: string) {
    super(`[view-query binary] ${message}`);
    this.name = "ViewQueryBinaryError";
  }
}

function fail(message: string): never {
  throw new ViewQueryBinaryError(message);
}

function readSafeEpoch(view: DataView, offset: number, name: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > MAX_SAFE_EPOCH) {
    fail(`${name} epoch exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

function readEpochs(view: DataView, offset: number): ViewQueryBinaryEpochs {
  return {
    content: readSafeEpoch(view, offset, "content"),
    layout: readSafeEpoch(view, offset + 8, "layout"),
    view: readSafeEpoch(view, offset + 16, "view"),
    selection: readSafeEpoch(view, offset + 24, "selection"),
    annotation: readSafeEpoch(view, offset + 32, "annotation"),
  };
}

function hasMagic(view: DataView, magic: readonly number[]): boolean {
  if (view.byteLength < magic.length) return false;
  return magic.every((byte, index) => view.getUint8(index) === byte);
}

function requireFinite(value: number, field: string, record: number): number {
  if (!Number.isFinite(value)) fail(`record ${record} has non-finite ${field}`);
  return value;
}

function decodeId(bytes: Uint8Array, start: number, length: number, field: string, record: number): string {
  try {
    return utf8.decode(bytes.subarray(start, start + length));
  } catch {
    return fail(`record ${record} has invalid UTF-8 in ${field}`);
  }
}

function decodeRecords(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  count: number,
  section: string,
): { records: ViewQueryEntityJson[]; cursor: number } {
  if (count > Math.floor((bytes.byteLength - start) / RECORD_PREFIX_BYTES)) {
    fail(`${section} record count exceeds the available bytes`);
  }

  const records = new Array<ViewQueryEntityJson>(count);
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    const recordLabel = `${section} record ${index}`;
    if (cursor + RECORD_PREFIX_BYTES > bytes.byteLength) {
      fail(`${recordLabel} has a truncated scalar prefix`);
    }

    const entityIdBytes = view.getUint32(cursor, true);
    const imageIdBytes = view.getUint32(cursor + 4, true);
    const idealTargetLod = view.getUint32(cursor + 8, true);
    const kindCode = view.getUint8(cursor + 12);
    const visibleCode = view.getUint8(cursor + 13);
    const reserved = view.getUint16(cursor + 14, true);
    if (reserved !== 0) fail(`${recordLabel} uses reserved bits`);
    if (visibleCode > 1) fail(`${recordLabel} has invalid visibility ${visibleCode}`);

    let kind: ViewQueryEntityJson["kind"];
    if (kindCode === 0) kind = "Image";
    else if (kindCode === 1) kind = "Group";
    else if (kindCode === 2) kind = "Tile";
    else fail(`${recordLabel} has invalid kind ${kindCode}`);

    const projectedDiagonalPx = requireFinite(
      view.getFloat64(cursor + 16, true), "projected_diagonal_px", index,
    );
    const projectedAreaPx2 = requireFinite(
      view.getFloat64(cursor + 24, true), "projected_area_px2", index,
    );
    const centroidWorld: [number, number, number] = [
      requireFinite(view.getFloat64(cursor + 32, true), "centroid_world[0]", index),
      requireFinite(view.getFloat64(cursor + 40, true), "centroid_world[1]", index),
      requireFinite(view.getFloat64(cursor + 48, true), "centroid_world[2]", index),
    ];
    const importance = requireFinite(
      view.getFloat64(cursor + 56, true), "importance", index,
    );

    cursor += RECORD_PREFIX_BYTES;
    const stringsEnd = cursor + entityIdBytes + imageIdBytes;
    if (!Number.isSafeInteger(stringsEnd) || stringsEnd > bytes.byteLength) {
      fail(`${recordLabel} has truncated id bytes`);
    }
    const entityId = decodeId(bytes, cursor, entityIdBytes, "entity_id", index);
    cursor += entityIdBytes;
    const imageId = decodeId(bytes, cursor, imageIdBytes, "image_id", index);
    cursor += imageIdBytes;

    records[index] = {
      entity_id: entityId,
      image_id: imageId,
      kind,
      visible: visibleCode === 1,
      projected_diagonal_px: projectedDiagonalPx,
      projected_area_px2: projectedAreaPx2,
      centroid_world: centroidWorld,
      ideal_target_lod: idealTargetLod,
      importance,
    };
  }
  return { records, cursor };
}

/** Decode one full-set response. `null` means the dataset is unknown; a known
 * dataset with no records returns a non-null result with an empty array. */
export function decodeViewQuery(bytes: Uint8Array): ViewQueryBinaryResult | null {
  if (!(bytes instanceof Uint8Array)) fail("expected a Uint8Array");
  if (bytes.byteLength < FULL_HEADER_BYTES) fail("truncated full header");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!hasMagic(view, FULL_MAGIC)) fail("bad full-frame magic");
  const version = view.getUint16(4, true);
  if (version !== VERSION) fail(`unsupported version ${version}`);
  const flags = view.getUint16(6, true);
  if ((flags & ~FLAG_PRESENT) !== 0) fail(`unsupported flags 0x${flags.toString(16)}`);
  const recordCount = view.getUint32(8, true);
  const headerBytes = view.getUint32(12, true);
  if (headerBytes !== FULL_HEADER_BYTES) fail(`invalid version-1 full header length ${headerBytes}`);

  const epochs = readEpochs(view, 16);

  if ((flags & FLAG_PRESENT) === 0) {
    if (recordCount !== 0 || bytes.byteLength !== FULL_HEADER_BYTES) {
      fail("unknown-dataset full frame must contain only an empty header");
    }
    return null;
  }

  const { records: visibleEntities, cursor } = decodeRecords(
    bytes, view, FULL_HEADER_BYTES, recordCount, "full",
  );
  if (cursor !== bytes.byteLength) fail(`${bytes.byteLength - cursor} trailing byte(s)`);
  return { epochs, visible_entities: visibleEntities };
}

/** Decode the incremental boundary. A full resync deliberately reuses the
 * exact `LVQ1` frame, while an actual difference uses `LVD1`. */
export function decodeViewQueryDelta(bytes: Uint8Array): ViewQueryDeltaJson | null {
  if (!(bytes instanceof Uint8Array)) fail("expected a Uint8Array");
  if (bytes.byteLength >= FULL_MAGIC.length) {
    const prefix = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (hasMagic(prefix, FULL_MAGIC)) {
      const full = decodeViewQuery(bytes);
      return full === null ? null : { Full: full };
    }
  }
  if (bytes.byteLength < DELTA_HEADER_BYTES) fail("truncated delta header");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!hasMagic(view, DELTA_MAGIC)) fail("bad delta-frame magic");
  const version = view.getUint16(4, true);
  if (version !== VERSION) fail(`unsupported version ${version}`);
  const flags = view.getUint16(6, true);
  if ((flags & ~FLAG_PRESENT) !== 0) fail(`unsupported flags 0x${flags.toString(16)}`);
  const enteredCount = view.getUint32(8, true);
  const leftCount = view.getUint32(12, true);
  const changedCount = view.getUint32(16, true);
  const headerBytes = view.getUint32(20, true);
  if (headerBytes !== DELTA_HEADER_BYTES) {
    fail(`invalid version-1 delta header length ${headerBytes}`);
  }
  const epochs = readEpochs(view, 24);

  if ((flags & FLAG_PRESENT) === 0) {
    if (
      enteredCount !== 0 || leftCount !== 0 || changedCount !== 0 ||
      bytes.byteLength !== DELTA_HEADER_BYTES
    ) {
      fail("unknown-dataset delta frame must contain only an empty header");
    }
    return null;
  }

  const minimumPayloadBytes =
    (enteredCount + changedCount) * RECORD_PREFIX_BYTES + leftCount * LEFT_ID_PREFIX_BYTES;
  if (
    !Number.isSafeInteger(minimumPayloadBytes) ||
    minimumPayloadBytes > bytes.byteLength - DELTA_HEADER_BYTES
  ) {
    fail("delta counts exceed the available bytes");
  }

  const enteredSection = decodeRecords(
    bytes, view, DELTA_HEADER_BYTES, enteredCount, "entered",
  );
  let cursor = enteredSection.cursor;
  const left = new Array<string>(leftCount);
  for (let index = 0; index < leftCount; index += 1) {
    if (cursor + LEFT_ID_PREFIX_BYTES > bytes.byteLength) {
      fail(`left id ${index} has a truncated length`);
    }
    const byteLength = view.getUint32(cursor, true);
    cursor += LEFT_ID_PREFIX_BYTES;
    const end = cursor + byteLength;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength) {
      fail(`left id ${index} has truncated UTF-8 bytes`);
    }
    left[index] = decodeId(bytes, cursor, byteLength, "left image_id", index);
    cursor = end;
  }
  const changedSection = decodeRecords(bytes, view, cursor, changedCount, "changed");
  cursor = changedSection.cursor;
  if (cursor !== bytes.byteLength) fail(`${bytes.byteLength - cursor} trailing byte(s)`);

  return {
    Delta: {
      epochs,
      entered: enteredSection.records,
      left,
      changed: changedSection.records,
    },
  };
}
