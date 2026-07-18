/** Test-only encoder for mocking the Rust `WasmScene.view_query` boundary. */

import type {
  ViewQueryBinaryEpochs,
  ViewQueryBinaryResult,
} from "../pipeline/planning/viewQueryBinary.ts";
import type {
  ViewQueryDeltaJson,
  ViewQueryEntityJson,
} from "../pipeline/planning/snapshotDelta.ts";

const FULL_HEADER_BYTES = 56;
const DELTA_HEADER_BYTES = 64;
const RECORD_PREFIX_BYTES = 64;
const utf8 = new TextEncoder();

const ZERO_EPOCHS: ViewQueryBinaryEpochs = {
  content: 0,
  layout: 0,
  view: 0,
  selection: 0,
  annotation: 0,
};

interface EncodedRow {
  row: ViewQueryEntityJson;
  entityId: Uint8Array;
  imageId: Uint8Array;
}

function encodeRows(rows: ViewQueryEntityJson[]): EncodedRow[] {
  return rows.map((row) => ({
    row,
    entityId: utf8.encode(row.entity_id),
    imageId: utf8.encode(row.image_id),
  }));
}

function rowsByteLength(rows: EncodedRow[]): number {
  return rows.reduce(
    (sum, encoded) => sum + RECORD_PREFIX_BYTES + encoded.entityId.length + encoded.imageId.length,
    0,
  );
}

function writeEpochs(view: DataView, offset: number, epochs: ViewQueryBinaryEpochs): void {
  for (const [index, epoch] of [
    epochs.content,
    epochs.layout,
    epochs.view,
    epochs.selection,
    epochs.annotation,
  ].entries()) {
    view.setBigUint64(offset + index * 8, BigInt(epoch), true);
  }
}

function writeRows(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  rows: EncodedRow[],
): number {
  let cursor = start;
  for (const { row, entityId, imageId } of rows) {
    view.setUint32(cursor, entityId.length, true);
    view.setUint32(cursor + 4, imageId.length, true);
    view.setUint32(cursor + 8, row.ideal_target_lod, true);
    view.setUint8(cursor + 12, row.kind === "Image" ? 0 : row.kind === "Group" ? 1 : 2);
    view.setUint8(cursor + 13, row.visible ? 1 : 0);
    view.setUint16(cursor + 14, 0, true);
    const floats = [
      row.projected_diagonal_px,
      row.projected_area_px2,
      ...row.centroid_world,
      row.importance,
    ];
    for (const [index, value] of floats.entries()) {
      view.setFloat64(cursor + 16 + index * 8, value, true);
    }
    cursor += RECORD_PREFIX_BYTES;
    bytes.set(entityId, cursor);
    cursor += entityId.length;
    bytes.set(imageId, cursor);
    cursor += imageId.length;
  }
  return cursor;
}

/** Mirrors the documented v1 format. Kept outside production code so the web
 * bundle contains a decoder only; tests can still model a real typed boundary. */
export function encodeViewQueryFixture(
  result: ViewQueryBinaryResult | null,
): Uint8Array {
  const encodedRows = encodeRows(result?.visible_entities ?? []);
  const byteLength = FULL_HEADER_BYTES + rowsByteLength(encodedRows);
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4c, 0x56, 0x51, 0x31], 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, result === null ? 0 : 1, true);
  view.setUint32(8, encodedRows.length, true);
  view.setUint32(12, FULL_HEADER_BYTES, true);
  writeEpochs(view, 16, result?.epochs ?? ZERO_EPOCHS);
  writeRows(bytes, view, FULL_HEADER_BYTES, encodedRows);
  return bytes;
}

/** Test-only counterpart for `WasmScene.view_query_delta`. Full variants reuse
 * the canonical full frame, exactly like Rust. */
export function encodeViewQueryDeltaFixture(
  delta: ViewQueryDeltaJson | null,
): Uint8Array {
  if (delta !== null && "Full" in delta) return encodeViewQueryFixture(delta.Full);

  const value = delta?.Delta;
  const entered = encodeRows(value?.entered ?? []);
  const changed = encodeRows(value?.changed ?? []);
  const left = (value?.left ?? []).map((id) => utf8.encode(id));
  const byteLength = DELTA_HEADER_BYTES + rowsByteLength(entered) + rowsByteLength(changed) +
    left.reduce((sum, id) => sum + 4 + id.length, 0);
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4c, 0x56, 0x44, 0x31], 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, value === undefined ? 0 : 1, true);
  view.setUint32(8, entered.length, true);
  view.setUint32(12, left.length, true);
  view.setUint32(16, changed.length, true);
  view.setUint32(20, DELTA_HEADER_BYTES, true);
  writeEpochs(view, 24, value?.epochs ?? ZERO_EPOCHS);
  let cursor = writeRows(bytes, view, DELTA_HEADER_BYTES, entered);
  for (const id of left) {
    view.setUint32(cursor, id.length, true);
    cursor += 4;
    bytes.set(id, cursor);
    cursor += id.length;
  }
  writeRows(bytes, view, cursor, changed);
  return bytes;
}
