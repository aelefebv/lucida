// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { WasmScene } from "lucida-core";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { MinimapOverlayData, RenderLoop } from "../renderLoop.ts";
import { __resetPreferencesForTesting, getPreference } from "../theme/preferences.ts";
import { minimapCardPreference } from "./canvasCards.ts";
import { drawViewportOverlays } from "./minimapOverlay.ts";
import { Minimap } from "./Minimap.tsx";

// The strokes themselves are not under test; what the overlay draws with,
// and when, is.
vi.mock("./minimapOverlay.ts", () => ({
  drawStaticMinimapOverlays: vi.fn(),
  drawZPlaneOverlays: vi.fn(),
  drawViewportOverlays: vi.fn(),
  zPlaneLayerDirty: vi.fn(() => true),
  readMinimapColors: vi.fn(() => ({})),
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
    invViewProj: identityMatrix(),
    members: [],
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
    topDown: false,
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

/** Minimap input's targets, none of which these tests steer. */
const NAVIGATION = {
  engine: { scene: () => null, canvas: () => null },
  emitPresence: () => {},
  breakFollow: () => {},
};

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

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

afterEach(() => {
  cleanup();
  vi.mocked(drawViewportOverlays).mockClear();
});

describe("the minimap overlay at mount", () => {
  // The reason is in the note above `Props` in Minimap.tsx.
  it("draws once on the overlay, with no software-raster hint, before any tick", () => {
    const clearRect = vi.fn();
    const recorder = recordContextRequests(() => spyingContext({ clearRect }));
    try {
      const { loop } = makeLoop();
      render(<Minimap client={makeClient(false)} activeLoop={loop} {...NAVIGATION} />);

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
  // The reason is in the note above `Props` in Minimap.tsx.
  it("wait for the worker's pipelines, then draw the latest data handed over", () => {
    const recorder = recordContextRequests();
    try {
      const { loop, overlay } = makeLoop();
      const client = makeClient(false);
      render(<Minimap client={client} activeLoop={loop} {...NAVIGATION} />);
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
      expect(drawViewportOverlays).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ currentZ: 5 }), expect.anything());

      overlay()(overlayData(6));
      expect(drawViewportOverlays).toHaveBeenCalledTimes(2);
      expect(drawViewportOverlays).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ currentZ: 6 }), expect.anything());
    } finally {
      recorder.restore();
    }
  });

  it("draws in its own turn when the pipelines were ready before it mounted", () => {
    const recorder = recordContextRequests();
    try {
      const { loop, overlay } = makeLoop();
      render(<Minimap client={makeClient(true)} activeLoop={loop} {...NAVIGATION} />);
      overlay()(overlayData(4));
      expect(drawViewportOverlays).toHaveBeenCalledOnce();
    } finally {
      recorder.restore();
    }
  });

  it("stops the loop drawing it while folded or hidden, and keeps its canvases", () => {
    const { loop } = makeLoop();
    const client = makeClient(true);
    const { container } = render(<Minimap client={client} activeLoop={loop} {...NAVIGATION} />);
    const drawingOn = () => expect(loop.setMinimap).toHaveBeenLastCalledWith(true, expect.any(Number), expect.any(Function));
    drawingOn();

    fireEvent.click(screen.getByRole("button", { name: "Collapse minimap" }));
    expect(loop.setMinimap).toHaveBeenLastCalledWith(false);
    expect(getPreference(minimapCardPreference)).toBe("collapsed");

    fireEvent.click(screen.getByRole("button", { name: "Expand minimap" }));
    drawingOn();

    fireEvent.click(screen.getByRole("button", { name: "Hide minimap" }));
    expect(loop.setMinimap).toHaveBeenLastCalledWith(false);
    expect(getPreference(minimapCardPreference)).toBe("hidden");
    expect(container.querySelectorAll("canvas")).toHaveLength(2);
    expect(client.minimapInit).toHaveBeenCalledOnce();
  });

  it("withdraws its handler when it unmounts", () => {
    const { loop } = makeLoop();
    const client = makeClient(false);
    const { unmount } = render(<Minimap client={client} activeLoop={loop} {...NAVIGATION} />);
    expect(client.handler).not.toBeNull();
    unmount();
    expect(client.handler).toBeNull();
  });
});

describe("input on the minimap", () => {
  /** A slice scene whose camera only records where it was centred. */
  function sliceScene() {
    const state = { center: [500, 500] as [number, number] };
    const scene = {
      camera_mode: () => "slice",
      slice_plane: () => "xy",
      center: () => state.center,
      zoom: () => 1,
      apply_command: (json: string) => {
        const command = JSON.parse(json);
        if (command.type === "set_center") state.center = [command.x, command.y];
      },
    };
    return { scene: scene as unknown as WasmScene, state };
  }

  /** A frame whose minimap camera is the identity, over one 100 × 100 member at the scene origin. */
  function identityFrame(): MinimapOverlayData {
    const model = identityMatrix();
    return {
      ...overlayData(0),
      members: [
        { datasetId: "ds", memberId: "m0", modelMatrix: model, invModelMatrix: model, position: [0, 0], width: 100, height: 100, depth: 1 },
      ],
    };
  }

  function mount() {
    const { loop, overlay } = makeLoop();
    Object.assign(loop, { markInput: vi.fn(), setRenderScale: vi.fn() });
    const { scene, state } = sliceScene();
    const emitPresence = vi.fn();
    const mainCanvas = { clientWidth: 10, clientHeight: 10 } as unknown as HTMLCanvasElement;
    render(
      <Minimap
        client={makeClient(true)}
        activeLoop={loop}
        engine={{ scene: () => scene, canvas: () => mainCanvas }}
        emitPresence={emitPresence}
        breakFollow={() => {}}
      />,
    );
    overlay()(identityFrame());
    const surface = screen.getByRole("application", { name: /Minimap/ });
    return { loop, state, emitPresence, surface };
  }

  it("centres the view where a click lands, as an input the loop and peers hear of", () => {
    const { loop, state, emitPresence, surface } = mount();
    // The member fills the minimap's top-right quarter, so this is its (75, 25).
    const at = { clientX: 175, clientY: 25, button: 0, pointerId: 1, pointerType: "mouse" };
    fireEvent.pointerDown(surface, at);
    fireEvent.pointerUp(surface, at);
    expect(state.center[0]).toBeCloseTo(75, 6);
    expect(state.center[1]).toBeCloseTo(25, 6);
    expect(loop.markInput).toHaveBeenCalledWith("pan", expect.any(Number));
    expect(emitPresence).toHaveBeenCalled();
  });

  it("keeps the arrow keys from the window's shortcuts while it has focus", () => {
    const { surface } = mount();
    expect(surface.tabIndex).toBe(0);
    expect(fireEvent.keyDown(surface, { key: "ArrowLeft" })).toBe(false);
    expect(fireEvent.keyDown(surface, { key: "Enter" })).toBe(true);
  });
});
