import { beforeEach, describe, expect, it } from "vitest";

import type { MinimapOverlayData } from "../renderLoopTypes.ts";
import {
  drawDynamicMinimapOverlays,
  drawViewportOverlays,
  drawZPlaneOverlays,
  zPlaneLayerDirty,
} from "./minimapOverlay.ts";

type Op = { type: "call"; name: string; args: unknown[] } | { type: "set"; name: string; value: unknown };

/**
 * A canvas 2D context stand-in that records every method call and property
 * assignment in order. The overlay drawing functions only ever write to the
 * context (never read a property back), so recording sets + calls captures the
 * complete, ordered draw program.
 */
function recordingCtx(log: Op[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        return (...args: unknown[]) => {
          log.push({ type: "call", name: String(prop), args });
        };
      },
      set(_t, prop, value) {
        log.push({ type: "set", name: String(prop), value });
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function identity(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function makeData(mode: "slice" | "volume", overrides: Partial<MinimapOverlayData> = {}): MinimapOverlayData {
  const model = identity();
  return {
    viewProj: identity(),
    layers: [
      { datasetId: "ds", modelMatrix: model, invModelMatrix: model },
      { datasetId: "ds", modelMatrix: model, invModelMatrix: model },
    ],
    datasetLayers: [
      { datasetId: "ds", modelMatrix: model, invModelMatrix: model, width: 500, height: 500, depth: 9 },
    ],
    sliceViewports: [
      {
        datasetId: "ds",
        memberId: "m0",
        modelMatrix: model,
        bounds: { minX: 10, minY: 20, maxX: 100, maxY: 120 },
        width: 500,
        height: 500,
        depth: 9,
      },
      {
        datasetId: "ds",
        memberId: "m1",
        modelMatrix: model,
        bounds: { minX: 30, minY: 40, maxX: 130, maxY: 140 },
        width: 500,
        height: 500,
        depth: 9,
      },
    ],
    mode,
    cameraViewRotation: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    canvasW: 400,
    canvasH: 400,
    currentZ: 3,
    datasetDims: new Map([["ds", { width: 500, height: 500, depth: 9 }]]),
    mainInvViewProj: identity(),
    staticDirty: false,
    ...overrides,
  };
}

describe("dynamic overlay split", () => {
  beforeEach(() => {
    globalThis.devicePixelRatio = 2;
  });

  for (const mode of ["slice", "volume"] as const) {
    it(`drawZPlaneOverlays + drawViewportOverlays is byte-identical to drawDynamicMinimapOverlays (${mode} mode)`, () => {
      const data = makeData(mode);

      const combined: Op[] = [];
      drawDynamicMinimapOverlays(recordingCtx(combined), data);

      const split: Op[] = [];
      const ctx = recordingCtx(split);
      drawZPlaneOverlays(ctx, data);
      drawViewportOverlays(ctx, data);

      expect(split).toEqual(combined);
      // The split must actually exercise draw ops, not trivially match by both
      // being empty (slice viewport geometry / the volume cube is non-trivial).
      expect(combined.length).toBeGreaterThan(0);
    });
  }

  it("drawZPlaneOverlays draws only the Z-plane sub-layer in slice mode and does not clear", () => {
    const log: Op[] = [];
    drawZPlaneOverlays(recordingCtx(log), makeData("slice"));

    // No canvas clear (the consumer owns clearing the cache canvas).
    expect(log.some((op) => op.type === "call" && op.name === "clearRect")).toBe(false);
    // Slice planes fill with the plane color; viewport rects and the cube are NOT here.
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === "rgba(255,200,50,0.25)")).toBe(true);
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === "rgba(100,180,255,0.3)")).toBe(false);
    // No orientation-cube background circle.
    expect(log.some((op) => op.type === "call" && op.name === "arc")).toBe(false);
  });

  it("drawZPlaneOverlays draws nothing in volume mode", () => {
    const log: Op[] = [];
    drawZPlaneOverlays(recordingCtx(log), makeData("volume"));
    expect(log).toEqual([]);
  });

  it("drawViewportOverlays draws only 2D viewport rects in slice mode", () => {
    const log: Op[] = [];
    drawViewportOverlays(recordingCtx(log), makeData("slice"));

    expect(log.some((op) => op.type === "call" && op.name === "clearRect")).toBe(false);
    // Viewport rect fill present, slice-plane fill absent.
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === "rgba(100,180,255,0.3)")).toBe(true);
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === "rgba(255,200,50,0.25)")).toBe(false);
    // A 3D orientation cube would contradict the current 2D mode.
    expect(log.some((op) => op.type === "call" && op.name === "arc")).toBe(false);
  });

  it("drawViewportOverlays draws only the orientation cube in volume mode", () => {
    const log: Op[] = [];
    drawViewportOverlays(recordingCtx(log), makeData("volume"));

    // No viewport rects in volume mode, but the cube is still present.
    expect(log.some((op) => op.type === "set" && op.name === "fillStyle" && op.value === "rgba(100,180,255,0.3)")).toBe(false);
    expect(log.some((op) => op.type === "call" && op.name === "arc")).toBe(true);
  });

  it("drives the volume cube from the supplied camera basis", () => {
    const identityLog: Op[] = [];
    drawViewportOverlays(recordingCtx(identityLog), makeData("volume"));

    const rolledLog: Op[] = [];
    drawViewportOverlays(recordingCtx(rolledLog), makeData("volume", {
      cameraViewRotation: new Float32Array([0, -1, 0, 1, 0, 0, 0, 0, 1]),
    }));

    expect(rolledLog).not.toEqual(identityLog);
  });
});

describe("zPlaneLayerDirty", () => {
  it("is true on the first draw (no previous Z)", () => {
    expect(zPlaneLayerDirty(makeData("slice", { currentZ: 5 }), null)).toBe(true);
  });

  it("is true when the Z-plane changed", () => {
    expect(zPlaneLayerDirty(makeData("slice", { currentZ: 5 }), 4)).toBe(true);
  });

  it("is true on a geometry change even when Z is unchanged", () => {
    expect(zPlaneLayerDirty(makeData("slice", { currentZ: 5, staticDirty: true }), 5)).toBe(true);
  });

  it("is false on a pan/zoom with unchanged Z and no geometry change", () => {
    expect(zPlaneLayerDirty(makeData("slice", { currentZ: 5, staticDirty: false }), 5)).toBe(false);
  });
});
