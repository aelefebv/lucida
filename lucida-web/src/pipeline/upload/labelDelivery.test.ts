/**
 * Headless proof that label chunks flow end-to-end:
 *
 *   computeLabelChunkRequests  (fetch plan)
 *     → ReadyChunkDelivery      (what cpuCache yields after fetch+decode)
 *     → dispatchLabelChunkDelivery → client.labelSliceChunkData  (routing)
 *     → handleLabelSliceChunkData  (worker) → r32uint label pool
 *
 * The client→worker hop is normally `postMessage`; here the mock client
 * forwards straight into the worker handler so the whole path runs in-proc.
 * Confirms only the needed Z-plane crosses (not the full 3D chunk) and that
 * ids land in the pool intact (no u16 crush).
 */

import { describe, it, expect, vi } from "vitest";

(globalThis as Record<string, unknown>).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x02 };

import type { DatasetManifest, ImageSpec, LabelSpec } from "../../manifestTypes.ts";
import type { DatasetEntry } from "../../renderLoopTypes.ts";
import type { ReadyChunkDelivery } from "../fetch/index.ts";
import type { UploadClient } from "./uploadClient.ts";
import type { SceneEpochs } from "../epochs.ts";
import type { WorkerCtx } from "../../renderer/workerContext.ts";
import type { LabelSliceChunkDataMessage } from "../../renderer/workerProtocol.ts";
import { createInitialState } from "../../renderer/worker/state.ts";
import { handleLabelSliceChunkData } from "../../renderer/slice/upload.ts";
import { handleLabelVolumeChunkData } from "../../renderer/volume/upload.ts";
import type { LabelVolumeChunkDataMessage } from "../../renderer/workerProtocol.ts";
import { computeLabelChunkRequests, labelFormsFor } from "../planning/labelRequests.ts";
import { labelSlicePoolKey, labelVolumePoolKey } from "../../renderer/labelPools.ts";
import { buildManifestByImage } from "./delivery/manifestIndex.ts";
import { dispatchLabelChunkDelivery, dispatchLabelVolumeChunkDelivery } from "./delivery/dispatch.ts";

const EPOCHS: SceneEpochs = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

function ms(
  id: string,
  dtype: string,
  shape5: number[],
  chunk5: number[],
  scale5: number[],
): ImageSpec {
  return {
    image_id: id,
    owner: "ent-0",
    multiscale: {
      axes: [
        { name: "t", kind: "time" },
        { name: "c", kind: "channel" },
        { name: "z", kind: "space" },
        { name: "y", kind: "space" },
        { name: "x", kind: "space" },
      ],
      levels: [{ level_index: 0, shape: shape5, chunk_shape: chunk5, grid_shape: [1, 1, 1, 1, 1], scale: scale5 }],
      data_type: dtype,
    },
  };
}

// Source is 2 Z-planes; label is a 2x2x2 chunk (fat Z: both planes in one chunk).
const label: LabelSpec = {
  name: "region-b",
  source_image_id: "img-0",
  image: ms("img-0:label:region-b", "Uint32", [1, 1, 2, 2, 2], [1, 1, 2, 2, 2], [1, 1, 1, 1, 1]),
  colors: [],
  source_declared: true,
};

const manifest: DatasetManifest = {
  dataset_id: "ds-0",
  name: "test",
  kind: "Single",
  entities: [],
  transforms: [],
  images: [ms("img-0", "Uint16", [1, 1, 2, 2, 2], [1, 1, 2, 2, 2], [1, 1, 1, 1, 1])],
  source_layouts: [],
  default_layout_id: null,
  labels: [label],
};

interface WriteTextureCall { buffer: ArrayBuffer }

function makeWorkerCtx(writes: WriteTextureCall[]): WorkerCtx {
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    createTexture: vi.fn(() => ({ destroy: vi.fn(), createView: vi.fn(() => ({})) })),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => Promise.resolve(null)),
    queue: {
      writeBuffer: vi.fn(),
      writeTexture: vi.fn((_dest: unknown, buffer: ArrayBuffer) => { writes.push({ buffer }); }),
      submit: vi.fn(),
    },
  } as unknown as GPUDevice;
  return { device, state: createInitialState(), post: vi.fn() } as unknown as WorkerCtx;
}

