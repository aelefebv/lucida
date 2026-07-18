import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import initWasm, { WasmScene } from "lucida-core";

import type { DatasetManifest } from "../../manifestTypes.ts";
import {
  decodeViewQuery,
  decodeViewQueryDelta,
} from "./viewQueryBinary.ts";

const DATASET_ID = "binary-boundary-ds";
const manifest: DatasetManifest = {
  dataset_id: DATASET_ID,
  name: "binary boundary fixture",
  kind: "Single",
  entities: [{ id: "entity-α", kind: "Image", parent: null, labels: {} }],
  transforms: [],
  images: [{
    image_id: "image-雪",
    owner: "entity-α",
    multiscale: {
      axes: [
        { name: "t", kind: "Time" },
        { name: "c", kind: "Channel" },
        { name: "z", kind: "Space" },
        { name: "y", kind: "Space" },
        { name: "x", kind: "Space" },
      ],
      levels: [{
        level_index: 0,
        shape: [1, 1, 1, 64, 64],
        chunk_shape: [1, 1, 1, 32, 32],
        grid_shape: [1, 1, 1, 2, 2],
        scale: [1, 1, 1, 1, 1],
      }],
      data_type: "Uint16",
    },
  }],
  source_layouts: [{
    id: "source",
    name: "Source",
    placements: [{ entity_id: "entity-α", position: [0, 0] }],
  }],
  default_layout_id: "source",
};

beforeAll(async () => {
  const wasm = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: wasm });
});

describe("WasmScene.view_query typed boundary", () => {
  it("crosses real wasm as Uint8Array and decodes the authoritative full set", () => {
    const scene = new WasmScene(800, 600);
    scene.load_document(JSON.stringify({
      manifests: { [DATASET_ID]: manifest },
      annotations: {},
    }));

    const bytes = scene.view_query(DATASET_ID);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = decodeViewQuery(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded!.visible_entities).toHaveLength(1);
    expect(decoded!.visible_entities[0]).toMatchObject({
      entity_id: "entity-α",
      image_id: "image-雪",
      kind: "Image",
      visible: true,
      ideal_target_lod: 0,
    });
  });

  it("preserves the unknown-dataset sentinel without a string/null fallback", () => {
    const scene = new WasmScene(800, 600);
    expect(decodeViewQuery(scene.view_query("missing"))).toBeNull();
    expect(decodeViewQueryDelta(scene.view_query_delta("missing"))).toBeNull();
  });

  it("crosses both Full and Delta variants through typed arrays", () => {
    const scene = new WasmScene(800, 600);
    scene.load_document(JSON.stringify({
      manifests: { [DATASET_ID]: manifest },
      annotations: {},
    }));

    const fullBytes = scene.view_query_delta(DATASET_ID);
    expect(fullBytes).toBeInstanceOf(Uint8Array);
    const full = decodeViewQueryDelta(fullBytes);
    expect(full).not.toBeNull();
    expect("Full" in full!).toBe(true);

    const deltaBytes = scene.view_query_delta(DATASET_ID);
    expect(deltaBytes).toBeInstanceOf(Uint8Array);
    const delta = decodeViewQueryDelta(deltaBytes);
    expect(delta).toEqual({
      Delta: {
        epochs: full && "Full" in full ? full.Full.epochs : null,
        entered: [],
        left: [],
        changed: [],
      },
    });
  });
});
