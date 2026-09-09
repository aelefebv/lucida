/**
 * The strip draws every readout it is given, at the device pixel ratio it is
 * given. A recording context stands in for a canvas: what matters is which
 * text lands, not how the rasterizer paints it.
 */

import { describe, expect, it } from "vitest";

import { drawHud, hudHeight, LEVEL_ROWS_SHOWN } from "./hudDraw.ts";
import { FALLBACK, hudSample, RecordingContext } from "./hudFixtures.ts";
import { buildHudView, createHudHistory, pushSample, type HudSample } from "./hudModel.ts";

/** Two ticks of a busy pipeline: 1 MB and 1 kB across 250 ms. */
function busy(): HudSample[] {
  return [
    hudSample(0, { reading: { seq: 1, frameTimeUs: 6_000, gpuPassUs: 1_500 } }),
    hudSample(250, { bytesReceived: 1_000_000, bytesSent: 1_000, reading: { seq: 2, frameTimeUs: 6_000, gpuPassUs: 1_500 } }),
  ];
}

function viewAfter(samples: HudSample[]) {
  const history = createHudHistory();
  for (const s of samples) pushSample(history, s);
  return buildHudView(history);
}

function drawn(samples: HudSample[], width = 900) {
  const ctx = new RecordingContext();
  const view = viewAfter(samples);
  drawHud(ctx, view, { width, height: hudHeight(view, width), dpr: 1 });
  return ctx;
}

describe("drawHud", () => {
  it("scales to the device pixel ratio and paints the background", () => {
    const ctx = new RecordingContext();
    const view = viewAfter(busy());
    drawHud(ctx, view, { width: 900, height: hudHeight(view, 900), dpr: 2 });
    expect(ctx.transforms[0]).toEqual([2, 0, 0, 2, 0, 0]);
    expect(ctx.rects).toBeGreaterThan(0);
  });

  it("writes every readout's label so no state is a color alone", () => {
    const all = drawn(busy()).texts.join("\n");
    for (const expected of [
      "received",
      "sent",
      "frame (main thread)",
      "GPU pass",
      "4.0 MB/s",
      "4.0 kB/s",
      "6.0 ms",
      "within a frame",
      "main",
      "overview",
      "proxy",
      "GPU",
      "not reported",
      "detail",
      "working",
      "chunks in flight",
      "run open",
      "Example Discrete Adapter",
      "hardware adapter",
      "a.zarr",
      "coarser than target",
      "15 s rolling window · 250 ms tick",
    ]) {
      expect(all, `missing ${expected}`).toContain(expected);
    }
  });

  it("writes the fallback warning in words", () => {
    const texts = drawn([hudSample(0, { gpu: FALLBACK })]).texts;
    expect(texts).toContain("software fallback");
    expect(texts.some((t) => t.startsWith("warning: Software Raster"))).toBe(true);
  });

  it("writes the frame's state word next to its color", () => {
    const texts = drawn([hudSample(0, { reading: { seq: 1, frameTimeUs: 40_000, gpuPassUs: null } })]).texts;
    expect(texts).toContain("over two frames");
  });

  it("writes why a series is absent instead of drawing it as zero", () => {
    expect(drawn([hudSample(0)]).texts).toContain("no rate until a second sample");
  });

  it("stacks the columns when the strip is narrow, keeping every readout", () => {
    const view = viewAfter([hudSample(0)]);
    expect(hudHeight(view, 520)).toBeGreaterThan(hudHeight(view, 1000));
    const texts = drawn([hudSample(0)], 520).texts;
    for (const expected of ["main", "detail", "working", "Example Discrete Adapter", "a.zarr"]) {
      expect(texts.some((t) => t.includes(expected)), `missing ${expected}`).toBe(true);
    }
  });

  it("grows by one line per dataset up to the cap, then counts the rest", () => {
    const levels = Array.from({ length: LEVEL_ROWS_SHOWN + 2 }, (_, i) => ({
      datasetId: `d${i}`,
      name: `d${i}`,
      target: { min: 0, max: 0 },
      pinned: false,
      displayed: null,
    }));
    const one = viewAfter([hudSample(0)]);
    const many = viewAfter([hudSample(0, { levels })]);
    expect(hudHeight(many, 900)).toBeGreaterThan(hudHeight(one, 900));
    const texts = drawn([hudSample(0, { levels })]).texts;
    expect(texts).toContain("+2 more datasets");
    expect(texts).not.toContain(`d${LEVEL_ROWS_SHOWN}`);
  });

  it("draws an empty history without throwing", () => {
    const ctx = new RecordingContext();
    const view = buildHudView(createHudHistory());
    expect(() => drawHud(ctx, view, { width: 520, height: hudHeight(view, 520), dpr: 1 })).not.toThrow();
    expect(ctx.texts).toContain("unpublished");
  });
});
