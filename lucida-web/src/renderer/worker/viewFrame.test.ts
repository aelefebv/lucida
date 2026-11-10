/**
 * A view draws in its own pixels: one that covers the canvas draws straight
 * onto it, one that covers part lands on its rectangle, and a probe reads the
 * view under the point.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { viewRectInPixels } from "../../renderLoopTypes.ts";
import { scaleRect } from "../../slicePath.ts";
import type { SliceRenderMultiPassMessage } from "../workerProtocol.ts";
import type { WorkerCtx } from "../workerContext.ts";
import { frameAt } from "./probe.ts";
import { createInitialState } from "./state.ts";
import { beginViewFrame, coversCanvas } from "./viewFrame.ts";

beforeAll(() => {
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 });
});

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

function frame(view: number, rect: [number, number, number, number]): SliceRenderMultiPassMessage {
  return { type: "sliceRenderMultiPass", epochs: EPOCHS, view, layers: [], zoom: 1, cx: 0, cy: 0, canvasW: 800, canvasH: 600, rect };
}

function makeCtx() {
  const canvasTexture = { format: "bgra8unorm" } as unknown as GPUTexture;
  const copies: unknown[][] = [];
  const created: GPUTextureDescriptor[] = [];
  const device = {
    createTexture: vi.fn((desc: GPUTextureDescriptor) => {
      created.push(desc);
      const [width, height] = desc.size as number[];
      return { width, height, format: desc.format, destroy: vi.fn() };
    }),
    createCommandEncoder: () => ({
      copyTextureToTexture: (...args: unknown[]) => copies.push(args),
      finish: () => ({}),
    }),
    queue: { submit: vi.fn() },
  };
  const canvas = { width: 0, height: 0 };
  const ctx = {
    device,
    context: { canvas, getCurrentTexture: () => canvasTexture },
    state: createInitialState(),
  } as unknown as WorkerCtx;
  return { ctx, canvas, canvasTexture, copies, created };
}

describe("a view's rectangle", () => {
  it("is the whole canvas exactly when it covers it", () => {
    for (const [w, h] of [[800, 600], [1599, 997], [3348, 1841]]) {
      expect(viewRectInPixels([0, 0, 1, 1], w, h)).toEqual([0, 0, w, h]);
      expect(scaleRect([0, 0, w, h], 0.37)).toEqual([0, 0, Math.round(w * 0.37), Math.round(h * 0.37)]);
    }
  });

  it("tiles the canvas's pixels when views tile the canvas", () => {
    const left = viewRectInPixels([0, 0, 0.5, 1], 801, 600);
    const right = viewRectInPixels([0.5, 0, 0.5, 1], 801, 600);
    expect(left[0] + left[2]).toBe(right[0]);
    expect(right[0] + right[2]).toBe(801);
  });
});

describe("a view's frame", () => {
  it("draws straight onto the canvas when the view covers it", () => {
    const { ctx, canvas, canvasTexture, copies } = makeCtx();
    const target = beginViewFrame(ctx, 0, 800, 600, [0, 0, 800, 600]);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(target.texture).toBe(canvasTexture);
    target.land();
    expect(copies).toHaveLength(0);
  });

  it("lands on its rectangle when the view covers part of the canvas", () => {
    const { ctx, canvasTexture, copies, created } = makeCtx();
    const target = beginViewFrame(ctx, 1, 800, 600, [400, 0, 400, 600]);
    expect(target.texture).not.toBe(canvasTexture);
    expect(created[0].size).toEqual([400, 600]);
    target.land();
    expect(copies).toEqual([[
      { texture: target.texture },
      { texture: canvasTexture, origin: { x: 400, y: 0 } },
      { width: 400, height: 600 },
    ]]);
    // The next frame of the view reuses its target.
    expect(beginViewFrame(ctx, 1, 800, 600, [400, 0, 400, 600]).texture).toBe(target.texture);
    expect(coversCanvas([400, 0, 400, 600], 800, 600)).toBe(false);
  });
});

describe("a probe", () => {
  it("reads a view that covers the canvas at the point as given", () => {
    const whole = frame(0, [0, 0, 800, 600]);
    expect(frameAt([whole], 0.3, 0.7)).toEqual({ frame: whole, x: 0.3, y: 0.7 });
  });

  it("reads the view under the point, in that view's pixels", () => {
    const left = frame(0, [0, 0, 400, 600]);
    const right = frame(1, [400, 0, 400, 600]);
    const hit = frameAt([left, right], 0.75, 0.5)!;
    expect(hit.frame.view).toBe(1);
    expect([hit.frame.canvasW, hit.frame.canvasH]).toEqual([400, 600]);
    expect([hit.x, hit.y]).toEqual([0.5, 0.5]);
    expect(frameAt([left], 0.75, 0.5)).toBeNull();
  });
});
