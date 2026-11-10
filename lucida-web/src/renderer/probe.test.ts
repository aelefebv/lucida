import { describe, expect, it } from "vitest";
import {
  clipPlaneHit,
  levelZeroPosition,
  locateSample,
  marchSamples,
  marchSpan,
  pickIntensitySample,
  pickLabelSample,
  sliceHits,
  texelValue,
  type MarchedValue,
  type ProbeAtlas,
} from "./probe.ts";
import { INDIRECTION_FAILED, INDIRECTION_MISS } from "./remap.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";
import type { SliceRenderMultiPassMessage, VolumeRenderMultiPassMessage } from "./workerProtocol.ts";

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

/** A pool with `cells` indirection entries, all missing until set. */
function atlas(cells: number, slots: [number, number, number?]): ProbeAtlas & { indirectionData: Uint32Array } {
  return {
    indirectionData: new Uint32Array(cells).fill(INDIRECTION_MISS),
    slotsX: slots[0],
    slotsY: slots[1],
    slotsZ: slots[2],
  };
}

/** A 2D section: a level `[height, width]` big in `[8, 8]` chunks. */
function section2d(level: number, dims: [number, number], offset = 0): LodIndirectionMeta {
  const [h, w] = dims;
  return {
    level,
    levelDims: [1, h, w],
    chunkDims: [1, 8, 8],
    gridDims: [1, Math.ceil(h / 8), Math.ceil(w / 8)],
    offset,
  };
}

describe("locateSample", () => {
  it("finds the texel a slice shader reads: the chunk's slot, then the sample inside it", () => {
    const pool = atlas(25, [4, 2]);
    // Level 0 is 40x40 in 8x8 chunks; the chunk at grid (x 2, y 1) sits in slot 6.
    pool.indirectionData[1 * 5 + 2] = 6;
    const hit = locateSample([{ meta: section2d(0, [40, 40]), atlas: pool }], null, [19.5 / 40, 12.5 / 40], "slice");
    // Slot 6 is column 2, row 1 of a 4-wide slot grid; the sample is (3, 4) inside the chunk.
    expect(hit).toEqual({ kind: "resident", level: 0, atlas: pool, texel: [2 * 8 + 3, 1 * 8 + 4, 0] });
  });

  it("walks the level sources finest first, then the coarse tier, as the shader does", () => {
    const fine = atlas(25, [4, 4]);
    const coarser = atlas(9, [4, 4]);
    const coarse = atlas(4, [4, 4]);
    const sources = [
      { meta: section2d(0, [40, 40]), atlas: fine },
      { meta: section2d(1, [20, 20]), atlas: coarser },
    ];
    const coarseSource = { meta: section2d(2, [10, 10]), atlas: coarse };
    const uv = [0.1, 0.1];

    expect(locateSample(sources, coarseSource, uv, "slice")).toEqual({ kind: "missing" });
    coarse.indirectionData[0] = 1;
    expect(locateSample(sources, coarseSource, uv, "slice")).toMatchObject({ kind: "resident", level: 2 });
    coarser.indirectionData[0] = 2;
    expect(locateSample(sources, coarseSource, uv, "slice")).toMatchObject({ kind: "resident", level: 1, atlas: coarser });
    fine.indirectionData[0] = 3;
    expect(locateSample(sources, coarseSource, uv, "slice")).toMatchObject({ kind: "resident", level: 0, atlas: fine });
  });

  it("stops at a failed chunk, as the shader draws its hatch rather than a coarser level", () => {
    const fine = atlas(25, [4, 4]);
    const coarser = atlas(9, [4, 4]);
    fine.indirectionData[0] = INDIRECTION_FAILED;
    coarser.indirectionData[0] = 0;
    const sources = [
      { meta: section2d(0, [40, 40]), atlas: fine },
      { meta: section2d(1, [20, 20]), atlas: coarser },
    ];
    expect(locateSample(sources, null, [0.05, 0.05], "slice")).toEqual({ kind: "failed", level: 0 });
  });

  it("misses through a source whose draw binds no pool", () => {
    const coarser = atlas(9, [4, 4]);
    coarser.indirectionData[0] = 0;
    const sources = [
      { meta: section2d(0, [40, 40]), atlas: null },
      { meta: section2d(1, [20, 20]), atlas: coarser },
    ];
    expect(locateSample(sources, null, [0.05, 0.05], "slice")).toMatchObject({ kind: "resident", level: 1 });
  });

  it("reads a section at its offset in a shared indirection", () => {
    const pool = atlas(30, [4, 4]);
    pool.indirectionData[5] = 1;
    expect(locateSample([{ meta: section2d(0, [8, 8], 5), atlas: pool }], null, [0.5, 0.5], "slice"))
      .toMatchObject({ kind: "resident", texel: [8 + 4, 4, 0] });
  });

  it("flips Y and places the brick in a 3D slot grid in a volume pool", () => {
    const pool = atlas(8, [2, 2, 2]);
    const meta: LodIndirectionMeta = {
      level: 1,
      levelDims: [16, 16, 16],
      chunkDims: [8, 8, 8],
      gridDims: [2, 2, 2],
      offset: 0,
    };
    // The local point (0.75, 0.25, 0.75) is sample (12, 12, 12): Y runs up in the cube.
    pool.indirectionData[1 * 4 + 1 * 2 + 1] = 5;
    const hit = locateSample([{ meta, atlas: pool }], null, [0.78, 0.22, 0.78], "volume");
    // Slot 5 in a 2x2x2 grid is (1, 0, 1).
    expect(hit).toEqual({ kind: "resident", level: 1, atlas: pool, texel: [8 + 4, 0 + 4, 8 + 4] });
  });
});

