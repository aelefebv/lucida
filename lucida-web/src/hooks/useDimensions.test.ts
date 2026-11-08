// @vitest-environment happy-dom
/**
 * The trace recorder hears the selectors at the control, not where the value
 * reaches the render loop. A saved-view apply and a followed peer move the
 * same selectors, and neither is an input.
 *
 * What each layer shows is the scene's to say; the hook passes its resolved
 * layers through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WasmScene } from "lucida-core";

import { applyViewportCommand } from "../applyAndSend.ts";
import { stepIndex } from "../axes.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { resolvedLayer } from "../resolvedLayerFixtures.ts";
import { SceneStore } from "../sceneStore.ts";
import { VIEWPORT_MEDIA, type ViewportClass } from "../theme/viewport.ts";
import type { DatasetState } from "../types.ts";
import {
  FIXTURES,
  PIXEL_RATIOS,
  PropertyReport,
  VIEWPORTS,
  cssSize,
  cssSizesDiffer,
  datasetId,
  loadWasm,
  manifest,
  notFramed,
  openedScene,
  type ViewFixture,
  type Viewport,
} from "../viewProperties.ts";
import type { BridgeCallbacks } from "./useDatasetSettings.ts";
import { useDimensions } from "./useDimensions.ts";

/** A dataset of `channels` channels; only the shape is read. */
function dataset(id: string, channels: number): DatasetState {
  return {
    id,
    manifest: { images: [{ multiscale: { levels: [{ shape: [1, channels, 1, 64, 64] }] } }] },
  } as unknown as DatasetState;
}

function renderDimensions(datasets: DatasetState[] = []) {
  const state = { z: 0, t: 0, selection: 0, layers: [] as unknown[] };
  const commands: Array<Record<string, unknown>> = [];
  const scene = {
    apply_command: vi.fn((json: string) => {
      const cmd = JSON.parse(json);
      commands.push(cmd);
      if (cmd.type === "set_z") state.z = cmd.z;
      if (cmd.type === "set_t") state.t = cmd.t;
      state.selection++;
    }),
    epochs: () => JSON.stringify({ content: 0, layout: 0, view: 0, selection: state.selection }),
    resolved_layers: () => JSON.stringify(state.layers),
    z: () => state.z,
    t: () => state.t,
    camera_mode: () => "slice",
  } as unknown as WasmScene;
  const loop = {
    markInput: vi.fn(),
    markInteractiveDirty: vi.fn(),
    markResidencyDirty: vi.fn(),
  };
  const bridge: BridgeCallbacks = {
    sendCommand: vi.fn(),
    emitPresence: vi.fn(),
    emitDatasetPresence: vi.fn(),
    breakFollow: vi.fn(),
  };
  const datasetsRef = { current: new Map(datasets.map((d) => [d.id, d])) };
  const sceneStore = new SceneStore(() => scene);
  const { result, rerender } = renderHook(
    ({ version }) =>
      useDimensions({
        sceneStore,
        wasmSceneRef: { current: scene },
        datasetsRef,
        datasetsVersion: version,
        bridgeCallbacksRef: { current: bridge },
        loopRef: { current: loop as unknown as RenderLoop },
      }),
    { initialProps: { version: 0 } },
  );
  return { result, rerender, loop, scene, sceneStore, state, commands, datasetsRef };
}

describe("useDimensions as an input source", () => {
  it("reports a selector change as a scrub, at the control", () => {
    const { result, loop } = renderDimensions();

    act(() => result.current.handleZChange(3));
    act(() => result.current.handleTChange(2));

    expect(loop.markInput.mock.calls).toEqual([["scrub"], ["scrub"]]);
  });

  it("steps from the scene's index at each press, not the last render's", () => {
    const { result, commands } = renderDimensions();

    act(() => {
      result.current.handleZChange(stepIndex(1, 3));
      result.current.handleZChange(stepIndex(1, 3));
      result.current.handleZChange(stepIndex(1, 3));
      result.current.handleTChange(stepIndex(1, 4));
    });

    expect(commands).toEqual([
      { type: "set_z", z: 1 },
      { type: "set_z", z: 2 },
      { type: "set_z", z: 2 },
      { type: "set_t", t: 1 },
    ]);
  });
});

