// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSeedDatasetOpens } from "./useSeedDatasetOpens.ts";
import type { DatasetSeed } from "../workspaceFromDataset.ts";

const together = (urls: readonly string[]): DatasetSeed => ({ urls, sideBySide: false });
const noViews = () => [];

describe("useSeedDatasetOpens", () => {
  it("opens the single seed dataset once ready", () => {
    const openDataset = vi.fn();
    renderHook(() =>
      useSeedDatasetOpens({
        seed: together(["/data/sample.ome.zarr"]),
        ready: true,
        openDataset,
        viewsForEach: noViews,
      }),
    );
    expect(openDataset).toHaveBeenCalledTimes(1);
    expect(openDataset).toHaveBeenCalledWith("/data/sample.ome.zarr", null);
  });

  it("opens ALL seed datasets for a multi-select create", () => {
    const openDataset = vi.fn();
    renderHook(() =>
      useSeedDatasetOpens({
        seed: together(["/a.zarr", "gs://bucket/b.zarr", "/c.zarr"]),
        ready: true,
        openDataset,
        viewsForEach: noViews,
      }),
    );
    expect(openDataset).toHaveBeenCalledTimes(3);
    expect(openDataset.mock.calls.map((c) => c[0])).toEqual([
      "/a.zarr",
      "gs://bucket/b.zarr",
      "/c.zarr",
    ]);
  });

  it("opens a side-by-side seed one dataset to a view, in order", () => {
    const openDataset = vi.fn();
    const viewsForEach = vi.fn(() => [0, 3, 4, 5]);
    renderHook(() =>
      useSeedDatasetOpens({
        seed: { urls: ["/a.zarr", "/b.zarr", "/c.zarr"], sideBySide: true },
        ready: true,
        openDataset,
        viewsForEach,
      }),
    );
    expect(viewsForEach).toHaveBeenCalledExactlyOnceWith(3);
    expect(openDataset.mock.calls).toEqual([
      ["/a.zarr", 0],
      ["/b.zarr", 3],
      ["/c.zarr", 4],
    ]);
  });

  it("leaves the views alone for one dataset, even side by side", () => {
    const openDataset = vi.fn();
    const viewsForEach = vi.fn(() => [0]);
    renderHook(() =>
      useSeedDatasetOpens({
        seed: { urls: ["/a.zarr"], sideBySide: true },
        ready: true,
        openDataset,
        viewsForEach,
      }),
    );
    expect(viewsForEach).not.toHaveBeenCalled();
    expect(openDataset).toHaveBeenCalledWith("/a.zarr", null);
  });

  it("defers until ready, then fires exactly once", () => {
    const openDataset = vi.fn();
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useSeedDatasetOpens({
          seed: together(["/a.zarr"]),
          ready,
          openDataset,
          viewsForEach: noViews,
        }),
      { initialProps: { ready: false } },
    );
    // Not ready → nothing opened yet (transport not up).
    expect(openDataset).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(openDataset).toHaveBeenCalledTimes(1);

    // A later re-render must not re-open.
    rerender({ ready: true });
    expect(openDataset).toHaveBeenCalledTimes(1);
  });

  it("is a no-op with no seed (normal open-existing-workspace case)", () => {
    const openDataset = vi.fn();
    const { rerender } = renderHook(
      ({ seed }: { seed?: DatasetSeed }) =>
        useSeedDatasetOpens({
          seed,
          ready: true,
          openDataset,
          viewsForEach: noViews,
        }),
      { initialProps: { seed: undefined } as { seed?: DatasetSeed } },
    );
    expect(openDataset).not.toHaveBeenCalled();
    rerender({ seed: together([]) });
    expect(openDataset).not.toHaveBeenCalled();
  });

  it("only fires after the seed itself arrives (seed set on a later render)", () => {
    // The seed can arrive a render after `ready` (the route may resolve the
    // workspace, mount, connect, THEN deliver the seed). Fire when both hold.
    const openDataset = vi.fn();
    const { rerender } = renderHook(
      ({ seed }: { seed?: DatasetSeed }) =>
        useSeedDatasetOpens({
          seed,
          ready: true,
          openDataset,
          viewsForEach: noViews,
        }),
      { initialProps: { seed: undefined } as { seed?: DatasetSeed } },
    );
    expect(openDataset).not.toHaveBeenCalled();
    rerender({ seed: together(["/late.zarr"]) });
    expect(openDataset).toHaveBeenCalledTimes(1);
    expect(openDataset).toHaveBeenCalledWith("/late.zarr", null);
  });
});
