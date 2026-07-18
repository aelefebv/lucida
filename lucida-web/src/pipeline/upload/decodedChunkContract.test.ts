import { describe, expect, it } from "vitest";
import type { ReadyChunkDelivery } from "../fetch/index.ts";
import type { ManifestEntry } from "./delivery/manifestIndex.ts";
import { decodedChunkContract } from "./decodedChunkContract.ts";
import { chunkContractForLevel } from "../../chunkContract.ts";
import type { ImageSpec } from "../../manifestTypes.ts";

const level = {
  level_index: 0,
  shape: [1, 4, 4, 8, 16],
  chunk_shape: [1, 1, 2, 4, 8],
  grid_shape: [1, 4, 2, 2, 2],
  scale: [1, 1, 1, 1, 1],
};

function image(isLabel = false): ImageSpec {
  return {
    image_id: isLabel ? "labels" : "image",
    owner: "entity",
    multiscale: {
      axes: [],
      levels: [level],
      data_type: isLabel ? "Uint16" : "Uint8",
    },
  };
}

function meta(isLabel = false): ManifestEntry {
  const spec = image(isLabel);
  return {
    datasetId: "ds-1",
    manifest: { dataset_id: "ds-1" },
    image: spec,
    levels: [level],
    isLabel,
  } as unknown as ManifestEntry;
}

function delivery(isLabel = false): ReadyChunkDelivery {
  const spec = image(isLabel);
  const contract = chunkContractForLevel({
    datasetId: "ds-1",
    image: spec,
    level,
    channel: 3,
    role: isLabel ? "label" : "intensity",
  });
  return {
    kind: "chunk",
    datasetId: "ds-1",
    entityId: "entity",
    imageId: spec.image_id,
    level: 0,
    t: 0,
    c: 3,
    z: 0,
    y: 0,
    x: 0,
    chunkKey: "0/0/3/0/0/0",
    data: new ArrayBuffer(contract.expectedBytes),
    contract,
    epochs: { content: 1, layout: 1, view: 1, selection: 1, request: 1 },
    lane: "detail",
  };
}

describe("decodedChunkContract", () => {
  it("preserves the admitted intensity contract and exact expected bytes", () => {
    expect(decodedChunkContract(delivery(), meta())).toMatchObject({
      datasetId: "ds-1",
      imageId: "image",
      channel: 3,
      role: "intensity",
      sourceDtype: "uint8",
      dtype: "uint16",
      shape: [2, 4, 8],
      sourceExpectedBytes: 64,
      expectedBytes: 128,
      normalization: "uint8_to_uint16",
    });
  });

  it("normalizes admitted unsigned labels to the canonical uint32 contract", () => {
    expect(decodedChunkContract(delivery(true), meta(true))).toMatchObject({
      role: "label",
      sourceDtype: "uint16",
      dtype: "uint32",
      sourceExpectedBytes: 128,
      expectedBytes: 256,
      normalization: "uint16_to_uint32",
    });
  });

  it("rejects short and oversized buffers before worker upload", () => {
    const valid = delivery();
    expect(() => decodedChunkContract({ ...valid, data: new ArrayBuffer(127) }, meta()))
      .toThrow(/expected exactly 128/);
    expect(() => decodedChunkContract({ ...valid, data: new ArrayBuffer(129) }, meta()))
      .toThrow(/expected exactly 128/);
  });

  it("rejects contract drift and cross-dataset/image routing", () => {
    const valid = delivery();
    expect(() => decodedChunkContract({
      ...valid,
      contract: { ...valid.contract, channel: 2 },
    }, meta())).toThrow(/channel/);
    expect(() => decodedChunkContract({ ...valid, datasetId: "ds-2" }, meta()))
      .toThrow(/dataset/);
    expect(() => decodedChunkContract({ ...valid, imageId: "other" }, meta()))
      .toThrow(/image/);
  });
});
