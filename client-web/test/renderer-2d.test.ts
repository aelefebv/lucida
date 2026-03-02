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

    store.setPreview("src_fixture", 1, previewGen1, 1, 1);
    store.setPreview("src_fixture", 2, previewGen2, 1, 1);
    store.setTiles("src_fixture", 2, tileGen2, 1, 1);
    store.pruneOlderThan("src_fixture", 2);

    expect(Array.from(store.resolveFrame("src_fixture", 1) ?? [])).toEqual([]);
    expect(Array.from(store.resolveFrame("src_fixture", 2) ?? [])).toEqual(
      Array.from(tileGen2),
    );
  });

  it("progressively composites tile patches over preview fallback", () => {
    const store = new ProgressiveFrameStore();
    const preview = rgbaSamples([10, 10, 10, 10]);
    const leftTile = rgbaSamples([100, 100]);
    const rightTile = rgbaSamples([200, 200]);

    store.setPreview("src_fixture", 1, preview, 4, 1);
    store.composeTilePatch("src_fixture", 1, {
      canvasWidth: 4,
      canvasHeight: 1,
      offsetX: 0,
      offsetY: 0,
      width: 2,
      height: 1,
      rgba: leftTile,
    });

    expect(sampleRedChannel(store.resolveFrame("src_fixture", 1))).toEqual([
      100,
      100,
      10,
      10,
    ]);

    store.composeTilePatch("src_fixture", 1, {
      canvasWidth: 4,
      canvasHeight: 1,
      offsetX: 2,
      offsetY: 0,
      width: 2,
      height: 1,
      rgba: rightTile,
    });

    expect(sampleRedChannel(store.resolveFrame("src_fixture", 1))).toEqual([
      100,
      100,
      200,
      200,
    ]);
  });
});

function rgbaSamples(values: number[]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(values.length * 4);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function sampleRedChannel(rgba: Uint8ClampedArray | null): number[] {
  if (rgba === null) {
    return [];
  }
  const out: number[] = [];
  for (let offset = 0; offset < rgba.length; offset += 4) {
    out.push(rgba[offset] ?? 0);
  }
  return out;
}
