// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { RenderClient } from "../renderer/renderClient.ts";
import type { MinimapOverlayData, RenderLoop } from "../renderLoop.ts";
import { Minimap } from "./Minimap.tsx";

type ContextRequest = { kind: string; options: unknown };

function permissiveContext(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

/**
 * happy-dom's `getContext` returns null, and the overlay callback bails on a
 * null context before it reaches the cache layers. Every canvas gets a
 * context that accepts anything, so all three requests are recorded.
 */
function recordContextRequests(): { requests: ContextRequest[]; restore: () => void } {
  const requests: ContextRequest[] = [];
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const original = proto.getContext;
  proto.getContext = (kind: string, options?: unknown) => {
    requests.push({ kind, options });
    return permissiveContext();
  };
  return {
    requests,
    restore: () => {
      proto.getContext = original;
    },
  };
}

function identityMatrix(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function overlayData(): MinimapOverlayData {
  const model = identityMatrix();
  return {
    viewProj: identityMatrix(),
    layers: [{ datasetId: "ds", modelMatrix: model, invModelMatrix: model }],
    datasetLayers: [
      { datasetId: "ds", modelMatrix: model, invModelMatrix: model, width: 64, height: 64, depth: 32 },
    ],
    sliceViewports: [
      {
        datasetId: "ds",
        memberId: "m0",
        modelMatrix: model,
        bounds: { minX: 0, minY: 0, maxX: 64, maxY: 64 },
        width: 64,
        height: 64,
        depth: 32,
      },
    ],
    mode: "slice",
    theta: 0,
    phi: 0,
    canvasW: 400,
    canvasH: 400,
    currentZ: 3,
    datasetDims: new Map([["ds", { width: 64, height: 64, depth: 32 }]]),
    mainInvViewProj: null,
    staticDirty: true,
  };
}

afterEach(() => {
  cleanup();
});

describe("the minimap's 2D canvases", () => {
  // The reason is on SOFTWARE_2D in Minimap.tsx.
  it("ask for software-backed contexts on the overlay and both cache layers", () => {
    const recorder = recordContextRequests();
    try {
      let overlayCallback: ((data: MinimapOverlayData) => void) | null = null;
      const loop = {
        setMinimap: vi.fn((enabled: boolean, _size?: number, callback?: ((data: MinimapOverlayData) => void) | null) => {
          overlayCallback = enabled ? (callback ?? null) : null;
        }),
      } as unknown as RenderLoop;
      const client = { minimapInit: vi.fn() } as unknown as RenderClient;

      render(<Minimap client={client} activeLoop={loop} />);
      expect(loop.setMinimap).toHaveBeenCalledWith(true, 200, expect.any(Function));
      expect(overlayCallback).not.toBeNull();

      // The first overlay draw creates the static and Z-plane cache layers and
      // composites them onto the overlay: three canvases, three contexts.
      overlayCallback!(overlayData());

      const twoD = recorder.requests.filter((request) => request.kind === "2d");
      expect(twoD.length).toBeGreaterThanOrEqual(3);
      for (const request of twoD) {
        expect(request.options).toEqual({ willReadFrequently: true });
      }
    } finally {
      recorder.restore();
    }
  });
});
