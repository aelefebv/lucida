// @vitest-environment happy-dom
/**
 * The trace recorder hears the selectors at the control, not where the value
 * reaches the render loop. A saved-view apply and a followed peer move the
 * same selectors, and neither is an input.
 *
 * Channels: a multichannel image opens as a composite, and solo is the
 * scene's single-channel mode, so a view recorded in single-channel mode
 * reads back as that channel soloed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WasmScene } from "lucida-core";

import type { RenderLoop } from "../renderLoop.ts";
import { VIEWPORT_MEDIA, type ViewportClass } from "../theme/viewport.ts";
import type { DatasetState } from "../types.ts";
import type { BridgeCallbacks } from "./useDatasetSettings.ts";
import { syncSceneViewState } from "./sceneViewState.ts";
import { useDimensions } from "./useDimensions.ts";

/** A dataset of `channels` channels; only the shape is read. */
function dataset(id: string, channels: number): DatasetState {
  return {
    id,
    manifest: { images: [{ multiscale: { levels: [{ shape: [1, channels, 1, 64, 64] }] } }] },
  } as unknown as DatasetState;
}

function renderDimensions(datasets: DatasetState[] = []) {
  const state = { multi: false, c: 0 };
  const commands: Array<Record<string, unknown>> = [];
  const scene = {
    apply_command: vi.fn((json: string) => {
      const cmd = JSON.parse(json);
      commands.push(cmd);
      if (cmd.type === "set_multi_channel") state.multi = cmd.enabled;
      if (cmd.type === "set_c") state.c = cmd.c;
    }),
    multi_channel: () => state.multi,
    c: () => state.c,
    z: () => 0,
    t: () => 0,
    camera_mode: () => "slice",
    fit_camera_to_dataset_bounds: vi.fn(),
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
  const { result, rerender } = renderHook(
    ({ version }) =>
      useDimensions({
        wasmSceneRef: { current: scene },
        wasmScene: scene,
        selectedDatasetId: null,
        datasetsRef,
        datasetsVersion: version,
        bridgeCallbacksRef: { current: bridge },
        loopRef: { current: loop as unknown as RenderLoop },
      }),
    { initialProps: { version: 0 } },
  );
  return { result, rerender, loop, scene, state, commands, datasetsRef };
}

describe("useDimensions as an input source", () => {
  it("reports a selector change as a scrub, at the control", () => {
    const { result, loop } = renderDimensions();

    act(() => result.current.handleZChange(3));
    act(() => result.current.handleTChange(2));
    act(() => result.current.handleCChange(1));

    expect(loop.markInput.mock.calls).toEqual([["scrub"], ["scrub"], ["scrub"]]);
  });

  it("reports solo as a select", () => {
    const { result, loop } = renderDimensions([dataset("ds", 3)]);

    act(() => result.current.handleSoloChannel(1));

    expect(loop.markInput).toHaveBeenCalledExactlyOnceWith("select");
  });
});

describe("useDimensions channels", () => {
  it("opens the first multichannel image as a composite", () => {
    const { result, state, datasetsRef } = renderDimensions();
    datasetsRef.current.set("ds", dataset("ds", 3));

    act(() => result.current.handleDatasetRegistered("ds"));

    expect(state.multi).toBe(true);
    expect(result.current.multiChannel).toBe(true);
    expect(result.current.soloChannel).toBeNull();
  });

  it("leaves a single-channel image, and a solo, alone", () => {
    const { result, state, commands, datasetsRef } = renderDimensions();
    datasetsRef.current.set("plain", dataset("plain", 1));
    act(() => result.current.handleDatasetRegistered("plain"));
    expect(commands).toEqual([]);

    datasetsRef.current.set("ds", dataset("ds", 3));
    act(() => result.current.handleDatasetRegistered("ds"));
    act(() => result.current.handleSoloChannel(2));
    expect(result.current.soloChannel).toBe(2);

    datasetsRef.current.set("other", dataset("other", 2));
    act(() => result.current.handleDatasetRegistered("other"));
    expect(state.multi).toBe(false);
    expect(result.current.soloChannel).toBe(2);
  });

  it("solos a channel, and returns to the composite from it", () => {
    const { result, state } = renderDimensions([dataset("ds", 3)]);

    act(() => result.current.handleSoloChannel(1));
    expect(state).toEqual({ multi: false, c: 1 });
    expect(result.current.soloChannel).toBe(1);

    act(() => result.current.handleSoloChannel(2));
    expect(state).toEqual({ multi: false, c: 2 });
    expect(result.current.soloChannel).toBe(2);

    act(() => result.current.handleSoloChannel(2));
    expect(state.multi).toBe(true);
    expect(result.current.soloChannel).toBeNull();

    act(() => result.current.handleSoloChannel(0));
    act(() => result.current.handleShowAllChannels());
    expect(result.current.soloChannel).toBeNull();
  });

  it("reads a restored single-channel view as that channel soloed", () => {
    const { result, scene, state } = renderDimensions([dataset("ds", 3)]);
    act(() => result.current.handleDatasetRegistered("ds"));
    expect(result.current.soloChannel).toBeNull();

    // A saved view, URL, or followed peer writes the scene, then mirrors it.
    state.multi = false;
    state.c = 1;
    act(() => syncSceneViewState(scene, result.current));

    expect(result.current.soloChannel).toBe(1);
  });

  it("never reports a solo for a single-channel scene", () => {
    const { result } = renderDimensions([dataset("plain", 1)]);
    expect(result.current.multiChannel).toBe(false);
    expect(result.current.soloChannel).toBeNull();
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

  it("frames the data in the new mode below desktop widths", () => {
    atWidthClass("phone");
    const { result, scene, commands } = renderDimensions([dataset("ds", 1)]);

    act(() => result.current.handleViewModeToggle());

    expect(commands.map((c) => c.type)).toEqual(["set_mode_arcball"]);
    expect(scene.fit_camera_to_dataset_bounds).toHaveBeenCalledExactlyOnceWith("ds");
  });

  it("keeps each mode's starting camera on desktop", () => {
    atWidthClass("desktop");
    const { result, scene } = renderDimensions([dataset("ds", 1)]);

    act(() => result.current.handleViewModeToggle());

    expect(scene.fit_camera_to_dataset_bounds).not.toHaveBeenCalled();
  });
});
