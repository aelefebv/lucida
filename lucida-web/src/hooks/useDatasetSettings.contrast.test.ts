// @vitest-environment happy-dom
/**
 * A layer that fits its contrast keeps each channel at its fit's limits, the
 * range. Auto sets one channel to its fit's stretch once, as a hand-set limit
 * does, so the layer stops fitting.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { channelRangeKey } from "../components/channels.ts";
import type { ChannelFit } from "../pipeline/autoContrast.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { readResolvedLayers } from "../resolvedLayers.ts";
import type { DatasetState } from "../types.ts";
import { VIEWPORTS, fixture, joinedScene, loadWasm, manifest, renamed } from "../viewProperties.ts";
import { useDatasetSettings, type BridgeCallbacks } from "./useDatasetSettings.ts";

const FIT: ChannelFit = {
  limits: { min: 3, max: 4000 },
  stretch: { min: 90, max: 1200 },
  range: { min: 3, max: 4000 },
  histogram: { start: 3, binWidth: 1, counts: new Float64Array(1) },
  provisional: false,
};

function renderSettings() {
  loadWasm();
  const scene = joinedScene(VIEWPORTS[0], 1, [renamed(fixture("image"), "two")]);
  const datasets = new Map<string, DatasetState>([
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
      slicePlane: "xy",
      datasetLevels: new Map(),
    }),
  );
  const limits = (channel: number) => {
    const shown = readResolvedLayers(scene, scene.active_view())
      .get("two")
      ?.channels.find((c) => c.channel === channel);
    return shown && { min: shown.contrast_min, max: shown.contrast_max };
  };
  act(() =>
    result.current.setContrastFitMap(
      new Map([
        [channelRangeKey("two", 0), FIT],
        [channelRangeKey("two", 1), FIT],
      ]),
    ),
  );
  return { result, limits, loop };
}

describe("contrast fits", () => {
  it("sets one channel to its fit's stretch on Auto, and stops the layer fitting", () => {
    const { result, limits, loop } = renderSettings();
    const before = limits(0);
    act(() => result.current.handleChannelAutoFit("two", 1));
    expect(limits(1)).toEqual(FIT.stretch);
    expect(limits(0)).toEqual(before);
    expect(result.current.autoContrastMap.get("two")).toBe(false);
    expect(loop.markInput).toHaveBeenCalledWith("contrast");
  });

  it("sets every channel to its fit's limits when the layer fits again", () => {
    const { result, limits } = renderSettings();
    act(() => result.current.handleChannelAutoFit("two", 1));
    act(() => result.current.handleAutoContrastChange("two", true));
    expect(limits(0)).toEqual(FIT.limits);
    expect(limits(1)).toEqual(FIT.limits);
    expect(result.current.autoContrastMap.get("two")).toBe(true);
  });
});