describe("levelZeroPosition", () => {
  it("names the level-0 sample under a point, with the volume's Y running up", () => {
    expect(levelZeroPosition([19.5 / 40, 12.5 / 40], [1, 40, 40], "slice")).toEqual([19, 12, 0]);
    expect(levelZeroPosition([0.99, 0.99], [1, 40, 40], "slice")).toEqual([39, 39, 0]);
    expect(levelZeroPosition([0.1, 0.9, 0.5], [32, 64, 64], "volume")).toEqual([6, 6, 16]);
  });
});

function sliceFrame(overrides: Partial<SliceRenderMultiPassMessage> = {}): SliceRenderMultiPassMessage {
  return {
    type: "sliceRenderMultiPass",
    epochs: EPOCHS,
    layers: [],
    zoom: 2,
    cx: 20,
    cy: 20,
    view: 0,
    canvasW: 100,
    canvasH: 80,
    rect: [0, 0, 100, 80],
    ...overrides,
  };
}

describe("sliceHits", () => {
  const none = () => undefined;

  it("finds each member under the point at the UV of the pixel center it covers", () => {
    const frame = sliceFrame({
      layers: [
        { datasetId: "img:ch0", dataW: 40, dataH: 40, blendMode: "additive", entityIndex: 0 },
        { datasetId: "img:ch1", dataW: 40, dataH: 40, blendMode: "additive", entityIndex: 1 },
      ],
    });
    // Canvas pixel (60, 30) has its center at (60.5, 30.5): data (25.25, 15.25) at zoom 2 about (20, 20).
    const hits = sliceHits(frame, 60.2 / 100, 30.9 / 80, none);
    expect(hits.map((h) => h.memberId)).toEqual(["img:ch0", "img:ch1"]);
    expect(hits[0].uv[0]).toBeCloseTo(25.25 / 40);
    expect(hits[0].uv[1]).toBeCloseTo(15.25 / 40);
  });

  it("finds a label overlay under the point across the extent its quad spans", () => {
    const frame = sliceFrame({
      layers: [
        { datasetId: "img:ch0", dataW: 40, dataH: 40, blendMode: "additive", entityIndex: 0 },
        // A label covering 20x20 level-0 samples of its source, placed at (10, 10).
        { datasetId: "img:label:regions", dataW: 20, dataH: 20, offsetX: 10, offsetY: 10, blendMode: "alpha", entityIndex: 0, entityId: "e", isLabel: true },
      ],
    });
    const [image, label] = sliceHits(frame, 60.2 / 100, 30.9 / 80, none);
    expect(image.label).toBeUndefined();
    expect(label.memberId).toBe("img:label:regions");
    expect(label.label).toEqual({ entityId: "e", dataW: 20, dataH: 20 });
    expect(label.uv[0]).toBeCloseTo((25.25 - 10) / 20);
    expect(label.uv[1]).toBeCloseTo((15.25 - 10) / 20);
    // At data (5.25, 5.25), off the label's footprint, only the image is under the point.
    expect(sliceHits(frame, 20.2 / 100, 10.9 / 80, none).map((h) => h.memberId)).toEqual(["img:ch0"]);
  });

  it("is the same point at any render resolution of the same view", () => {
    const layers = [{ datasetId: "img:ch0", dataW: 40, dataH: 40, blendMode: "additive" as const, entityIndex: 0 }];
    const one = sliceHits(sliceFrame({ layers }), 0.6, 0.4, none)[0].uv;
    const two = sliceHits(sliceFrame({ layers, zoom: 4, canvasW: 200, canvasH: 160 }), 0.6, 0.4, none)[0].uv;
    expect(two[0]).toBeCloseTo(one[0], 2);
    expect(two[1]).toBeCloseTo(one[1], 2);
  });

  it("misses a member the point is off, and places an offset member", () => {
    const frame = sliceFrame({
      layers: [
        { datasetId: "a:ch0", dataW: 10, dataH: 10, blendMode: "additive", entityIndex: 0 },
        { datasetId: "b:ch0", dataW: 10, dataH: 10, offsetX: 20, offsetY: 15, blendMode: "additive", entityIndex: 1 },
      ],
    });
    const hits = sliceHits(frame, 0.5, 0.5, none);
    expect(hits.map((h) => h.memberId)).toEqual(["b:ch0"]);
    expect(hits[0].uv[0]).toBeCloseTo(0.025);
  });

  it("finds the aggregate member whose quad holds the point", () => {
    const quads = new ArrayBuffer(2 * 32);
    const f32 = new Float32Array(quads);
    const u32 = new Uint32Array(quads);
    f32.set([0, 0, 0.5, 1], 0);
    u32[4] = 7;
    f32.set([0.5, 0, 0.5, 1], 8);
    u32[12] = 9;
    const frame = sliceFrame({
      layers: [{
        datasetId: "agg",
        dataW: 40,
        dataH: 40,
        blendMode: "additive",
        entityIndex: 0,
        aggregate: { poolMemberId: "pool", count: 2, quads },
      }],
    });
    const hits = sliceHits(frame, 0.6, 0.5, (pool, index) => `${pool}#${index}`);
    expect(hits.map((h) => h.memberId)).toEqual(["pool#9"]);
    // Data x 25.25 is 0.63125 of the layer, a quarter-and-a-bit into the second quad.
    expect(hits[0].uv[0]).toBeCloseTo((25.25 / 40 - 0.5) / 0.5, 5);
  });
});

