/**
 * Tests for the label hover-settle decision (`resolveLabelHover`) — the pure
 * logic behind the SliceViewer tooltip, exercised with a tiny scene mock + a
 * stub sampler (no DOM / worker / GPU).
 *
 * Covers the slice's gating contract:
 *  - a non-zero pick on an effectively-visible label → tooltip with id + rows;
 *  - `value === 0` (background) → no tooltip;
 *  - `opacity === 0` → no tooltip (label not effectively visible);
 *  - `visible === false` (hidden) → no tooltip;
 *  - a ray miss → no tooltip;
 *  - the top-most (highest index) effectively-visible label wins an overlap;
 *  - the voxel is normalized by the primary shape before sampling.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveLabelHover, type HoverScene } from "./resolveLabelHover.ts";
import type { LabelOverlayView } from "../manifestTypes.ts";

const DS = "ds1";

function overlay(overrides: Partial<LabelOverlayView>): LabelOverlayView {
  return {
    image_id: "img",
    index: 0,
    name: "nuclei",
    visible: true,
    opacity: 0.5,
    num_colors: 1,
    source_image: null,
    ...overrides,
  };
}

/** A scene mock returning fixed overlays, a fixed pick, a fixed shape, and a
 * properties table keyed by (labelIndex, value). */
function makeScene(opts: {
  overlays: LabelOverlayView[];
  pick?: number[]; // [] simulates a ray miss
  shape?: number[]; // [Z, Y, X]
  properties?: Record<string, Record<string, unknown> | null>; // key `${idx}:${value}`
}): HoverScene {
  return {
    label_overlays: () => JSON.stringify(opts.overlays),
    pick_annotation_voxel: () => (opts.pick ?? [50, 60, 7]) as unknown as Float64Array,
    dataset_volume_shape: () => (opts.shape ?? [10, 100, 100]) as unknown as Uint32Array,
    label_property: (_ds, idx, value) => {
      const fields = opts.properties?.[`${idx}:${value}`] ?? null;
      return JSON.stringify(fields);
    },
  };
}

describe("resolveLabelHover", () => {
  it("shows the id + property rows for a non-zero pick on a visible label", async () => {
    const scene = makeScene({
      overlays: [overlay({ index: 0, name: "nuclei", visible: true, opacity: 0.5 })],
      properties: { "0:42": { area: 128, name: "cell-a" } },
    });
    const sample = vi.fn().mockResolvedValue(42);

    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res).not.toBeNull();
    expect(res!.name).toBe("nuclei");
    expect(res!.value).toBe(42);
    expect(res!.rows).toEqual([
      { key: "area", value: "128" },
      { key: "name", value: "cell-a" },
    ]);
  });

  it("shows the id with no rows when the value declares no properties", async () => {
    const scene = makeScene({
      overlays: [overlay({ index: 0, visible: true, opacity: 0.5 })],
      properties: {}, // label_property returns null for 42
    });
    const sample = vi.fn().mockResolvedValue(42);
    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res).not.toBeNull();
    expect(res!.value).toBe(42);
    expect(res!.rows).toEqual([]);
  });

  it("no tooltip when the picked value is 0 (background)", async () => {
    const scene = makeScene({
      overlays: [overlay({ index: 0, visible: true, opacity: 0.5 })],
    });
    const sample = vi.fn().mockResolvedValue(0);
    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res).toBeNull();
  });

  it("no tooltip when the label opacity is 0 (not effectively visible)", async () => {
    const scene = makeScene({
      overlays: [overlay({ index: 0, visible: true, opacity: 0 })],
    });
    // Even if a value would come back, the label is filtered out before sampling.
    const sample = vi.fn().mockResolvedValue(42);
    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res).toBeNull();
    expect(sample).not.toHaveBeenCalled();
  });

  it("no tooltip when the label is hidden (visible === false)", async () => {
    const scene = makeScene({
      overlays: [overlay({ index: 0, visible: false, opacity: 0.8 })],
    });
    const sample = vi.fn().mockResolvedValue(42);
    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res).toBeNull();
    expect(sample).not.toHaveBeenCalled();
  });

  it("no tooltip when the ray misses the volume (empty pick)", async () => {
    const scene = makeScene({
      overlays: [overlay({ index: 0, visible: true, opacity: 0.5 })],
      pick: [],
    });
    const sample = vi.fn().mockResolvedValue(42);
    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res).toBeNull();
    expect(sample).not.toHaveBeenCalled();
  });

  it("prefers the top-most (highest index) effectively-visible label on overlap", async () => {
    const scene = makeScene({
      overlays: [
        overlay({ index: 0, name: "low", visible: true, opacity: 0.5 }),
        overlay({ index: 1, name: "high", visible: true, opacity: 0.5 }),
      ],
      properties: { "1:7": { tag: "top" } },
    });
    // Both labels have a value here; the higher index (queried first) wins.
    const sample = vi.fn(async (_ds, idx) => (idx === 1 ? 7 : 5));
    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res!.name).toBe("high");
    expect(res!.value).toBe(7);
    // The lower label is never sampled once the top one hits.
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample.mock.calls[0][1]).toBe(1);
  });

  it("falls through to a lower label when the top one is background here", async () => {
    const scene = makeScene({
      overlays: [
        overlay({ index: 0, name: "low", visible: true, opacity: 0.5 }),
        overlay({ index: 1, name: "high", visible: true, opacity: 0.5 }),
      ],
    });
    const sample = vi.fn(async (_ds, idx) => (idx === 1 ? 0 : 9));
    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res!.name).toBe("low");
    expect(res!.value).toBe(9);
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it("normalizes the picked voxel by the primary shape before sampling", async () => {
    const scene = makeScene({
      overlays: [overlay({ index: 0, visible: true, opacity: 0.5 })],
      pick: [50, 60, 7],
      shape: [10, 100, 100], // [Z, Y, X] → primaryShape passed as [X, Y, Z]
      properties: { "0:3": {} },
    });
    const sample = vi.fn().mockResolvedValue(3);
    await resolveLabelHover(scene, sample, DS, 100, 120);
    // sample receives the raw voxel + primaryShape [X, Y, Z] = [100, 100, 10];
    // the worker does the division. Assert the plumbing passed both correctly.
    expect(sample).toHaveBeenCalledWith(DS, 0, [50, 60, 7], [100, 100, 10]);
  });

  it("no tooltip when the dataset has no labels", async () => {
    const scene = makeScene({ overlays: [] });
    const sample = vi.fn().mockResolvedValue(42);
    const res = await resolveLabelHover(scene, sample, DS, 100, 120);
    expect(res).toBeNull();
    expect(sample).not.toHaveBeenCalled();
  });
});
