// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLabelRescueOnOpen } from "./useLabelRescueOnOpen.ts";
import type { LabelViewSetting } from "../pipeline/planning/labelRequests.ts";
import type { DatasetManifest, ImageSpec, LabelSpec } from "../manifestTypes.ts";

const AXES = [
  { name: "t", kind: "time" },
  { name: "c", kind: "channel" },
  { name: "z", kind: "space" },
  { name: "y", kind: "space" },
  { name: "x", kind: "space" },
];

function img(id: string, dtype: string, shape: number[], chunk: number[]): ImageSpec {
  return {
    image_id: id,
    owner: "ent-0",
    multiscale: {
      axes: AXES,
      levels: [{ level_index: 0, shape, chunk_shape: chunk, grid_shape: [1, 1, 1, 1, 1], scale: [1, 1, 1, 1, 1] }],
      data_type: dtype,
    },
  } as ImageSpec;
}

// slice-eligible but volume-ineligible (Z busts the 3D cap, no coarser level).
const deepZ: LabelSpec = {
  name: "deep",
  source_image_id: "img-0",
  image: img("img-0:label:deep", "Uint32", [1, 1, 4096, 64, 64], [1, 1, 1, 64, 64]),
} as LabelSpec;
const flat: LabelSpec = {
  name: "flat",
  source_image_id: "img-0",
  image: img("img-0:label:flat", "Uint32", [1, 1, 1, 64, 64], [1, 1, 1, 64, 64]),
} as LabelSpec;

function manifest(labels: LabelSpec[]): DatasetManifest {
  return {
    dataset_id: "ds-0", name: "vol", kind: "Single",
    entities: [], transforms: [], source_layouts: [], default_layout_id: null,
    images: [img("img-0", "Uint16", [1, 1, 1, 340, 348], [1, 1, 1, 128, 128])],
    labels,
  } as DatasetManifest;
}

// Seed marks the deep-Z label (index 0) visible; the flat label (index 1) hidden.
const seededBlankInVolume: LabelViewSetting[] = [
  { visible: true, opacity: 0.5 },
  { visible: false, opacity: 0.5 },
];