/** A camera looking down +Z at a cube of world side 1 centered on the origin, with NDC as world. */
function volumeFrame(clipDistance: number, clipMode = 0): VolumeRenderMultiPassMessage {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    type: "volumeRenderMultiPass",
    epochs: EPOCHS,
    layers: [],
    invViewProj: identity,
    eye: new Float32Array([0, 0, -1]),
    camForward: new Float32Array([0, 0, 1]),
    view: 0,
    canvasW: 100,
    canvasH: 100,
    rect: [0, 0, 100, 100],
    fullW: 100,
    fullH: 100,
    clipDistance,
    clipMode,
  };
}

/** World to the cube's local [0,1]^3: shift by a half. */
const INV_MODEL = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0.5, 0.5, 1]);

describe("clipPlaneHit", () => {
  it("is where the ray meets the clip plane inside the entity", () => {
    // The plane sits 0.9 in front of the eye at z -1: world z -0.1, local 0.4.
    // Canvas pixel (60, 40) has its center at NDC (0.21, 0.19).
    const hit = clipPlaneHit(volumeFrame(0.9), 0.6, 0.4, INV_MODEL);
    expect(hit).not.toBeNull();
    const [x, y, z] = hit!;
    expect(x).toBeCloseTo(0.71, 5);
    expect(y).toBeCloseTo(0.69, 5);
    expect(z).toBeCloseTo(0.4, 5);
  });

  it("is nothing without a plane-mode clip plane, or where the plane misses the entity", () => {
    expect(clipPlaneHit(volumeFrame(0), 0.5, 0.5, INV_MODEL)).toBeNull();
    expect(clipPlaneHit(volumeFrame(0.9, 1), 0.5, 0.5, INV_MODEL)).toBeNull();
    // In front of the cube, the march starts at its face, not the plane.
    expect(clipPlaneHit(volumeFrame(0.3), 0.5, 0.5, INV_MODEL)).toBeNull();
    // Behind it, nothing is drawn.
    expect(clipPlaneHit(volumeFrame(1.7), 0.5, 0.5, INV_MODEL)).toBeNull();
  });
});