describe("label chunk flow: request → pre-sliced delivery → pool", () => {
  it("extracts only the current Z-plane and lands it in the pool with ids intact", () => {
    // 1. Fetch plan the tickCoordinator merges (source Z=1 in view). Masks are
    //    opt-in, so the single label is turned on explicitly.
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, cut: { axis: "z", index: 1 }, labelSettings: [{ visible: true, opacity: 0.5 }] });
    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    expect(req.imageId).toBe("img-0:label:region-b");
    expect(req.z).toBe(0); // Z=1 sits in Z-chunk 0 (chunkZ=2)

    // 2. cpuCache yields the FULL 3D chunk (2x2x2 = 8 ids): plane0 then plane1.
    const ids = new Uint32Array([10, 11, 12, 13, 92801, 92801 + 65536, 30, 4_294_967_295]);
    const delivery: ReadyChunkDelivery = {
      entityId: req.entityId,
      imageId: req.imageId,
      level: req.level,
      t: req.t, c: req.c, z: req.z, y: req.y, x: req.x,
      chunkKey: req.chunkKey,
      data: ids.buffer as ArrayBuffer,
      dataType: "Uint32",
      epochs: EPOCHS,
      lane: "detail",
      residencyTier: "detail",
      mode: "slice",
    };

    // 3. Delivery routing: meta is indexed as a label; the mock client
    //    forwards the message into the worker handler.
    const datasets = new Map<string, DatasetEntry>([
      ["ds-0", { manifest } as unknown as DatasetEntry],
    ]);
    const meta = buildManifestByImage(datasets).get("img-0:label:region-b");
    expect(meta?.isLabel).toBe(true);

    const writes: WriteTextureCall[] = [];
    const ctx = makeWorkerCtx(writes);
    const client = {
      labelSliceChunkData: vi.fn((
        memberId: string,
        datasetId: string,
        chunks: { data: ArrayBuffer; dataType: string; x: number; y: number; z: number; key: string }[],
        level: number, t: number, c: number,
        levelWidth: number, levelHeight: number,
        chunkX: number, chunkY: number,
        plane: number,
        epochs: SceneEpochs,
      ) => {
        const msg: LabelSliceChunkDataMessage = {
          type: "labelSliceChunkData",
          epochs, memberId, datasetId, chunks,
          level, t, c,
          levelWidth, levelHeight, chunkX, chunkY, plane,
        };
        // As the real post does, the plane moves to the worker.
        handleLabelSliceChunkData(ctx, structuredClone(msg, { transfer: chunks.map((chunk) => chunk.data) }));
      }),
    } as unknown as UploadClient;

    // Plane 1 → the delivery path extracts the z=1 plane (last 4 ids).
    const result = dispatchLabelChunkDelivery(client, delivery, meta!, { axis: "z", plane: 1 }, EPOCHS);
    // Only ONE 2x2 plane crosses (16 bytes), never the whole 8-id chunk (32).
    expect(result).toEqual({ memberId: "img-0:label:region-b", bytes: 16 });
    // The delivery stamped the owning dataset id (from the ManifestEntry key).
    expect(vi.mocked(client.labelSliceChunkData).mock.calls[0][1]).toBe("ds-0");

    // 4. The plane landed in the pool sized to the label's own dims.
    const pool = ctx.state.labelSlicePools.get(labelSlicePoolKey("img-0:label:region-b", 0, 1));
    expect(pool).toBeDefined();
    expect(pool!.width).toBe(2);
    expect(pool!.height).toBe(2);
    expect(pool!.datasetId).toBe("ds-0"); // stamped for dataset-scoped removal

    // 5. The z=1 plane (last 4 ids) reached the texture at full 32-bit width.
    expect(writes.length).toBeGreaterThan(0);
    const written = new Uint32Array(writes[0].buffer);
    expect(written[0]).toBe(92801);
    expect(written[1]).toBe(92801 + 65536);
  });

  it("drops a delivery whose Z-chunk no longer matches the current view", () => {
    const meta = buildManifestByImage(
      new Map<string, DatasetEntry>([["ds-0", { manifest } as unknown as DatasetEntry]]),
    ).get("img-0:label:region-b");
    const delivery: ReadyChunkDelivery = {
      entityId: "img-0:label:region-b",
      imageId: "img-0:label:region-b",
      level: 0,
      t: 0, c: 0, z: 5, y: 0, x: 0, // z-chunk 5, but the view maps to z-chunk 0
      chunkKey: "0/0/0/5/0/0",
      data: new Uint32Array(8).buffer as ArrayBuffer,
      dataType: "Uint32",
      epochs: EPOCHS,
      lane: "detail",
      residencyTier: "detail",
      mode: "slice",
    };
    const client = { labelSliceChunkData: vi.fn() } as unknown as UploadClient;
    const result = dispatchLabelChunkDelivery(client, delivery, meta!, { axis: "z", plane: 1 }, EPOCHS);
    expect(result).toBe("other-plane");
    expect(client.labelSliceChunkData).not.toHaveBeenCalled();
  });
});

