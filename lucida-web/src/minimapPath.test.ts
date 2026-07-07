import { describe, expect, it } from "vitest";

import type { WasmScene } from "lucida-core";
import { identityModelMatrix, intersectSliceViewWithMember, minimapCoarseLevelIndex, readMemberRenderMatrices, resolveMinimapLayerContrast, resolveMinimapLayerColormap } from "./minimapPath.ts";
import type { MultiscaleInfo } from "./manifestTypes.ts";

function multiscale(coarseLevelIndex?: number | null): Pick<MultiscaleInfo, "levels" | "coarse_level_index"> {
  return {
    coarse_level_index: coarseLevelIndex,
    levels: [
      { level_index: 0, shape: [1, 1, 1, 1024, 1024], chunk_shape: [1, 1, 1, 256, 256], grid_shape: [1, 1, 1, 4, 4], scale: [1, 1, 1, 1, 1] },
      { level_index: 1, shape: [1, 1, 1, 512, 512], chunk_shape: [1, 1, 1, 256, 256], grid_shape: [1, 1, 1, 2, 2], scale: [1, 1, 1, 2, 2] },
      { level_index: 2, shape: [1, 1, 1, 256, 256], chunk_shape: [1, 1, 1, 256, 256], grid_shape: [1, 1, 1, 1, 1], scale: [1, 1, 1, 4, 4] },
    ],
  };
}

describe("minimapCoarseLevelIndex", () => {
  it("uses the explicit coarse level when present", () => {
    expect(minimapCoarseLevelIndex(multiscale(1))).toBe(1);
  });

  it("does not guess a coarse level when no coarse pointer exists", () => {
    expect(minimapCoarseLevelIndex(multiscale(null))).toBeNull();
    expect(minimapCoarseLevelIndex(multiscale(undefined))).toBeNull();
  });

  it("resolves by level_index before falling back to array index", () => {
    const ms = multiscale(8);
    ms.levels[1] = { ...ms.levels[1], level_index: 8 };
    expect(minimapCoarseLevelIndex(ms)).toBe(1);
  });

  it("uses an appended generated coarse level by level_index", () => {
    const ms = multiscale(8);
    ms.levels.push({
      level_index: 8,
      shape: [1, 1, 1, 128, 128],
      chunk_shape: [1, 1, 1, 128, 128],
      grid_shape: [1, 1, 1, 1, 1],
      scale: [1, 1, 1, 8, 8],
    });
    expect(minimapCoarseLevelIndex(ms)).toBe(3);
  });

  it("uses array index for legacy metadata with no matching level_index", () => {
    const ms = multiscale(1);
    ms.levels = ms.levels.map((level, idx) => ({ ...level, level_index: idx + 10 }));
    expect(minimapCoarseLevelIndex(ms)).toBe(1);
  });
});

describe("resolveMinimapLayerContrast", () => {
  const dataset = { contrast_min: 0, contrast_max: 65535, gamma: 1 };

  it("prefers the active channel's contrast/gamma over the dataset-level default", () => {
    // The bug: auto-contrast is applied per-channel (set_channel_contrast), so the
    // dataset-level contrast stays at the full-range default while the channel holds
    // the real range. The minimap must use the channel's values like the main view.
    const settings = {
      ...dataset,
      channel_settings: [
        { contrast_min: 0, contrast_max: 148, gamma: 0.8 },
        { contrast_min: 10, contrast_max: 200, gamma: 1.2 },
      ],
    };
    expect(resolveMinimapLayerContrast(settings, 0)).toEqual({ contrastMin: 0, contrastMax: 148, gamma: 0.8 });
    expect(resolveMinimapLayerContrast(settings, 1)).toEqual({ contrastMin: 10, contrastMax: 200, gamma: 1.2 });
  });

  it("falls back to dataset-level contrast when there are no channel settings", () => {
    expect(resolveMinimapLayerContrast(dataset, 0)).toEqual({ contrastMin: 0, contrastMax: 65535, gamma: 1 });
  });

  it("falls back to dataset-level when the active channel index is out of range", () => {
    const settings = { ...dataset, channel_settings: [{ contrast_min: 0, contrast_max: 148, gamma: 0.8 }] };
    expect(resolveMinimapLayerContrast(settings, 3)).toEqual({ contrastMin: 0, contrastMax: 65535, gamma: 1 });
  });
});