describe("marchSpan", () => {
  it("runs from where the ray enters the cube, or leaves the clip, to where it leaves", () => {
    // The center pixel's ray runs down +Z from local z -0.5: it enters at t 0.5 and leaves at 1.5.
    const open = marchSpan(volumeFrame(0), 0.5, 0.5, INV_MODEL)!;
    expect(open.tStart).toBeCloseTo(0.5, 5);
    expect(open.tEnd).toBeCloseTo(1.5, 5);
    expect(open.rd[2]).toBeCloseTo(1, 5);
    // The clip plane 0.9 ahead of the eye and the sphere of that radius both start it at t 0.9.
    expect(marchSpan(volumeFrame(0.9), 0.5, 0.5, INV_MODEL)!.tStart).toBeCloseTo(0.9, 5);
    expect(marchSpan(volumeFrame(0.9, 1), 0.5, 0.5, INV_MODEL)!.tStart).toBeCloseTo(0.9, 3);
    // A clip in front of the cube changes nothing.
    expect(marchSpan(volumeFrame(0.3), 0.5, 0.5, INV_MODEL)!.tStart).toBeCloseTo(0.5, 5);
  });

  it("is nothing where the ray misses the cube or the clip leaves none of it", () => {
    expect(marchSpan(volumeFrame(0), 0.99, 0.5, INV_MODEL)).toBeNull();
    expect(marchSpan(volumeFrame(1.7), 0.5, 0.5, INV_MODEL)).toBeNull();
  });
});

