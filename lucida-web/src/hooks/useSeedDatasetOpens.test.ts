// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSeedDatasetOpens } from "./useSeedDatasetOpens.ts";

describe("useSeedDatasetOpens", () => {
  it("opens the single seed dataset once ready", () => {
    const openDataset = vi.fn();
    renderHook(() =>
      useSeedDatasetOpens({
        initialDatasetUrls: ["/data/sample.ome.zarr"],
        ready: true,
        openDataset,
      }),
    );
    expect(openDataset).toHaveBeenCalledTimes(1);
    expect(openDataset).toHaveBeenCalledWith("/data/sample.ome.zarr");
  });

  it("opens ALL seed datasets for a multi-select create", () => {
    const openDataset = vi.fn();
    renderHook(() =>
      useSeedDatasetOpens({
        initialDatasetUrls: ["/a.zarr", "gs://bucket/b.zarr", "/c.zarr"],
        ready: true,
        openDataset,
      }),
    );
    expect(openDataset).toHaveBeenCalledTimes(3);
    expect(openDataset.mock.calls.map((c) => c[0])).toEqual([
      "/a.zarr",
      "gs://bucket/b.zarr",
      "/c.zarr",
    ]);
  });

  it("defers until ready, then fires exactly once", () => {
    const openDataset = vi.fn();
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useSeedDatasetOpens({
          initialDatasetUrls: ["/a.zarr"],
          ready,
          openDataset,
        }),
      { initialProps: { ready: false } },
    );
    // Not ready → nothing opened yet (transport not up).
    expect(openDataset).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(openDataset).toHaveBeenCalledTimes(1);

    // A subsequent re-render must NOT re-open (one-shot guard).
    rerender({ ready: true });
    expect(openDataset).toHaveBeenCalledTimes(1);
  });

  it("is a no-op with no seed (normal open-existing-workspace case)", () => {
    const openDataset = vi.fn();
    const { rerender } = renderHook(
      ({ urls }: { urls?: readonly string[] }) =>
        useSeedDatasetOpens({
          initialDatasetUrls: urls,
          ready: true,
          openDataset,
        }),
      { initialProps: { urls: undefined } as { urls?: readonly string[] } },
    );
    expect(openDataset).not.toHaveBeenCalled();
    rerender({ urls: [] });
    expect(openDataset).not.toHaveBeenCalled();
  });

  it("only fires after the seed itself arrives (seed set on a later render)", () => {
    // The seed can arrive a render after `ready` (the route may resolve the
    // workspace, mount, connect, THEN deliver the seed). Fire when both hold.
    const openDataset = vi.fn();
    const { rerender } = renderHook(
      ({ urls }: { urls?: readonly string[] }) =>
        useSeedDatasetOpens({
          initialDatasetUrls: urls,
          ready: true,
          openDataset,
        }),
      { initialProps: { urls: undefined } as { urls?: readonly string[] } },
    );
    expect(openDataset).not.toHaveBeenCalled();
    rerender({ urls: ["/late.zarr"] });
    expect(openDataset).toHaveBeenCalledTimes(1);
    expect(openDataset).toHaveBeenCalledWith("/late.zarr");
  });
});
