import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  encodeViewQueryDeltaFixture,
  encodeViewQueryFixture,
} from "../../test/viewQueryBinaryFixture.ts";
import {
  applyViewQueryDelta,
  type SnapshotEntityDeps,
  type ViewQueryDeltaJson,
  type ViewQueryEntityJson,
} from "./snapshotDelta.ts";
import {
  decodeViewQuery,
  decodeViewQueryDelta,
  ViewQueryBinaryError,
  type ViewQueryBinaryResult,
} from "./viewQueryBinary.ts";

const EPOCHS = {
  content: 11,
  layout: 12,
  view: 13,
  selection: 14,
  annotation: 15,
};

interface GoldenFixture {
  format_version: number;
  frame_hex: string;
  value: ViewQueryBinaryResult;
}

interface DeltaGoldenFixture {
  format_version: number;
  frame_hex: string;
  value: ViewQueryDeltaJson;
}

const golden = JSON.parse(readFileSync(
  new URL("../../../../wire-fixtures/binary/view_query_v1.json", import.meta.url),
  "utf8",
)) as GoldenFixture;
const deltaGolden = JSON.parse(readFileSync(
  new URL("../../../../wire-fixtures/binary/view_query_delta_v1.json", import.meta.url),
  "utf8",
)) as DeltaGoldenFixture;

