// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { RenderClient } from "../renderer/renderClient.ts";
import type { MinimapOverlayData, RenderLoop } from "../renderLoop.ts";
import { drawViewportOverlays } from "./minimapOverlay.ts";
import { Minimap } from "./Minimap.tsx";

// The strokes themselves are not under test; what the overlay draws with,
// and when, is.
vi.mock("./minimapOverlay.ts", () => ({
  drawStaticMinimapOverlays: vi.fn(),
  drawZPlaneOverlays: vi.fn(),
  drawViewportOverlays: vi.fn(),
  zPlaneLayerDirty: vi.fn(() => true),
}));

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

/** A context that accepts anything and records the calls named in `spies`. */
function spyingContext(spies: Record<string, ReturnType<typeof vi.fn>>): CanvasRenderingContext2D {
  return new Proxy(spies, {
    get: (target, key) => (typeof key === "string" && key in target ? target[key] : () => undefined),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
}

/**
 * happy-dom's `getContext` returns null, and the overlay callback bails on a
 * null context before it reaches the cache layers. Every canvas gets a
 * context that accepts anything, so all three requests are recorded.
 */
function recordContextRequests(
  make: () => CanvasRenderingContext2D = permissiveContext,
): { requests: ContextRequest[]; restore: () => void } {
  const requests: ContextRequest[] = [];
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const original = proto.getContext;
  proto.getContext = (kind: string, options?: unknown) => {
    requests.push({ kind, options });
    return make();
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

function overlayData(currentZ = 3): MinimapOverlayData {
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
    currentZ,
    datasetDims: new Map([["ds", { width: 64, height: 64, depth: 32 }]]),
    mainInvViewProj: null,
    staticDirty: true,
  };
}

/** A render loop that hands the overlay callback back to the test. */
function makeLoop(): { loop: RenderLoop; overlay: () => (data: MinimapOverlayData) => void } {
  let overlayCallback: ((data: MinimapOverlayData) => void) | null = null;
  const loop = {
    setMinimap: vi.fn((enabled: boolean, _size?: number, callback?: ((data: MinimapOverlayData) => void) | null) => {
      overlayCallback = enabled ? (callback ?? null) : null;
    }),
  } as unknown as RenderLoop;
  return {
    loop,
    overlay: () => {
      if (!overlayCallback) throw new Error("the minimap registered no overlay callback");
      return overlayCallback;
    },
  };
}

/** A client whose readiness report the test delivers by hand. */
type ClientStub = RenderClient & {
  pipelinesCompiled: boolean;
  /** The handler the minimap registered, or null once it withdrew it. */
  handler: (() => void) | null;
};

function makeClient(pipelinesCompiled: boolean): ClientStub {
  const stub = {
    minimapInit: vi.fn(),
    pipelinesCompiled,
    handler: null as (() => void) | null,
    oncePipelinesCompiled(handler: () => void) {
      if (stub.pipelinesCompiled) {
        handler();
        return () => {};
      }
      stub.handler = handler;
      return () => {
        stub.handler = null;
      };
    },
  };
  return stub as unknown as ClientStub;
}

afterEach(() => {
  cleanup();
  vi.mocked(drawViewportOverlays).mockClear();
});

describe("the minimap overlay at mount", () => {
  // The reason is in the note above `Props` in Minimap.tsx (#1101).
  it("draws once on the overlay, with no software-raster hint, before any tick", () => {
    const clearRect = vi.fn();
    const recorder = recordContextRequests(() => spyingContext({ clearRect }));
    try {
      const { loop } = makeLoop();
      render(<Minimap client={makeClient(false)} activeLoop={loop} />);

      const twoD = recorder.requests.filter((request) => request.kind === "2d");
      expect(twoD).toHaveLength(1);
      expect(twoD[0].options).toBeUndefined();
      expect(clearRect).toHaveBeenCalledOnce();
      expect(drawViewportOverlays).not.toHaveBeenCalled();
    } finally {
      recorder.restore();
    }
  });
});

describe("the minimap overlay's content draws", () => {
  // The reason is in the note above `Props` in Minimap.tsx (#1101).
  it("wait for the worker's pipelines, then draw the latest data handed over", () => {
    const recorder = recordContextRequests();
    try {
      const { loop, overlay } = makeLoop();
      const client = makeClient(false);
      render(<Minimap client={client} activeLoop={loop} />);
      expect(client.handler).not.toBeNull();
      const twoD = () => recorder.requests.filter((request) => request.kind === "2d");
      const atMount = twoD().length;

      overlay()(overlayData(3));
      overlay()(overlayData(5));
      expect(twoD()).toHaveLength(atMount);
      expect(drawViewportOverlays).not.toHaveBeenCalled();

      client.pipelinesCompiled = true;
      client.handler!();
      expect(drawViewportOverlays).toHaveBeenCalledOnce();
      expect(drawViewportOverlays).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ currentZ: 5 }));

      overlay()(overlayData(6));
      expect(drawViewportOverlays).toHaveBeenCalledTimes(2);
      expect(drawViewportOverlays).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ currentZ: 6 }));
    } finally {
      recorder.restore();
    }
  });

  it("draws in its own turn when the pipelines were ready before it mounted", () => {
    const recorder = recordContextRequests();
    try {
      const { loop, overlay } = makeLoop();
      render(<Minimap client={makeClient(true)} activeLoop={loop} />);
      overlay()(overlayData(4));
      expect(drawViewportOverlays).toHaveBeenCalledOnce();
    } finally {
      recorder.restore();
    }
  });

  it("withdraws its handler when it unmounts", () => {
    const { loop } = makeLoop();
    const client = makeClient(false);
    const { unmount } = render(<Minimap client={client} activeLoop={loop} />);
    expect(client.handler).not.toBeNull();
    unmount();
    expect(client.handler).toBeNull();
  });
});
