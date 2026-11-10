// @vitest-environment happy-dom
/**
 * Solo is per layer: the layer panel's solo writes one layer's `solo` into the
 * scene, which every other layer ignores, and the same press on the soloed
 * channel returns that layer to its composite.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { RenderLoop } from "../renderLoop.ts";
import { readResolvedLayers, shownChannels } from "../resolvedLayers.ts";
import type { DatasetState } from "../types.ts";
import { VIEWPORTS, fixture, joinedScene, loadWasm, manifest, renamed } from "../viewProperties.ts";
import { useDatasetSettings, type BridgeCallbacks } from "./useDatasetSettings.ts";

function renderSettings() {
  loadWasm();
  // A three-channel layer and a two-channel layer.
  const opened = [renamed(fixture("volume"), "three"), renamed(fixture("image"), "two")];
  const scene = joinedScene(VIEWPORTS[0], 1, opened);
  const datasets = new Map<string, DatasetState>([
    ["three", { id: "three", manifest: manifest(fixture("volume")) } as unknown as DatasetState],
    ["two", { id: "two", manifest: manifest(fixture("image")) } as unknown as DatasetState],
  ]);
  const loop = { markInput: vi.fn(), markInteractiveDirty: vi.fn(), markResidencyDirty: vi.fn() };
  const bridge: BridgeCallbacks = {
    sendCommand: vi.fn(),
    emitPresence: vi.fn(),
    emitDatasetPresence: vi.fn(),
    breakFollow: vi.fn(),
  };
  const { result } = renderHook(() =>
    useDatasetSettings({
      wasmSceneRef: { current: scene },
      datasetsRef: { current: datasets },
      loopRef: { current: loop as unknown as RenderLoop },
      selectedDatasetId: null,
      setSelectedDatasetId: vi.fn(),
      bridgeCallbacksRef: { current: bridge },
      datasetCallbacksRef: { current: { removeDataset: vi.fn() } },
      datasetsVersion: 0,
      remoteDocumentVersion: 0,
      viewMode: "2d",
      datasetLevels: new Map(),
    }),
  );
  const shown = (id: string) => shownChannels(readResolvedLayers(scene, scene.active_view()).get(id));
  return { result, shown, loop, bridge };
}

describe("per-layer solo", () => {
  it("solos a channel of one layer and leaves the other layer as it was", () => {
    const { result, shown } = renderSettings();
    expect(shown("three")).toEqual([0, 1, 2]);

    act(() => result.current.handleSoloChannel("three", 2));
    expect(shown("three")).toEqual([2]);
    // The two-channel layer has no channel 2 and stays in its composite.
    expect(shown("two")).toEqual([0, 1]);

    act(() => result.current.handleSoloChannel("two", 0));
    expect(shown("two")).toEqual([0]);
    expect(shown("three")).toEqual([2]);
  });

  it("returns to the composite from the soloed channel, and from Show all", () => {
    const { result, shown } = renderSettings();
    act(() => result.current.handleSoloChannel("three", 1));
    act(() => result.current.handleSoloChannel("three", 1));
    expect(shown("three")).toEqual([0, 1, 2]);

    act(() => result.current.handleSoloChannel("three", 0));
    act(() => result.current.handleShowAllChannels("three"));
    expect(shown("three")).toEqual([0, 1, 2]);
  });

  it("reports solo as a select and tells peers through dataset presence", () => {
    const { result, loop, bridge } = renderSettings();
    act(() => result.current.handleSoloChannel("three", 1));
    expect(loop.markInput).toHaveBeenCalledWith("select");
    expect(bridge.emitDatasetPresence).toHaveBeenCalled();
  });
});