describe("label chunk flow: planes of a deeper chunk", () => {
  // An 8-plane label in one 8-plane chunk, 2x2 samples a plane.
  const deep: LabelSpec = {
    name: "deep",
    source_image_id: "img-0",
    image: ms("img-0:label:deep", "Uint32", [1, 1, 8, 2, 2], [1, 1, 8, 2, 2], [1, 1, 1, 1, 1]),
  };
  const deepManifest: DatasetManifest = {
    ...manifest,
    images: [ms("img-0", "Uint16", [1, 1, 8, 2, 2], [1, 1, 8, 2, 2], [1, 1, 1, 1, 1])],
    labels: [deep],
  };
  const meta = buildManifestByImage(
    new Map<string, DatasetEntry>([["ds-0", { manifest: deepManifest } as unknown as DatasetEntry]]),
  ).get("img-0:label:deep")!;
  /** Planes 3 to 5 of the chunk, each plane's four ids its own plane index times 10, plus 0 to 3. */
  function band(): ReadyChunkDelivery {
    const ids = new Uint32Array(12).map((_, i) => (3 + Math.floor(i / 4)) * 10 + (i % 4));
    return {
      entityId: "img-0:label:deep",
      imageId: "img-0:label:deep",
      level: 0,
      t: 0, c: 0, z: 0, y: 0, x: 0,
      chunkKey: "0/0/0/0/0/0",
      data: ids.buffer as ArrayBuffer,
      dataType: "Uint32",
      epochs: EPOCHS,
      lane: "detail",
      residencyTier: "detail",
      mode: "slice",
      planes: [3, 6],
    };
  }

  it("asks for the plane drawn and a band around it", () => {
    const [req] = computeLabelChunkRequests({
      datasetId: "ds-0", manifest: deepManifest, t: 0, cut: { axis: "z", index: 4 }, labelSettings: [{ visible: true, opacity: 0.5 }],
    });
    expect(req).toMatchObject({ z: 0, plane: 4, planes: [2, 7], cut: { axis: "z", plane: 4 } });
  });

  it("names the form a view draws the label in: its plane, axis and chunk-T in a slice view, its chunk-T in 3D", () => {
    const args = {
      datasetId: "ds-0", manifest: deepManifest, t: 0, cut: { axis: "z" as const, index: 4 },
      labelSettings: [{ visible: true, opacity: 0.5 }],
    };
    expect(labelFormsFor(args)).toEqual([{ memberId: "img-0:label:deep", t: 0, plane: 4 }]);
    expect(labelFormsFor({ ...args, mode: "volume" })).toEqual([{ memberId: "img-0:label:deep", t: 0 }]);
    expect(labelFormsFor({ ...args, cut: { axis: "y", index: 1 } })).toEqual([
      { memberId: "img-0:label:deep", t: 0, plane: 1, axis: "y" },
    ]);
  });

  it("asks a side view's chunks for the plane it cuts along its axis", () => {
    const [req] = computeLabelChunkRequests({
      datasetId: "ds-0", manifest: deepManifest, t: 0, cut: { axis: "x", index: 1 },
      labelSettings: [{ visible: true, opacity: 0.5 }],
    });
    // Two samples along X, so the band would be the whole chunk: it comes whole.
    expect(req).toMatchObject({ z: 0, y: 0, x: 0, cut: { axis: "x", plane: 1 } });
    expect(req.planes).toBeUndefined();
  });

  it("cuts a side view's plane out of a whole chunk, across and down the plane drawn", () => {
    const client = { labelSliceChunkData: vi.fn() } as unknown as UploadClient;
    // Each id its own index in the chunk: z * 4 + y * 2 + x.
    const whole: ReadyChunkDelivery = { ...band(), data: new Uint32Array(32).map((_, i) => i).buffer, planes: undefined };
    expect(dispatchLabelChunkDelivery(client, whole, meta, { axis: "y", plane: 1 }, EPOCHS)).toEqual({
      memberId: "img-0:label:deep",
      bytes: 64,
    });
    const [, , chunks, , , , levelW, levelH, chunkW, chunkH, plane, , axis] = vi.mocked(client.labelSliceChunkData).mock.calls[0];
    // X across, Z down, at Y 1.
    expect([levelW, levelH, chunkW, chunkH, plane, axis]).toEqual([2, 8, 2, 8, 1, "y"]);
    expect(Array.from(new Uint32Array(chunks[0].data))).toEqual(
      Array.from({ length: 16 }, (_, i) => Math.floor(i / 2) * 4 + 2 + (i % 2)),
    );
  });

  it("cuts the plane drawn out of a delivery of some planes, at its offset among them", () => {
    const client = { labelSliceChunkData: vi.fn() } as unknown as UploadClient;
    expect(dispatchLabelChunkDelivery(client, band(), meta, { axis: "z", plane: 4 }, EPOCHS)).toEqual({
      memberId: "img-0:label:deep",
      bytes: 16,
    });
    const chunks = vi.mocked(client.labelSliceChunkData).mock.calls[0][2];
    expect(Array.from(new Uint32Array(chunks[0].data))).toEqual([40, 41, 42, 43]);
  });

  it("posts nothing from planes that leave out the one drawn, nor to the volume pool", () => {
    const client = {
      labelSliceChunkData: vi.fn(),
      labelVolumeChunkData: vi.fn(),
    } as unknown as UploadClient;
    expect(dispatchLabelChunkDelivery(client, band(), meta, { axis: "z", plane: 6 }, EPOCHS)).toBe("other-plane");
    expect(dispatchLabelChunkDelivery(client, band(), meta, { axis: "z", plane: 2 }, EPOCHS)).toBe("other-plane");
    expect(dispatchLabelVolumeChunkDelivery(client, band(), meta, EPOCHS)).toBe("other-plane");
    expect(client.labelSliceChunkData).not.toHaveBeenCalled();
    expect(client.labelVolumeChunkData).not.toHaveBeenCalled();
  });
});

