import { describe, expect, it } from "vitest";
import { batchLayers, type BatchLayer, type PixelRect } from "./layerBatches.ts";

const tile = (x: number, y: number, size = 10): PixelRect => [x, y, size, size];

function layer(rect: PixelRect | null, blendMode: BatchLayer["blendMode"] = "additive", alone = false): BatchLayer {
  return { rect, blendMode, alone };
}

/** Composite the layers in order, each a constant inside its rect, onto a canvas of `w` × `h`. */
function composite(layers: readonly BatchLayer[], values: readonly number[], w: number, h: number): number[] {
  const out = new Array<number>(w * h).fill(0);
  layers.forEach((l, i) => {
    const [x, y, rw, rh] = l.rect ?? [0, 0, w, h];
    for (let py = Math.max(0, y); py < Math.min(h, y + rh); py++) {
      for (let px = Math.max(0, x); px < Math.min(w, x + rw); px++) {
        const at = py * w + px;
        // Order-sensitive on purpose: a swapped pair of overlapping layers shows.
        out[at] = out[at] * 0.5 + values[i];
      }
    }
  });
  return out;
}

describe("batchLayers", () => {
  it("puts a grid of tiles of one channel in one batch", () => {
    const layers = [0, 10, 20].flatMap((y) => [0, 10, 20].map((x) => layer(tile(x, y))));

    expect(batchLayers(layers, 30, 30)).toEqual([
      { layers: [0, 1, 2, 3, 4, 5, 6, 7, 8], blendMode: "additive", alone: false },
    ]);
  });

  it("draws each channel of a grid in a batch of its own, the channels in their order", () => {
    // Member by member, channel by channel, as the views list them.
    const layers = [0, 10, 20].flatMap((x) => [layer(tile(x, 0)), layer(tile(x, 0))]);

    expect(batchLayers(layers, 30, 10)).toEqual([
      { layers: [0, 2, 4], blendMode: "additive", alone: false },
      { layers: [1, 3, 5], blendMode: "additive", alone: false },
    ]);
  });

  it("keeps tiles that share a pixel column apart", () => {
    const layers = [layer([0, 0, 11, 10]), layer([10, 0, 10, 10]), layer([20, 0, 10, 10])];

    expect(batchLayers(layers, 30, 10).map((b) => b.layers)).toEqual([[0, 2], [1]]);
  });

  it("splits a level by blend mode", () => {
    const layers = [layer(tile(0, 0), "alpha"), layer(tile(10, 0), "max"), layer(tile(20, 0), "alpha")];

    expect(batchLayers(layers, 30, 10)).toEqual([
      { layers: [0, 2], blendMode: "alpha", alone: false },
      { layers: [1], blendMode: "max", alone: false },
    ]);
  });

  it("orders a whole-target layer between the layers around it", () => {
    const layers = [layer(tile(0, 0)), layer(null), layer(tile(10, 0)), layer([0, 0, 30, 10])];

    expect(batchLayers(layers, 30, 10).map((b) => b.layers)).toEqual([[0], [1], [2], [3]]);
  });

  it("draws a layer marked alone in a batch of its own, even beside layers it does not meet", () => {
    const layers = [layer(tile(0, 0)), layer(tile(10, 0), "alpha", true), layer(tile(20, 0))];

    expect(batchLayers(layers, 30, 10)).toEqual([
      { layers: [0], blendMode: "additive", alone: false },
      { layers: [1], blendMode: "alpha", alone: true },
      { layers: [2], blendMode: "additive", alone: false },
    ]);
  });

  it("composites the same pixels batched as one layer at a time, for scattered overlapping rects", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const w = 200;
    const h = 120;
    for (let round = 0; round < 20; round++) {
      const layers: BatchLayer[] = [];
      for (let i = 0; i < 60; i++) {
        const rw = 1 + Math.floor(random() * 40);
        const rh = 1 + Math.floor(random() * 40);
        layers.push(layer([Math.floor(random() * (w - rw)), Math.floor(random() * (h - rh)), rw, rh]));
      }
      const values = layers.map((_, i) => i + 1);
      const batched = batchLayers(layers, w, h).flatMap((batch) => {
        // Inside a batch no two rects meet, so their order cannot matter.
        const rects = batch.layers.map((i) => layers[i].rect!);
        for (let a = 0; a < rects.length; a++) {
          for (let b = a + 1; b < rects.length; b++) {
            const [ax, ay, aw, ah] = rects[a];
            const [bx, by, bw, bh] = rects[b];
            expect(ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah).toBe(false);
          }
        }
        return batch.layers;
      });

      expect(batched.slice().sort((a, b) => a - b)).toEqual(layers.map((_, i) => i));
      expect(composite(batched.map((i) => layers[i]), batched.map((i) => values[i]), w, h))
        .toEqual(composite(layers, values, w, h));
    }
  });
});
