import { describe, expect, it } from "vitest";

import { ProgressiveFrameStore, composite2d } from "../src/renderer-2d";

describe("2D compositing renderer", () => {
  it("composites multi-channel tiles with additive blending", () => {
    const rgba = composite2d(
      1,
      1,
      [
        {
          channelIndex: 0,
          pixels: new Uint8Array([255]),
          color: [1, 0, 0],
          enabled: true,
          contrast: 1,
          gamma: 1,
        },
        {
          channelIndex: 1,
          pixels: new Uint8Array([255]),
          color: [0, 1, 0],
          enabled: true,
          contrast: 1,
          gamma: 1,
        },
      ],
      "additive",
    );

    expect(Array.from(rgba)).toEqual([255, 255, 0, 255]);
  });

  it("applies contrast and gamma mapping", () => {
    const rgba = composite2d(
      1,
      1,
      [
        {
          channelIndex: 0,
          pixels: new Uint8Array([64]),
          color: [1, 1, 1],
          enabled: true,
          contrast: 2,
          gamma: 2,
        },
      ],
      "normal",
    );

    expect(rgba[0]).toBeGreaterThan(64);
    expect(rgba[3]).toBe(255);
  });

  it("prefers quantitative tile frames over previews without mixing generations", () => {
    const store = new ProgressiveFrameStore();
    const previewGen1 = new Uint8ClampedArray([10, 10, 10, 255]);
    const previewGen2 = new Uint8ClampedArray([20, 20, 20, 255]);
    const tileGen2 = new Uint8ClampedArray([200, 200, 200, 255]);

    store.setPreview(1, previewGen1);
    store.setPreview(2, previewGen2);
    store.setTiles(2, tileGen2);
    store.pruneOlderThan(2);

    expect(Array.from(store.resolveFrame(1) ?? [])).toEqual([]);
    expect(Array.from(store.resolveFrame(2) ?? [])).toEqual(Array.from(tileGen2));
  });
});