describe("label chunk flow (3D): volume request → whole-chunk delivery → volume pool", () => {
  it("forwards the WHOLE 3D chunk (no plane extraction) and lands it with ids intact", () => {
    // 1. Volume-mode fetch plan: the 2x2x2 label is a single chunk. Masks are
    //    opt-in, so the single label is turned on explicitly.
    const reqs = computeLabelChunkRequests({ datasetId: "ds-0", manifest, t: 0, cut: { axis: "z", index: 0 }, mode: "volume", labelSettings: [{ visible: true, opacity: 0.5 }] });
    expect(reqs).toHaveLength(1);
    const req = reqs[0];
    expect(req.imageId).toBe("img-0:label:region-b");

    // 2. cpuCache yields the FULL 3D chunk (2x2x2 = 8 ids), incl. ids past 16 bits.
    const ids = new Uint32Array([10, 11, 12, 13, 92801, 92801 + 65536, 30, 4_294_967_295]);
    const delivery: ReadyChunkDelivery = {
      entityId: req.entityId,
      imageId: req.imageId,
      level: req.level,
      t: req.t, c: req.c, z: req.z, y: req.y, x: req.x,
      chunkKey: req.chunkKey,
      data: ids.buffer as ArrayBuffer,
      dataType: "Uint32",
      epochs: EPOCHS,
      lane: "detail",
      residencyTier: "detail",
      mode: "slice",
    };

    // 3. Delivery routing: the mock client forwards the message into the worker handler.
    const datasets = new Map<string, DatasetEntry>([
      ["ds-0", { manifest } as unknown as DatasetEntry],
    ]);
    const meta = buildManifestByImage(datasets).get("img-0:label:region-b");
    expect(meta?.isLabel).toBe(true);

    const writes: WriteTextureCall[] = [];
    const ctx = makeWorkerCtx(writes);
    const client = {
      labelVolumeChunkData: vi.fn((
        memberId: string,
        datasetId: string,
        chunks: { data: ArrayBuffer; dataType: string; x: number; y: number; z: number; key: string }[],
        level: number, t: number, c: number,
        levelWidth: number, levelHeight: number, levelDepth: number,
        chunkX: number, chunkY: number, chunkZ: number,
        epochs: SceneEpochs,
      ) => {
        const msg: LabelVolumeChunkDataMessage = {
          type: "labelVolumeChunkData",
          epochs, memberId, datasetId, chunks,
          level, t, c,
          levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ,
        };
        handleLabelVolumeChunkData(ctx, msg);
      }),
    } as unknown as UploadClient;

    const result = dispatchLabelVolumeChunkDelivery(client, delivery, meta!, EPOCHS);
    // The WHOLE chunk crosses (8 ids * 4 = 32 bytes) — never a single ~plane.
    expect(result).toEqual({ memberId: "img-0:label:region-b", bytes: 32 });
    // The delivery stamped the owning dataset id (from the ManifestEntry key).
    expect(vi.mocked(client.labelVolumeChunkData).mock.calls[0][1]).toBe("ds-0");

    // 4. The chunk landed in the volume pool sized to the label's own dims,
    //    stamped with the owning dataset for removal.
    const pool = ctx.state.labelVolumePools.get(labelVolumePoolKey("img-0:label:region-b", 0));
    expect(pool).toBeDefined();
    expect(pool!.width).toBe(2);
    expect(pool!.height).toBe(2);
    expect(pool!.depth).toBe(2);
    expect(pool!.datasetId).toBe("ds-0");

    // 5. All 8 ids reached the texture at full 32-bit width.
    expect(writes.length).toBeGreaterThan(0);
    const written = new Uint32Array(writes[0].buffer);
    expect(written[4]).toBe(92801);
    expect(written[5]).toBe(92801 + 65536);
    expect(written[7]).toBe(4_294_967_295);
  });
});
