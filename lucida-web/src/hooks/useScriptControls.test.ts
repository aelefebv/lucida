// @vitest-environment happy-dom
/**
 * The viewer's registration for the driver's scripted steps: a scrub and a
 * select reach the same handlers the controls call, and what the controls
 * would refuse is refused with a reason rather than applied.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { resolvedLayer, resolvedLayers } from "../resolvedLayerFixtures.ts";
import { scriptControls } from "../trace/steps.ts";
import type { DatasetState } from "../types.ts";
import { useScriptControls, type ScriptControlInputs } from "./useScriptControls.ts";

/** An open dataset with `channels` channels. */
function dataset(id: string, channels = 2): DatasetState {
  return {
    id,
    manifest: { images: [{ multiscale: { levels: [{ shape: [1, channels, 8, 64, 64] }] } }] },
  } as unknown as DatasetState;
}

function inputs(overrides: Partial<ScriptControlInputs> = {}): ScriptControlInputs {
  const datasets = new Map<string, DatasetState>();
  datasets.set("ds-1", dataset("ds-1"));
  return {
    selectors: { z: 2, t: 0, dimZ: 8, dimT: 3, viewMode: "2d" },
    resolvedLayers: resolvedLayers(resolvedLayer("ds-1", [0, 1])),
    setZ: vi.fn(),
    setT: vi.fn(),
    setSolo: vi.fn(),
    setChannelVisible: vi.fn(),
    setLayerVisible: vi.fn(),
    captureView: () => null,
    selectedDatasetId: null,
    datasetsRef: { current: datasets },
    ...overrides,
  };
}

describe("useScriptControls", () => {
  afterEach(() => {
    expect(scriptControls()).toBeNull();
  });

  it("registers on mount and withdraws on unmount", () => {
    const { unmount } = renderHook(() => useScriptControls(inputs()));
    expect(scriptControls()).not.toBeNull();
    unmount();
    expect(scriptControls()).toBeNull();
  });

  it("scrubs through the control's handler, clamped to the axis", () => {
    const given = inputs();
    const { unmount } = renderHook(() => useScriptControls(given));
    expect(scriptControls()!.scrub("z", 3)).toEqual({ applied: true, reason: null });
    expect(given.setZ).toHaveBeenCalledWith(5);
    expect(scriptControls()!.scrub("t", 10)).toEqual({ applied: true, reason: null });
    expect(given.setT).toHaveBeenCalledWith(2);
    unmount();
  });

  it("scrubs c in the composite by soloing the dataset's channels in turn", () => {
    const given = inputs();
    const { unmount, rerender } = renderHook((props: ScriptControlInputs) => useScriptControls(props), {
      initialProps: given,
    });
    // The composite is the position before the first channel.
    expect(scriptControls()!.scrub("c", -1)).toEqual({
      applied: false,
      reason: "c is already at the composite",
    });
    expect(scriptControls()!.scrub("c", 1)).toEqual({ applied: true, reason: null });
    expect(given.setSolo).toHaveBeenLastCalledWith("ds-1", 0);

    rerender({ ...given, resolvedLayers: resolvedLayers(resolvedLayer("ds-1", [0], { solo: 0, channel_count: 2 })) });
    expect(scriptControls()!.scrub("c", 1)).toEqual({ applied: true, reason: null });
    expect(given.setSolo).toHaveBeenLastCalledWith("ds-1", 1);
    expect(scriptControls()!.scrub("c", -1)).toEqual({ applied: true, reason: null });
    expect(given.setSolo).toHaveBeenLastCalledWith("ds-1", null);
    unmount();
  });

  it("selects a channel of the dataset in hand and a layer by id through the panel's handlers", () => {
    const given = inputs();
    const { unmount } = renderHook(() => useScriptControls(given));
    expect(scriptControls()!.select({ channel: 1 }, false)).toEqual({ applied: true, reason: null });
    expect(given.setChannelVisible).toHaveBeenCalledWith("ds-1", 1, false);
    expect(scriptControls()!.select({ layer: "ds-1" }, true)).toEqual({ applied: true, reason: null });
    expect(given.setLayerVisible).toHaveBeenCalledWith("ds-1", true);
    unmount();
  });

  it("refuses a channel or a layer the page does not have, and says which", () => {
    const given = inputs();
    const { unmount } = renderHook(() => useScriptControls(given));
    expect(scriptControls()!.select({ channel: 2 }, true)).toEqual({
      applied: false,
      reason: "ds-1 has 2 channel(s), so there is no channel 2",
    });
    expect(scriptControls()!.select({ layer: "ds-9" }, true)).toEqual({
      applied: false,
      reason: "no layer ds-9 is open",
    });
    expect(given.setChannelVisible).not.toHaveBeenCalled();
    expect(given.setLayerVisible).not.toHaveBeenCalled();
    unmount();
  });

  it("needs a dataset in hand for a channel select when several are open", () => {
    const datasets = new Map<string, DatasetState>();
    datasets.set("ds-1", dataset("ds-1"));
    datasets.set("ds-2", dataset("ds-2"));
    const given = inputs({ datasetsRef: { current: datasets } });
    const { unmount, rerender } = renderHook((props: ScriptControlInputs) => useScriptControls(props), {
      initialProps: given,
    });
    expect(scriptControls()!.select({ channel: 0 }, true)).toEqual({
      applied: false,
      reason: "no dataset is in hand for a channel select",
    });
    rerender({ ...given, selectedDatasetId: "ds-2" });
    expect(scriptControls()!.select({ channel: 0 }, true)).toEqual({ applied: true, reason: null });
    expect(given.setChannelVisible).toHaveBeenCalledWith("ds-2", 0, true);
    unmount();
  });

  it("hands the view read straight through", () => {
    const view = { v: 1 } as never;
    const { unmount } = renderHook(() => useScriptControls(inputs({ captureView: () => view })));
    expect(scriptControls()!.view()).toBe(view);
    unmount();
  });
});