describe("resolveMinimapLayerColormap", () => {
  const ch = (colormap: string) => ({ contrast_min: 0, contrast_max: 1, gamma: 1, colormap });

  it("uses the active channel's colormap (so 2D matches 3D, not gray)", () => {
    const settings = { contrast_min: 0, contrast_max: 65535, gamma: 1, channel_settings: [ch("magenta"), ch("green")] };
    expect(resolveMinimapLayerColormap(settings, 0)).toBe("magenta");
    expect(resolveMinimapLayerColormap(settings, 1)).toBe("green");
  });

  it("falls back to gray when there are no channel settings", () => {
    expect(resolveMinimapLayerColormap({ contrast_min: 0, contrast_max: 65535, gamma: 1 }, 0)).toBe("gray");
  });

  it("falls back to gray when the active channel index is out of range", () => {
    const settings = { contrast_min: 0, contrast_max: 65535, gamma: 1, channel_settings: [ch("magenta")] };
    expect(resolveMinimapLayerColormap(settings, 5)).toBe("gray");
  });
});

describe("intersectSliceViewWithMember", () => {
  const modelMatrix = new Float32Array(16);

  it("keeps bounds unchanged for a member at scene origin", () => {
    const viewport = intersectSliceViewWithMember(
      { minX: 100, minY: 120, maxX: 300, maxY: 320 },
      {
        datasetId: "collection",
        memberId: "tile-0-image",
        modelMatrix,
        position: [0, 0],
        width: 500,
        height: 500,
        depth: 9,
      },
    );

    expect(viewport?.bounds).toEqual({ minX: 100, minY: 120, maxX: 300, maxY: 320 });
    expect(viewport?.memberId).toBe("tile-0-image");
  });

  it("translates scene bounds into member-local coordinates", () => {
    const viewport = intersectSliceViewWithMember(
      { minX: 1100, minY: 2100, maxX: 1300, maxY: 2300 },
      {
        datasetId: "collection",
        memberId: "tile-1-image",
        modelMatrix,
        position: [1000, 2000],
        width: 500,
        height: 500,
        depth: 9,
      },
    );

    expect(viewport?.bounds).toEqual({ minX: 100, minY: 100, maxX: 300, maxY: 300 });
  });

  it("clamps partially overlapping bounds to the member extent", () => {
    const viewport = intersectSliceViewWithMember(
      { minX: 900, minY: 1900, maxX: 1100, maxY: 2100 },
      {
        datasetId: "collection",
        memberId: "tile-1-image",
        modelMatrix,
        position: [1000, 2000],
        width: 500,
        height: 500,
        depth: 9,
      },
    );

    expect(viewport?.bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it("returns null when the scene bounds do not overlap the member", () => {
    const viewport = intersectSliceViewWithMember(
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      {
        datasetId: "collection",
        memberId: "tile-1-image",
        modelMatrix,
        position: [1000, 2000],
        width: 500,
        height: 500,
        depth: 9,
      },
    );

    expect(viewport).toBeNull();
  });
});

describe("readMemberRenderMatrices", () => {
  /** Flat 32-floats-per-member payload: member i gets model filled with
   *  `i + 1` and inverse filled with `-(i + 1)`, so tests can tell blocks
   *  (and halves of blocks) apart. */
  function sceneWith(ids: string[], idsJson?: string): WasmScene {
    const flat = new Float32Array(ids.length * 32);
    for (let i = 0; i < ids.length; i++) {
      flat.fill(i + 1, i * 32, i * 32 + 16);
      flat.fill(-(i + 1), i * 32 + 16, i * 32 + 32);
    }
    return {
      member_render_ids: () => idsJson ?? JSON.stringify(ids),
      member_render_matrices: () => flat,
    } as unknown as WasmScene;
  }

  it("maps each id to its own 16+16 float block", () => {
    const matrices = readMemberRenderMatrices(sceneWith(["a", "b"]), "ds");
    expect([...matrices.keys()]).toEqual(["a", "b"]);
    expect(Array.from(matrices.get("b")!.model)).toEqual(Array(16).fill(2));
    expect(Array.from(matrices.get("b")!.invModel)).toEqual(Array(16).fill(-2));
    // Blocks are independent copies, not views that alias each other.
    expect(matrices.get("a")!.model).toHaveLength(16);
    expect(Array.from(matrices.get("a")!.invModel)).toEqual(Array(16).fill(-1));
  });

  it("keeps the first block for a duplicated id, like the per-id lookup", () => {
    const matrices = readMemberRenderMatrices(sceneWith(["dup", "dup"]), "ds");
    expect(matrices.size).toBe(1);
    expect(Array.from(matrices.get("dup")!.model)).toEqual(Array(16).fill(1));
  });

  it("returns an empty map when the id payload is malformed", () => {
    const matrices = readMemberRenderMatrices(sceneWith(["a"], "not json"), "ds");
    expect(matrices.size).toBe(0);
  });
});

describe("identityModelMatrix", () => {
  it("is the 4x4 identity, fresh per call", () => {
    const a = identityModelMatrix();
    expect(Array.from(a)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(identityModelMatrix()).not.toBe(a);
  });
});
