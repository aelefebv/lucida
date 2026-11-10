/**
 * A view draws in its own pixels: one that covers the canvas draws straight
 * onto it, one that covers part keeps a frame that each present lands on its
 * rectangle, and a probe reads the view under the point.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { viewRectInPixels } from "../../renderLoopTypes.ts";
import { scaleRect } from "../../slicePath.ts";
import type { SliceRenderMultiPassMessage } from "../workerProtocol.ts";
import type { WorkerCtx } from "../workerContext.ts";
import { frameAt } from "./probe.ts";
import { createInitialState } from "./state.ts";
import { beginViewFrame, coversCanvas, handlePresentViews } from "./viewFrame.ts";

beforeAll(() => {
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 });
});

const EPOCHS = { content: 1, layout: 1, view: 1, selection: 1, request: 1 };

function frame(view: number, rect: [number, number, number, number]): SliceRenderMultiPassMessage {
  return { type: "sliceRenderMultiPass", epochs: EPOCHS, view, layers: [], zoom: 1, cx: 0, cy: 0, canvasW: 800, canvasH: 600, rect };
}

function makeCtx() {
  const canvasTexture = { format: "bgra8unorm", createView: () => ({}) } as unknown as GPUTexture;
  const created: GPUTextureDescriptor[] = [];
  const landed: unknown[] = [];
  const device = {
    createTexture: vi.fn((desc: GPUTextureDescriptor) => {
      created.push(desc);
      const [width, height] = desc.size as number[];
      return { width, height, format: desc.format, destroy: vi.fn(), createView: () => ({}) };
    }),
    createCommandEncoder: () => ({ finish: () => ({}) }),
    queue: { submit: vi.fn() },
  };
  const canvas = { width: 0, height: 0 };
  const lander = {
    compiled: Promise.resolve(),
    land: (_canvas: unknown, views: unknown) => landed.push(views),
  };
  const ctx = {
    device,
    format: "bgra8unorm",
    context: { canvas, getCurrentTexture: () => canvasTexture },
    getViewLander: () => lander,
    state: createInitialState(),
  } as unknown as WorkerCtx;
  return { ctx, canvas, canvasTexture, created, landed };
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
    const { ctx, canvas, canvasTexture } = makeCtx();
    const target = beginViewFrame(ctx, 0, 800, 600, [0, 0, 800, 600]);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(target.texture).toBe(canvasTexture);
    expect(target.canvasTexture).toBe(canvasTexture);
  });

  it("keeps its own frame when the view covers part of the canvas, until the views are presented", async () => {
    const { ctx, canvas, canvasTexture, created, landed } = makeCtx();
    const right = beginViewFrame(ctx, 1, 800, 600, [400, 0, 400, 600]);
    expect(right.canvasTexture).toBeNull();
    expect(right.texture).not.toBe(canvasTexture);
    expect(created[0].size).toEqual([400, 600]);
    // Untouched until the present, which lands every view's kept frame.
    expect(canvas.width).toBe(0);
    const left = beginViewFrame(ctx, 0, 800, 600, [0, 0, 400, 600]);
    await handlePresentViews(ctx, {
      type: "presentViews",
      canvasW: 800,
      canvasH: 600,
      views: [{ view: 0, rect: [0, 0, 400, 600] }, { view: 1, rect: [400, 0, 400, 600] }],
    });
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(landed).toEqual([[
      { frame: left.texture, rect: [0, 0, 400, 600] },
      { frame: right.texture, rect: [400, 0, 400, 600] },
    ]]);
    // The next frame of the view reuses its frame.
    expect(beginViewFrame(ctx, 1, 800, 600, [400, 0, 400, 600]).texture).toBe(right.texture);
    expect(coversCanvas([400, 0, 400, 600], 800, 600)).toBe(false);
  });

  it("lets a view's resources go once the page no longer has it", async () => {
    const { ctx } = makeCtx();
    const gone = beginViewFrame(ctx, 1, 800, 600, [400, 0, 400, 600]);
    beginViewFrame(ctx, 0, 800, 600, [0, 0, 400, 600]);
    await handlePresentViews(ctx, { type: "presentViews", canvasW: 800, canvasH: 600, views: [{ view: 0, rect: [0, 0, 800, 600] }] });
    expect(gone.texture.destroy).toHaveBeenCalled();
    expect(ctx.state.viewResources.has(1)).toBe(false);
    // A view across the canvas again is the only one, and keeps no frame.
    beginViewFrame(ctx, 0, 800, 600, [0, 0, 800, 600]);
    expect(ctx.state.viewResources.get(0)?.frame ?? null).toBeNull();
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
