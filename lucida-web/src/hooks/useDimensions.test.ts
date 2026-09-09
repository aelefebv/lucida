// @vitest-environment happy-dom
/**
 * The trace recorder hears the selectors at the control, not where the value
 * reaches the render loop. A saved-view apply and a followed peer move the
 * same selectors, and neither is an input.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { WasmScene } from "lucida-core";

import type { RenderLoop } from "../renderLoop.ts";
import type { DatasetState } from "../types.ts";
import type { BridgeCallbacks } from "./useDatasetSettings.ts";
import { useDimensions } from "./useDimensions.ts";

function renderDimensions() {
  const scene = { apply_command: vi.fn() } as unknown as WasmScene;
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
  const { result } = renderHook(() =>
    useDimensions({
      wasmSceneRef: { current: scene },
      wasmScene: scene,
      selectedDatasetId: null,
      datasetsRef: { current: new Map<string, DatasetState>() },
      datasetsVersion: 0,
      bridgeCallbacksRef: { current: bridge },
      loopRef: { current: loop as unknown as RenderLoop },
    }),
  );
  return { result, loop };
}

describe("useDimensions as an input source", () => {
  it("reports a selector change as a scrub, at the control", () => {
    const { result, loop } = renderDimensions();

    act(() => result.current.handleZChange(3));
    act(() => result.current.handleTChange(2));
    act(() => result.current.handleCChange(1));

    expect(loop.markInput.mock.calls).toEqual([["scrub"], ["scrub"], ["scrub"]]);
  });

  it("reports the multi-channel switch as a select", () => {
    const { result, loop } = renderDimensions();

    act(() => result.current.handleMultiChannelToggle());

    expect(loop.markInput).toHaveBeenCalledExactlyOnceWith("select");
  });
});