describe("marchSamples", () => {
  /** A cubic level `size` samples on a side in 8-sample bricks, every brick resident in its own slot. */
  function resident(level: number, size: number): { meta: LodIndirectionMeta; atlas: ReturnType<typeof atlas> } {
    const grid = size / 8;
    const pool = atlas(grid ** 3, [grid, grid, grid]);
    pool.indirectionData.forEach((_, i) => (pool.indirectionData[i] = i));
    return {
      meta: { level, levelDims: [size, size, size], chunkDims: [8, 8, 8], gridDims: [grid, grid, grid], offset: 0 },
      atlas: pool,
    };
  }
  const span = () => marchSpan(volumeFrame(0), 0.5, 0.5, INV_MODEL)!;

  it("steps by two thirds of a sample of the level that answers, as the shader marches", () => {
    const steps = marchSamples([resident(0, 16)], null, span(), 512);
    // 16 samples deep, stepped every 1/24 of the cube. In float32 the 24 steps
    // fall just short of the exit, so a 25th reads the far face.
    expect(steps).toHaveLength(25);
    const depths = steps.map(({ pos, location }, k) => {
      expect(pos[2]).toBeCloseTo(k / 24, 5);
      expect(location).toMatchObject({ kind: "resident", level: 0 });
      return location.kind === "resident" ? location.texel[2] : -1;
    });
    // Front to back, and no sample stepped over.
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(new Set(depths)).toEqual(new Set(Array.from({ length: 16 }, (_, z) => z)));
  });

  it("steps by the coarse tier where it answers, and across each chunk cell where nothing does", () => {
    const fine = resident(0, 32);
    fine.atlas.indirectionData.fill(INDIRECTION_MISS);
    const coarse = resident(2, 8);
    expect(marchSamples([fine], coarse, span(), 512).map((s) => s.location.kind))
      .toEqual(new Array(12).fill("resident"));
    // Four 8-sample cells deep: one sample in each, just past its near face.
    const nothing = marchSamples([fine], null, span(), 512);
    expect(nothing.map((s) => s.location.kind)).toEqual(new Array(4).fill("missing"));
    nothing.forEach(({ pos }, k) => expect(pos[2]).toBeCloseTo(k / 4, 4));
  });

  it("steps by the finest level after a miss, never over a resident chunk of it", () => {
    // The second of the four cells is resident: the march lands at its near
    // face and reads all of it before skipping the rest.
    const fine = resident(0, 32);
    const grid = 4;
    const centre = (z: number) => z * grid * grid + 2 * grid + 2;
    for (let z = 0; z < grid; z++) if (z !== 1) fine.atlas.indirectionData[centre(z)] = INDIRECTION_MISS;
    const steps = marchSamples([fine], null, span(), 512);
    const read = steps.filter((s) => s.location.kind === "resident");
    expect(read.length).toBe(12);
    expect(read[0].pos[2]).toBeCloseTo(0.25, 4);
    expect(steps.filter((s) => s.location.kind === "missing")).toHaveLength(3);
  });

  it("never takes more steps than its budget, however fine the level", () => {
    expect(marchSamples([resident(0, 512)], null, span(), 256)).toHaveLength(256);
  });
});

describe("pickIntensitySample", () => {
  const window = { contrastMin: 100, contrastMax: 1100, gamma: 1 };

  it("names the first sample a translucent pixel counts as its surface", () => {
    // 105 normalizes to 0.005, under the depth threshold; 120 to 0.02, over it.
    const values: MarchedValue[] = ["missing", 0, "failed", 105, 120, 900];
    expect(pickIntensitySample(values, window, "u16", "translucent")).toBe(4);
    // Gamma 2 takes 120 to 0.0004, so the first past the threshold is 900.
    expect(pickIntensitySample(values, { ...window, gamma: 2 }, "u16", "translucent")).toBe(5);
    expect(pickIntensitySample([0, 50, 100], window, "u16", "translucent")).toBe(-1);
  });

  it("counts a float zero inside the window, and never a NaN", () => {
    const below = { contrastMin: -1, contrastMax: 1, gamma: 1 };
    expect(pickIntensitySample([Number.NaN, 0], below, "f32", "translucent")).toBe(1);
    expect(pickIntensitySample([Number.NaN, 0], below, "u16", "translucent")).toBe(-1);
  });

  it("names a MIP pixel's brightest sample, the first to reach it, before the march stops early", () => {
    expect(pickIntensitySample([200, 700, 300, 700], window, "u16", "max_intensity")).toBe(1);
    // 1090 normalizes to 0.99, past the early stop, so the brighter 5000 behind it is never read.
    expect(pickIntensitySample([200, 1090, 5000], window, "u16", "max_intensity")).toBe(1);
    // Nothing above the window's floor draws.
    expect(pickIntensitySample([50, 100, "missing"], window, "u16", "max_intensity")).toBe(-1);
  });
});

describe("pickLabelSample", () => {
  it("names the first id along the ray that isn't background, or the failed chunk it stops at", () => {
    expect(pickLabelSample([0, "missing", 0, 5, 7])).toBe(3);
    expect(pickLabelSample([0, "failed", 5])).toBe(1);
    expect(pickLabelSample([0, "missing", 0])).toBe(-1);
  });
});

describe("texelValue", () => {
  it("reads a u16 texel as its integer and an f32 texel as the float its bits hold", () => {
    expect(texelValue(65535, "u16")).toBe(65535);
    expect(texelValue(0xc0200000, "f32")).toBe(-2.5);
    expect(texelValue(0x7fc00000, "f32")).toBeNaN();
  });
});
