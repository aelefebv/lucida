// @vitest-environment happy-dom
/**
 * The viewer's registration for the driver's scripted steps: a scrub and a
 * select reach the same handlers the controls call, and what the controls
 * would refuse is refused with a reason rather than applied.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { normalize_dataset_url } from "lucida-core";

import { resolvedLayer, resolvedLayers } from "../resolvedLayerFixtures.ts";
import { noteDatasetOpened, noteDatasetOpenFailed, scriptControls } from "../trace/steps.ts";
import type { DatasetState } from "../types.ts";
import { useScriptControls, type ScriptControlInputs } from "./useScriptControls.ts";

/** An open dataset with `channels` channels and `labels` labels. */
function dataset(id: string, channels = 2, labels = 1): DatasetState {
  return {
    id,
    manifest: {
      images: [{ multiscale: { levels: [{ shape: [1, channels, 8, 64, 64] }] } }],
      labels: Array.from({ length: labels }, (_, i) => ({ name: `label-${i}` })),
    },
  } as unknown as DatasetState;
}

function inputs(overrides: Partial<ScriptControlInputs> = {}): ScriptControlInputs {
  const datasets = new Map<string, DatasetState>();
  datasets.set("ds-1", dataset("ds-1"));
  return {
    selectors: { z: 2, t: 0, dimZ: 8, dimT: 3, viewMode: "2d", slicePlane: "xy", cutIndex: 2, dimCut: 8 },
    resolvedLayers: resolvedLayers(resolvedLayer("ds-1", [0, 1])),
    setCut: vi.fn(),
    setT: vi.fn(),
    setSlicePlane: vi.fn(),
    setSolo: vi.fn(),
    setChannelVisible: vi.fn(),
    setLayerVisible: vi.fn(),
    setLabelVisible: vi.fn(),
    setChannelContrast: vi.fn(),
    openDataset: vi.fn(),
    removeDataset: vi.fn(),
    datasetHealth: () => Promise.resolve([]),
    captureView: () => null,
    selectedDatasetId: null,
    datasetsRef: { current: datasets },
    ...overrides,
  };
}

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

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
    expect(given.setCut).toHaveBeenCalledWith(5);
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

  it("shows a label of the dataset in hand through the panel's handler, and refuses one it lacks", () => {
    const given = inputs();
    const { unmount } = renderHook(() => useScriptControls(given));
    expect(scriptControls()!.select({ label: 0 }, true)).toEqual({ applied: true, reason: null });
    expect(given.setLabelVisible).toHaveBeenCalledWith("ds-1", 0, true);
    expect(scriptControls()!.select({ label: 1 }, true)).toEqual({
      applied: false,
      reason: "ds-1 has 1 label(s), so there is no label 1",
    });
    expect(given.setLabelVisible).toHaveBeenCalledTimes(1);
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
      reason: "no dataset is in hand for a channel or label select",
    });
    rerender({ ...given, selectedDatasetId: "ds-2" });
    expect(scriptControls()!.select({ channel: 0 }, true)).toEqual({ applied: true, reason: null });
    expect(given.setChannelVisible).toHaveBeenCalledWith("ds-2", 0, true);
    unmount();
  });

  it("sets a channel's contrast through the panel's handler, and refuses a channel it lacks", () => {
    const given = inputs();
    const { unmount } = renderHook(() => useScriptControls(given));
    expect(scriptControls()!.contrast(1, 10, 300)).toEqual({ applied: true, reason: null });
    expect(given.setChannelContrast).toHaveBeenCalledWith("ds-1", 1, 10, 300);
    expect(scriptControls()!.contrast(2, 10, 300)).toEqual({
      applied: false,
      reason: "ds-1 has 2 channel(s), so there is no channel 2",
    });
    unmount();
  });

  it("adds a dataset through the dialog's handler and answers once it opens or fails", async () => {
    const given = inputs();
    const { unmount } = renderHook(() => useScriptControls(given));
    const url = normalize_dataset_url("/data/b.zarr");
    const added = scriptControls()!.addDataset("/data/b.zarr", 5000);
    await vi.waitFor(() => expect(given.openDataset).toHaveBeenCalledWith(url));
    noteDatasetOpened("wds-b");
    await expect(added).resolves.toEqual({ applied: true, reason: null });

    const failed = scriptControls()!.addDataset("/data/c.zarr", 5000);
    await vi.waitFor(() => expect(given.openDataset).toHaveBeenCalledTimes(2));
    noteDatasetOpenFailed(normalize_dataset_url("/data/c.zarr"), "not found");
    await expect(failed).resolves.toMatchObject({ applied: false });
    unmount();
  });

  it("refuses to add a dataset that is open, and removes one by the URL it was opened from", async () => {
    const url = normalize_dataset_url("/data/b.zarr");
    const datasets = new Map<string, DatasetState>();
    datasets.set("wds-b", dataset("wds-b"));
    const given = inputs({
      datasetsRef: { current: datasets },
      datasetHealth: () => Promise.resolve([{ workspace_dataset_id: "wds-b", source_url: url }]),
    });
    const { unmount } = renderHook(() => useScriptControls(given));
    await expect(scriptControls()!.addDataset("/data/b.zarr", 5000)).resolves.toEqual({
      applied: false,
      reason: `${url} is already open as wds-b`,
    });
    expect(given.openDataset).not.toHaveBeenCalled();
    await expect(scriptControls()!.removeDataset("/data/b.zarr")).resolves.toEqual({ applied: true, reason: null });
    expect(given.removeDataset).toHaveBeenCalledWith("wds-b");
    await expect(scriptControls()!.removeDataset("/data/c.zarr")).resolves.toEqual({
      applied: false,
      reason: `no dataset opened from ${normalize_dataset_url("/data/c.zarr")} is open`,
    });
    unmount();
  });

  it("says so when it cannot read which dataset a remove names", async () => {
    const given = inputs({ datasetHealth: () => Promise.reject(new Error("the session socket is not connected")) });
    const { unmount } = renderHook(() => useScriptControls(given));
    await expect(scriptControls()!.removeDataset("/data/b.zarr")).resolves.toEqual({
      applied: false,
      reason: `the page could not read which dataset ${normalize_dataset_url("/data/b.zarr")} is: the session socket is not connected`,
    });
    expect(given.removeDataset).not.toHaveBeenCalled();
    unmount();
  });

  it("hands the view read straight through", () => {
    const view = { v: 1 } as never;
    const { unmount } = renderHook(() => useScriptControls(inputs({ captureView: () => view })));
    expect(scriptControls()!.view()).toBe(view);
    unmount();
  });
});