describe("useDimensions layers", () => {
  it("reads what each layer shows back from the scene after a write", () => {
    const { result, sceneStore, state } = renderDimensions([dataset("ds", 3)]);
    expect(result.current.layers.size).toBe(0);

    // A saved view, URL, or followed peer writes the scene and announces it.
    state.layers = [resolvedLayer("ds", [1], { solo: 1, channel_count: 3 })];
    state.selection++;
    act(() => sceneStore.sync());

    expect(result.current.layers.get("ds")?.solo).toBe(1);
  });
});

describe("useDimensions view mode", () => {
  afterEach(() => vi.unstubAllGlobals());

  function atWidthClass(viewportClass: ViewportClass) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === VIEWPORT_MEDIA[viewportClass],
      addEventListener() {},
      removeEventListener() {},
    }));
  }

  /** The page's view after the toggle switches `f`, fitted in `from` on a
   *  real scene, to the other mode. */
  function switched(f: ViewFixture, vp: Viewport, dpr: number, from: "slice" | "arcball"): WasmScene {
    const scene = openedScene(f, vp, dpr, from);
    const ds = { id: datasetId(f), manifest: manifest(f) } as unknown as DatasetState;
    const sceneStore = new SceneStore(() => scene);
    const { result } = renderHook(() =>
      useDimensions({
        sceneStore,
        wasmSceneRef: { current: scene },
        datasetsRef: { current: new Map([[ds.id, ds]]) },
        datasetsVersion: 0,
        bridgeCallbacksRef: {
          current: {
            sendCommand: vi.fn(),
            emitPresence: vi.fn(),
            emitDatasetPresence: vi.fn(),
            breakFollow: vi.fn(),
          },
        },
        loopRef: { current: null },
      }),
    );
    act(() => result.current.handleViewModeToggle());
    return scene;
  }

  /** Each switch frames every fixture and shows it at one CSS size at both
   *  pixel ratios, on canvases `vp` of width class `viewportClass`. */
  function assertSwitchFrames(vp: Viewport, viewportClass: ViewportClass): void {
    atWidthClass(viewportClass);
    const framed = new PropertyReport();
    const sized = new PropertyReport();
    for (const f of FIXTURES) {
      const id = datasetId(f);
      for (const from of ["slice", "arcball"] as const) {
        const [at1x, at2x] = PIXEL_RATIOS.map((dpr) => switched(f, vp, dpr, from));
        const label = `${f.name} on ${vp.name}, from ${from}`;
        framed.check(`${label} at 1x`, notFramed(at1x, id));
        framed.check(`${label} at 2x`, notFramed(at2x, id));
        sized.check(label, cssSizesDiffer(cssSize(at1x, id, 1), cssSize(at2x, id, 2)));
      }
    }
    framed.assertHolds();
    sized.assertHolds();
  }

  it("frames the data in the new mode on a phone", () => {
    loadWasm();
    assertSwitchFrames(VIEWPORTS[1], "phone");
  });

  it("frames the data in the new mode on a desktop", () => {
    loadWasm();
    assertSwitchFrames(VIEWPORTS[0], "desktop");
  });

  it("brings back the view a mode had when switching back to it", () => {
    loadWasm();
    const scene = openedScene(FIXTURES[1], VIEWPORTS[0], 2, "slice");
    applyViewportCommand(scene, { type: "pan", dx: 40, dy: -25 });
    const camera = () => JSON.parse(scene.export_presence()).camera;
    const placed = camera();
    const ds = { id: datasetId(FIXTURES[1]), manifest: manifest(FIXTURES[1]) } as unknown as DatasetState;
    const { result } = renderHook(() =>
      useDimensions({
        sceneStore: new SceneStore(() => scene),
        wasmSceneRef: { current: scene },
        datasetsRef: { current: new Map([[ds.id, ds]]) },
        datasetsVersion: 0,
        bridgeCallbacksRef: {
          current: {
            sendCommand: vi.fn(),
            emitPresence: vi.fn(),
            emitDatasetPresence: vi.fn(),
            breakFollow: vi.fn(),
          },
        },
        loopRef: { current: null },
      }),
    );
    act(() => result.current.handleViewModeToggle());
    expect(camera().mode).toBe("arcball");
    act(() => result.current.handleViewModeToggle());
    expect(camera()).toEqual(placed);
  });
});