function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("fixture hex must have an even length");
  return Uint8Array.from(
    { length: hex.length / 2 },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

function row(
  index: number,
  kind: ViewQueryEntityJson["kind"] = "Tile",
): ViewQueryEntityJson {
  return {
    entity_id: `entity-${index}-λ`,
    image_id: `image-${index}-雪`,
    kind,
    visible: index % 2 === 0,
    projected_diagonal_px: 100.25 + index,
    projected_area_px2: 10_000.5 + index,
    centroid_world: [index, index + 0.5, index + 1],
    ideal_target_lod: index % 7,
    importance: 0.125 + index,
  };
}

function result(count: number): ViewQueryBinaryResult {
  const kinds = ["Image", "Group", "Tile"] as const;
  return {
    epochs: EPOCHS,
    visible_entities: Array.from({ length: count }, (_, index) => row(index, kinds[index % 3])),
  };
}

describe("decodeViewQuery", () => {
  it("decodes the exact bytes emitted by the Rust cross-language golden", () => {
    expect(golden.format_version).toBe(1);
    expect(decodeViewQuery(bytesFromHex(golden.frame_hex))).toEqual(golden.value);
  });

  it("is semantically identical to the former JSON path and preserves set order", () => {
    const expected = result(6);
    const formerJsonResult = JSON.parse(JSON.stringify(expected)) as ViewQueryBinaryResult;
    const decoded = decodeViewQuery(encodeViewQueryFixture(expected));

    expect(decoded).toEqual(formerJsonResult);
    expect(decoded!.visible_entities.map((entity) => entity.image_id))
      .toEqual(expected.visible_entities.map((entity) => entity.image_id));
  });

  it("distinguishes an unknown dataset from a known empty full set", () => {
    expect(decodeViewQuery(encodeViewQueryFixture(null))).toBeNull();
    expect(decodeViewQuery(encodeViewQueryFixture(result(0)))).toEqual({
      epochs: EPOCHS,
      visible_entities: [],
    });
  });

  it("honors a Uint8Array byte offset instead of reading the whole backing buffer", () => {
    const encoded = encodeViewQueryFixture(result(1));
    const framed = new Uint8Array(encoded.length + 7);
    framed.set(encoded, 3);
    expect(decodeViewQuery(framed.subarray(3, 3 + encoded.length))).toEqual(result(1));
  });

  it("fails closed on version, count, UTF-8, scalar, and trailing-byte corruption", () => {
    const unsupportedVersion = encodeViewQueryFixture(result(1));
    new DataView(unsupportedVersion.buffer).setUint16(4, 99, true);
    expect(() => decodeViewQuery(unsupportedVersion)).toThrow(/unsupported version 99/);

    const impossibleCount = encodeViewQueryFixture(result(1));
    new DataView(impossibleCount.buffer).setUint32(8, 999, true);
    expect(() => decodeViewQuery(impossibleCount)).toThrow(/record count exceeds/);

    const invalidUtf8 = encodeViewQueryFixture(result(1));
    invalidUtf8[56 + 64] = 0xff;
    expect(() => decodeViewQuery(invalidUtf8)).toThrow(/invalid UTF-8/);

    const nonFinite = encodeViewQueryFixture(result(1));
    new DataView(nonFinite.buffer).setFloat64(56 + 16, Number.NaN, true);
    expect(() => decodeViewQuery(nonFinite)).toThrow(/non-finite projected_diagonal_px/);

    const withTrailingByte = new Uint8Array(encodeViewQueryFixture(result(0)).length + 1);
    withTrailingByte.set(encodeViewQueryFixture(result(0)));
    expect(() => decodeViewQuery(withTrailingByte)).toThrow(/trailing byte/);
  });

  it("rejects the old JSON/string boundary rather than silently reparsing it", () => {
    expect(() => decodeViewQuery("{}" as unknown as Uint8Array))
      .toThrow(ViewQueryBinaryError);
  });

  it("cuts the 216-record transfer below half the equivalent JSON bytes", () => {
    const wide = result(216);
    const binaryBytes = encodeViewQueryFixture(wide).byteLength;
    const jsonBytes = new TextEncoder().encode(JSON.stringify(wide)).byteLength;
    expect(binaryBytes).toBeLessThan(jsonBytes / 2);
    expect(decodeViewQuery(encodeViewQueryFixture(wide))!.visible_entities).toHaveLength(216);
  });
});

describe("decodeViewQueryDelta", () => {
  it("decodes the exact Rust delta golden and reuses the canonical full frame", () => {
    expect(deltaGolden.format_version).toBe(1);
    expect(decodeViewQueryDelta(bytesFromHex(deltaGolden.frame_hex)))
      .toEqual(deltaGolden.value);

    const full = result(3);
    expect(decodeViewQueryDelta(encodeViewQueryDeltaFixture({ Full: full })))
      .toEqual({ Full: full });
  });

  it("distinguishes an unknown delta response from an empty delta", () => {
    expect(decodeViewQueryDelta(encodeViewQueryDeltaFixture(null))).toBeNull();
    const empty: ViewQueryDeltaJson = {
      Delta: { epochs: EPOCHS, entered: [], left: [], changed: [] },
    };
    expect(decodeViewQueryDelta(encodeViewQueryDeltaFixture(empty))).toEqual(empty);
  });

  it("reconstructs the same set as the equivalent authoritative full query", () => {
    const decoded = decodeViewQueryDelta(bytesFromHex(deltaGolden.frame_hex));
    expect(decoded).not.toBeNull();
    const delta = decoded!;
    const changed = "Delta" in delta ? delta.Delta.changed[0] : null;
    const entered = "Delta" in delta ? delta.Delta.entered[0] : null;
    expect(changed).not.toBeNull();
    expect(entered).not.toBeNull();

    const oldTile = { ...changed!, visible: true, ideal_target_lod: 2 };
    const beforeRows = [
      row(90, "Image"),
      { ...row(91, "Image"), image_id: "old-image" },
      { ...row(92, "Image"), image_id: "影" },
      oldTile,
    ];
    const deps: SnapshotEntityDeps = {
      imageSpecById: new Map(),
      parentByEntityId: new Map([[changed!.entity_id, "group-parent"]]),
      positions: {},
      dsSettings: undefined,
    };
    const before = applyViewQueryDelta(null, {
      Full: { epochs: EPOCHS, visible_entities: beforeRows },
    }, deps);
    const folded = applyViewQueryDelta(before, delta, deps);
    const authoritative = applyViewQueryDelta(null, {
      Full: {
        epochs: EPOCHS,
        visible_entities: [beforeRows[0], entered!, changed!],
      },
    }, deps);
    expect(folded).toEqual(authoritative);
  });

  it("fails closed on impossible counts, corrupt left ids, and trailing bytes", () => {
    const impossibleCount = bytesFromHex(deltaGolden.frame_hex);
    new DataView(impossibleCount.buffer).setUint32(12, 0xffff_ffff, true);
    expect(() => decodeViewQueryDelta(impossibleCount)).toThrow(/delta counts exceed/);

    const leftUtf8 = encodeViewQueryDeltaFixture({
      Delta: { epochs: EPOCHS, entered: [], left: ["left"], changed: [] },
    });
    leftUtf8[64 + 4] = 0xff;
    expect(() => decodeViewQueryDelta(leftUtf8)).toThrow(/invalid UTF-8/);

    const original = encodeViewQueryDeltaFixture({
      Delta: { epochs: EPOCHS, entered: [], left: [], changed: [] },
    });
    const trailing = new Uint8Array(original.length + 1);
    trailing.set(original);
    expect(() => decodeViewQueryDelta(trailing)).toThrow(/trailing byte/);
  });
});