describe("useLabelRescueOnOpen", () => {
  it("reveals the first mode-eligible label when the seeded one can't draw in 3D", () => {
    const emitRescue = vi.fn();
    renderHook(() =>
      useLabelRescueOnOpen({
        openDatasetIds: ["ds-0"],
        ready: true,
        viewMode: "3d",
        manifestOf: () => manifest([deepZ, flat]),
        labelSettingsOf: () => seededBlankInVolume,
        emitRescue,
      }),
    );
    expect(emitRescue).toHaveBeenCalledTimes(1);
    expect(emitRescue).toHaveBeenCalledWith("ds-0", 1);
  });

  it("does NOT rescue in 2D where the seeded label is drawable", () => {
    const emitRescue = vi.fn();
    renderHook(() =>
      useLabelRescueOnOpen({
        openDatasetIds: ["ds-0"],
        ready: true,
        viewMode: "2d",
        manifestOf: () => manifest([deepZ, flat]),
        labelSettingsOf: () => seededBlankInVolume,
        emitRescue,
      }),
    );
    expect(emitRescue).not.toHaveBeenCalled();
  });

  it("does not run (or latch) until ready, then fires exactly once", () => {
    const emitRescue = vi.fn();
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) =>
        useLabelRescueOnOpen({
          openDatasetIds: ["ds-0"],
          ready,
          viewMode: "3d",
          manifestOf: () => manifest([deepZ, flat]),
          labelSettingsOf: () => seededBlankInVolume,
          emitRescue,
        }),
      { initialProps: { ready: false } },
    );
    expect(emitRescue).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(emitRescue).toHaveBeenCalledTimes(1);
    rerender({ ready: true });
    expect(emitRescue).toHaveBeenCalledTimes(1);
  });

  it("waits (without latching) until the manifest is available", () => {
    const emitRescue = vi.fn();
    const { rerender } = renderHook(
      ({ hasManifest }: { hasManifest: boolean }) =>
        useLabelRescueOnOpen({
          openDatasetIds: ["ds-0"],
          ready: true,
          viewMode: "3d",
          manifestOf: () => (hasManifest ? manifest([deepZ, flat]) : undefined),
          labelSettingsOf: () => seededBlankInVolume,
          emitRescue,
        }),
      { initialProps: { hasManifest: false } },
    );
    // Manifest not ready yet → no rescue, and the one-shot is NOT burned.
    expect(emitRescue).not.toHaveBeenCalled();
    rerender({ hasManifest: true });
    expect(emitRescue).toHaveBeenCalledTimes(1);
  });

  it("latches at the first ready evaluation so a later 2D→3D switch never re-fires", () => {
    // Opens in 2D (no rescue needed) — but the latch still fires, so switching to
    // 3D afterward must NOT re-reveal the label the user could have hidden.
    const emitRescue = vi.fn();
    const { rerender } = renderHook(
      ({ viewMode }: { viewMode: "2d" | "3d" }) =>
        useLabelRescueOnOpen({
          openDatasetIds: ["ds-0"],
          ready: true,
          viewMode,
          manifestOf: () => manifest([deepZ, flat]),
          labelSettingsOf: () => seededBlankInVolume,
          emitRescue,
        }),
      { initialProps: { viewMode: "2d" as "2d" | "3d" } },
    );
    expect(emitRescue).not.toHaveBeenCalled();
    rerender({ viewMode: "3d" });
    // Already latched in 2D → no rescue despite 3D now being blank-eligible.
    expect(emitRescue).not.toHaveBeenCalled();
  });

  it("keeps the latch through a transient empty open list so a repopulate never re-reveals", () => {
    // A render where the open list momentarily reads [] (scene reinit / a scene
    // getter faulting) must NOT wipe the one-shot latch. Otherwise the datasets
    // reappear un-latched, the rescue re-fires, and it re-reveals the very label
    // the user has since hidden — exactly the self-revealing overlay this repair
    // exists to prevent. `seededBlankInVolume` is also the post-hide state (the
    // rescued flat label hidden, the ineligible deep-Z label still on), so a
    // re-fire here WOULD re-reveal flat.
    const emitRescue = vi.fn();
    const { rerender } = renderHook(
      ({ openDatasetIds }: { openDatasetIds: readonly string[] }) =>
        useLabelRescueOnOpen({
          openDatasetIds,
          ready: true,
          viewMode: "3d",
          manifestOf: () => manifest([deepZ, flat]),
          labelSettingsOf: () => seededBlankInVolume,
          emitRescue,
        }),
      { initialProps: { openDatasetIds: ["ds-0"] as readonly string[] } },
    );
    expect(emitRescue).toHaveBeenCalledTimes(1);
    // Transient empty render — the latch must survive it.
    rerender({ openDatasetIds: [] });
    // Datasets reappear — still latched, so no re-fire and no re-reveal.
    rerender({ openDatasetIds: ["ds-0"] });
    expect(emitRescue).toHaveBeenCalledTimes(1);
  });

  it("re-arms the rescue after a genuine close then reopen", () => {
    // Contrast with the transient-empty case: while the open list is genuinely
    // non-empty, an id that leaves IS a real close and its latch is pruned, so
    // reopening earns a fresh rescue.
    const emitRescue = vi.fn();
    const { rerender } = renderHook(
      ({ openDatasetIds }: { openDatasetIds: readonly string[] }) =>
        useLabelRescueOnOpen({
          openDatasetIds,
          ready: true,
          viewMode: "3d",
          manifestOf: () => manifest([deepZ, flat]),
          labelSettingsOf: () => seededBlankInVolume,
          emitRescue,
        }),
      { initialProps: { openDatasetIds: ["ds-0", "ds-keep"] as readonly string[] } },
    );
    expect(emitRescue).toHaveBeenCalledTimes(2);
    // ds-0 closes while ds-keep stays open — a real partial change prunes ds-0.
    rerender({ openDatasetIds: ["ds-keep"] });
    // ds-0 reopens — its latch was pruned, so it is rescued afresh.
    rerender({ openDatasetIds: ["ds-0", "ds-keep"] });
    expect(emitRescue).toHaveBeenCalledTimes(3);
    expect(emitRescue.mock.calls.map((c) => c[0])).toEqual(["ds-0", "ds-keep", "ds-0"]);
  });

  it("rescues each dataset independently", () => {
    const emitRescue = vi.fn();
    renderHook(() =>
      useLabelRescueOnOpen({
        openDatasetIds: ["ds-a", "ds-b"],
        ready: true,
        viewMode: "3d",
        manifestOf: () => manifest([deepZ, flat]),
        labelSettingsOf: () => seededBlankInVolume,
        emitRescue,
      }),
    );
    expect(emitRescue).toHaveBeenCalledTimes(2);
    expect(emitRescue.mock.calls.map((c) => c[0])).toEqual(["ds-a", "ds-b"]);
  });
});
