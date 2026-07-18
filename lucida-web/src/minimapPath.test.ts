import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WasmScene } from "lucida-core";
import { createMinimapState, identityModelMatrix, intersectSliceViewWithMember, minimapCoarseLevelIndex, readCameraViewRotation, readMemberRenderMatrices, readMinimapOverviewEpochs, resolveMinimapLayerContrast, resolveMinimapLayerColormap, tickMinimap, tickMinimapOverview } from "./minimapPath.ts";
import type { MinimapState } from "./minimapPath.ts";
import type { MultiscaleInfo } from "./manifestTypes.ts";
import type { TickContext, MinimapOverlayData } from "./renderLoopTypes.ts";
import type { RenderClient } from "./renderer/renderClient.ts";

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

describe("readMinimapOverviewEpochs", () => {
  it("reads content and layout from the epochs JSON", () => {
    const scene = {
      epochs: () => JSON.stringify({ content: 7, layout: 3, view: 99, selection: 5, asset: 2 }),
    } as unknown as WasmScene;
    expect(readMinimapOverviewEpochs(scene)).toEqual({ content: 7, layout: 3 });
  });

  it("falls back to a stable constant when epochs() is absent (older build)", () => {
    const scene = {} as unknown as WasmScene;
    expect(readMinimapOverviewEpochs(scene)).toEqual({ content: 0, layout: 0 });
  });

  it("falls back to a stable constant when the payload is malformed", () => {
    const scene = { epochs: () => "not json" } as unknown as WasmScene;
    expect(readMinimapOverviewEpochs(scene)).toEqual({ content: 0, layout: 0 });
  });
});

describe("readCameraViewRotation", () => {
  it("uses the authoritative wasm basis, including fly roll", () => {
    const rolled = new Float32Array([0, -1, 0, 1, 0, 0, 0, 0, 1]);
    const scene = {
      camera_view_rotation: () => rolled,
      camera_theta: () => 0.5,
      camera_phi: () => 0.8,
    } as unknown as WasmScene;

    expect(Array.from(readCameraViewRotation(scene))).toEqual(Array.from(rolled));
  });
});

describe("tickMinimap overview/overlay split", () => {
  /**
   * A mutable fake scene exposing just the surface `tickMinimap` reads, so a
   * test can move the main camera and observe which work reruns.
   */
  interface FakeScene {
    theta: number;
    phi: number;
    activeC: number;
    z: number;
    zoom: number;
    center: [number, number];
    eye: [number, number, number];
    /**
     * The MAIN camera's inverse view-projection — the frustum's source. In fly
     * mode a pure look-around changes ONLY this (eye + theta/phi stay fixed).
     */
    invViewProj: number[];
    viewRotation: number[];
    order: string;
    settings: string;
    /** Bumped by a dataset add/remove (see readMinimapOverviewEpochs). */
    contentEpoch: number;
    /** Bumped by a layout switch / member reflow. */
    layoutEpoch: number;
    wasm: WasmScene;
  }

  function makeScene(): FakeScene {
    const s: FakeScene = {
      theta: 0.5,
      phi: 1.2,
      activeC: 0,
      z: 0,
      zoom: 1,
      center: [0, 0],
      eye: [0, 0, 10],
      invViewProj: new Array<number>(16).fill(0),
      viewRotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      order: JSON.stringify(["ds"]),
      settings: JSON.stringify({
        ds: { visible: true, opacity: 1, blend_mode: "normal", contrast_min: 0, contrast_max: 65535, gamma: 1 },
      }),
      contentEpoch: 0,
      layoutEpoch: 0,
      wasm: undefined as unknown as WasmScene,
    };
    s.wasm = {
      camera_theta: () => s.theta,
      camera_phi: () => s.phi,
      camera_view_rotation: () => new Float32Array(s.viewRotation),
      all_dataset_settings: () => s.settings,
      dataset_order: () => s.order,
      c: () => s.activeC,
      z: () => s.z,
      t: () => 0,
      zoom: () => s.zoom,
      center: () => s.center,
      eye_position: () => new Float32Array(s.eye),
      epochs: () =>
        JSON.stringify({ content: s.contentEpoch, layout: s.layoutEpoch, view: 0, selection: 0 }),
      // 35 floats: [0..16) invViewProj, [16..19) eye, [19..35) viewProj.
      minimap_camera: () => new Float32Array(35),
      member_positions: () => JSON.stringify({ m0: [0, 0] }),
      member_render_ids: () => JSON.stringify(["m0"]),
      member_render_matrices: () => new Float32Array(32),
      scene_model_matrix_for: () => new Float32Array(16),
      inv_scene_model_matrix_for: () => new Float32Array(16),
      dataset_volume_shape: () => new Float32Array([9, 500, 500]),
      inv_view_proj: () => new Float32Array(s.invViewProj),
    } as unknown as WasmScene;
    return s;
  }

  function makeDatasets(): TickContext["datasets"] {
    return new Map([
      [
        "ds",
        {
          manifest: {
            images: [
              {
                image_id: "m0",
                owner: "m0",
                // shape is [T, C, Z, Y, X]
                multiscale: { levels: [{ shape: [1, 1, 9, 500, 500] }] },
              },
            ],
          },
        },
      ],
    ]) as unknown as TickContext["datasets"];
  }

  function makeCtx(scene: FakeScene, mode: "slice" | "volume", renderCount: { n: number }): TickContext {
    const client = {
      minimapRender: () => {
        renderCount.n++;
      },
    } as unknown as RenderClient;
    const canvas = { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement;
    return {
      scene: scene.wasm,
      datasets: makeDatasets(),
      client,
      canvas,
      mode,
    } as unknown as TickContext;
  }

  function makeState(overlay: (d: MinimapOverlayData) => void): MinimapState {
    const state = createMinimapState();
    state.enabled = true;
    state.overlayCallback = overlay;
    return state;
  }

  beforeEach(() => {
    globalThis.devicePixelRatio = 2;
  });

  it("skips the O(N) overview redraw on a slice-mode pan but still updates the viewport overlay", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(1);
    const firstBounds = overlay.mock.calls[0][0].sliceViewports[0].bounds;
    // First draw: the static (camera/geometry) overlay layer must be stroked.
    expect(overlay.mock.calls[0][0].staticDirty).toBe(true);

    // Pan the main camera: overlay must recompute, overview must NOT redraw.
    scene.center = [600, 600];
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(2);
    const secondBounds = overlay.mock.calls[1][0].sliceViewports[0].bounds;
    expect(secondBounds).not.toEqual(firstBounds);
    // The static layer (bounding boxes + axis arrows) is drawn in the minimap's
    // OWN fixed viewProj, which a 2D pan of the main view never moves — so it is
    // reused, not re-stroked. Only the dynamic viewport rect above changed.
    expect(overlay.mock.calls[1][0].staticDirty).toBe(false);
  });

  it("skips the O(N) overview redraw on a slice-mode zoom", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    scene.zoom = 4;
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(2);
  });

  it("keeps the slice viewport outline in the same world bounds across DPR", () => {
    const captureAt = (dpr: number) => {
      globalThis.devicePixelRatio = dpr;
      const scene = makeScene();
      scene.center = [250, 250];
      scene.zoom = 2;
      const overlay = vi.fn();
      tickMinimap(makeCtx(scene, "slice", { n: 0 }), makeState(overlay), 0);
      return overlay.mock.calls[0][0].sliceViewports[0].bounds;
    };

    const dpr1 = captureAt(1);
    const dpr2 = captureAt(2);
    expect(dpr2).toEqual(dpr1);
    expect(dpr2).toEqual({ minX: 50, minY: 100, maxX: 450, maxY: 400 });
  });

  it("early-returns when neither the overview nor the camera changed", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(1);
  });

  it("redraws the overview when an overview input changes (active channel, upload, order, settings)", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);

    scene.activeC = 1;
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(2);

    state.uploadGeneration++;
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(3);

    scene.settings = JSON.stringify({
      ds: { visible: true, opacity: 0.5, blend_mode: "normal", contrast_min: 0, contrast_max: 100, gamma: 1 },
    });
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(4);
  });

  it("re-renders the overview on a display-only edit without re-reading members", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    const overlayCallsBefore = overlay.mock.calls.length;

    // Contrast-only edit (same active channel + visibility): the overview must
    // re-render with the new display values, but the O(N) member geometry
    // (positions + matrices) is reused from the cache — no re-read.
    const readSpy = vi.spyOn(scene.wasm, "member_positions");
    const matSpy = vi.spyOn(scene.wasm, "member_render_matrices");
    scene.settings = JSON.stringify({
      ds: { visible: true, opacity: 1, blend_mode: "normal", contrast_min: 0, contrast_max: 100, gamma: 1 },
    });
    tickMinimap(ctx, state, 0);

    expect(renderCount.n).toBe(2);
    expect(readSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
    // The overlay (viewport/frustum) does not depend on display values.
    expect(overlay.mock.calls.length).toBe(overlayCallsBefore);
  });

  it("rebuilds and re-reads members when a dataset's visibility changes", () => {
    const scene = makeScene();
    scene.settings = JSON.stringify({
      ds: { visible: false, opacity: 1, blend_mode: "normal", contrast_min: 0, contrast_max: 65535, gamma: 1 },
    });
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    // Hidden dataset draws nothing.
    expect(renderCount.n).toBe(0);

    // Showing it adds a drawn layer — a geometry change, not a display-only edit —
    // so members must be re-read and the overview rebuilt, even though order/z/
    // channel/upload/epochs are all unchanged.
    const readSpy = vi.spyOn(scene.wasm, "member_positions");
    scene.settings = JSON.stringify({
      ds: { visible: true, opacity: 1, blend_mode: "normal", contrast_min: 0, contrast_max: 65535, gamma: 1 },
    });
    tickMinimap(ctx, state, 0);

    expect(readSpy).toHaveBeenCalled();
    expect(renderCount.n).toBe(1);
  });

  it("skips the O(N) overview redraw on a slice-mode z-scrub but updates the plane indicator", () => {
    // The coarse overview is uploaded per (t, c) for the whole coarse volume
    // and its GPU render takes no Z, so a Z-plane move changes neither the
    // member geometry nor the rendered overview — only the overlay's
    // current-plane indicator. A continuous Z-scrub must therefore reuse the
    // cached overview (no O(members) re-read, no redundant redraw) and refresh
    // just the cheap overlay.
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(overlay.mock.calls[0][0].currentZ).toBe(0);

    const readSpy = vi.spyOn(scene.wasm, "member_positions");
    tickMinimap(ctx, state, 3);

    // Overview NOT redrawn and no members re-read; overlay refreshed with the
    // new plane.
    expect(renderCount.n).toBe(1);
    expect(readSpy).not.toHaveBeenCalled();
    expect(overlay).toHaveBeenCalledTimes(2);
    expect(overlay.mock.calls[1][0].currentZ).toBe(3);
    // Camera/geometry unchanged: the static overlay layer (O(N) member borders)
    // is NOT re-stroked — the consumer reuses its cached static layer and
    // re-strokes only the cheap Z-plane indicator.
    expect(overlay.mock.calls[1][0].staticDirty).toBe(false);
  });

  it("redraws the overview when the layout epoch changes, even on a camera-only tick", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);

    // A layout switch reflows member placement + render matrices and bumps the
    // layout epoch WITHOUT touching order/settings/upload/channel/z. The next
    // tick moves only the camera, yet the overview must rebuild — otherwise it
    // keeps drawing the old placement (and a stale "you are here" rectangle).
    scene.layoutEpoch++;
    scene.center = [1000, 1000];
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(2);
  });

  it("redraws the overview when the content epoch changes on a camera-only tick", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);

    // A dataset add/remove bumps the content epoch; the overview must rebuild so
    // the cache can never serve a removed dataset.
    scene.contentEpoch++;
    scene.center = [500, 500];
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(2);
  });

  it("rebuilds at the new backing size when devicePixelRatio changes before a display-only edit", () => {
    const scene = makeScene();
    // Capture the backing size each overview render is issued at.
    const renderSizes: number[] = [];
    const client = {
      minimapRender: (_l: unknown, _iv: unknown, _e: unknown, w: number) => {
        renderSizes.push(w);
      },
    } as unknown as RenderClient;
    const canvas = { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement;
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = {
      scene: scene.wasm,
      datasets: makeDatasets(),
      client,
      canvas,
      mode: "slice",
    } as unknown as TickContext;

    // First rebuild at DPR 2 → backing size = round(200 × 2) = 400.
    tickMinimap(ctx, state, 0);
    expect(renderSizes).toEqual([400]);

    // Window dragged onto a DPR-1 monitor, then a display-only contrast edit. The
    // DPR change must force a full rebuild at the new backing size (200), not a
    // display-only re-render at the stale 400 cached from the old DPR.
    globalThis.devicePixelRatio = 1;
    const readSpy = vi.spyOn(scene.wasm, "member_positions");
    scene.settings = JSON.stringify({
      ds: { visible: true, opacity: 1, blend_mode: "normal", contrast_min: 0, contrast_max: 100, gamma: 1 },
    });
    tickMinimap(ctx, state, 0);
    expect(renderSizes).toEqual([400, 200]);
    expect(readSpy).toHaveBeenCalled();
  });

  it("in volume mode reuses the overview on a dolly but redraws on a rotation", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "volume", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);

    // Dolly (eye moves, orientation fixed): overlay recomputes, overview reused.
    scene.eye = [0, 0, 20];
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(2);
    expect(overlay.mock.calls[1][0].mainInvViewProj).not.toBeNull();

    // Rotation (theta/phi): the overview reorients, so it must redraw.
    scene.theta = 1.0;
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(2);
  });

  it("in volume mode re-renders an orbit from cached geometry without re-reading members", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "volume", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(1);
    const firstViewProj = overlay.mock.calls[0][0].viewProj;

    // A pure orbit changes only theta/phi. Member geometry is camera-invariant,
    // so the O(members) reads (positions + render matrices + per-dataset scene
    // matrices + volume shape) must NOT rerun — yet the overview MUST redraw for
    // the new angle and the overlay MUST refresh (frustum + boxes reorient).
    const posSpy = vi.spyOn(scene.wasm, "member_positions");
    const matSpy = vi.spyOn(scene.wasm, "member_render_matrices");
    const idSpy = vi.spyOn(scene.wasm, "member_render_ids");
    const dsMatSpy = vi.spyOn(scene.wasm, "scene_model_matrix_for");
    const volShapeSpy = vi.spyOn(scene.wasm, "dataset_volume_shape");
    // Return a distinct camera for the new angle so the overlay's viewProj moves.
    const camSpy = vi.spyOn(scene.wasm, "minimap_camera").mockReturnValue(
      new Float32Array(35).fill(7),
    );

    scene.theta = 1.0;
    scene.phi = 0.3;
    scene.viewRotation = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    tickMinimap(ctx, state, 0);

    expect(renderCount.n).toBe(2);
    expect(posSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
    expect(idSpy).not.toHaveBeenCalled();
    expect(dsMatSpy).not.toHaveBeenCalled();
    expect(volShapeSpy).not.toHaveBeenCalled();
    // The minimap camera was recomputed for the new orientation.
    expect(camSpy).toHaveBeenCalled();

    // Overlay refreshed: static layer re-stroked (boxes/frustum moved), the
    // frustum tracks the new angle, and viewProj reflects the new camera.
    expect(overlay).toHaveBeenCalledTimes(2);
    const orbitCall = overlay.mock.calls[1][0];
    expect(orbitCall.staticDirty).toBe(true);
    expect(Array.from(orbitCall.cameraViewRotation)).toEqual(scene.viewRotation);
    expect(orbitCall.mainInvViewProj).not.toBeNull();
    expect(Array.from(orbitCall.viewProj)).not.toEqual(Array.from(firstViewProj));
  });

  it("in volume mode re-strokes the frustum on a fly look-around without redrawing the overview", () => {
    // Fly look-around: the view direction rotates while the eye stays put, so
    // scene.eye_position() and the arcball theta/phi constants are UNCHANGED.
    // The authoritative view basis and inv_view_proj move. The cube and frustum
    // must track the new orientation: the overlay callback must fire with both
    // fresh values and staticDirty = true, WITHOUT
    // re-rendering the overview (minimap camera + member geometry unchanged) and
    // WITHOUT re-reading any members.
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "volume", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(1);

    const posSpy = vi.spyOn(scene.wasm, "member_positions");
    const matSpy = vi.spyOn(scene.wasm, "member_render_matrices");
    const idSpy = vi.spyOn(scene.wasm, "member_render_ids");
    const camSpy = vi.spyOn(scene.wasm, "minimap_camera");

    // Rotate the view direction only: eye + theta + phi fixed, pose moves.
    scene.invViewProj = new Array<number>(16).fill(0).map((_, i) => i + 1);
    scene.viewRotation = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    tickMinimap(ctx, state, 0);

    // No overview redraw, no minimap camera recompute, no member re-read.
    expect(renderCount.n).toBe(1);
    expect(camSpy).not.toHaveBeenCalled();
    expect(posSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
    expect(idSpy).not.toHaveBeenCalled();

    // Overlay re-stroked with the fresh pose; the frustum layer is static.
    expect(overlay).toHaveBeenCalledTimes(2);
    const lookCall = overlay.mock.calls[1][0];
    expect(lookCall.staticDirty).toBe(true);
    expect(lookCall.mainInvViewProj).not.toBeNull();
    expect(Array.from(lookCall.mainInvViewProj as Float32Array)).toEqual(scene.invViewProj);
    // Eye and arcball-only inputs did not move, but the cube follows fly roll.
    expect(Array.from(lookCall.cameraViewRotation)).toEqual(scene.viewRotation);

    // A follow-up idle tick (stable pose) must early-return: no extra overlay
    // call, no overview render — a stable inv_view_proj hashes to a stable key.
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(2);
  });

  it("in volume mode does not double-render the overview when a look-around accompanies an orbit", () => {
    // An orbit moves theta/phi (→ camera key → one overview redraw) AND the main
    // camera pose (inv_view_proj). The pose signal lives only in the overlay key,
    // so it must NOT trigger a second/duplicate overview render.
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "volume", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);

    scene.theta = 1.0;
    scene.phi = 0.3;
    scene.eye = [1, 2, 5];
    scene.invViewProj = new Array<number>(16).fill(0).map((_, i) => i + 1);
    tickMinimap(ctx, state, 0);

    // Exactly one additional overview render (the camera-key path), not two.
    expect(renderCount.n).toBe(2);
    expect(overlay).toHaveBeenCalledTimes(2);
    expect(overlay.mock.calls[1][0].staticDirty).toBe(true);
  });

  it("does nothing when the minimap is disabled", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    state.enabled = false;
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(0);
    expect(overlay).not.toHaveBeenCalled();
  });
});

describe("tickMinimapOverview throttle", () => {
  it("throttles the O(members) seed-scan to the scan interval", () => {
    // The seed-scan polls the CPU cache across every not-yet-seeded member's
    // chunk grid — O(members × chunks) per frame, the dominant per-move CPU cost
    // on large collections. It must run at most once per interval, not every rAF.
    // scene.t() is read once at the top of each scan (after the throttle gate),
    // so its call count tracks scans that actually ran; empty `datasets` isolates
    // the gate from the per-member body.
    const tSpy = vi.fn(() => 0);
    const state = createMinimapState();
    state.enabled = true;
    const ctx = {
      scene: { t: tSpy, c: () => 0 },
      datasets: new Map(),
    } as unknown as TickContext;

    tickMinimapOverview(ctx, state, 1000); // first scan runs (never scanned before)
    expect(tSpy).toHaveBeenCalledTimes(1);
    expect(state.lastOverviewScanMs).toBe(1000);

    tickMinimapOverview(ctx, state, 1050); // within the interval → skipped
    expect(tSpy).toHaveBeenCalledTimes(1);
    expect(state.lastOverviewScanMs).toBe(1000);

    tickMinimapOverview(ctx, state, 1101); // past the interval → runs again
    expect(tSpy).toHaveBeenCalledTimes(2);
    expect(state.lastOverviewScanMs).toBe(1101);
  });

  it("returns the last continuation signal on a throttle-skipped frame", () => {
    // A skipped frame must return the previous scan's budget-continuation signal
    // so the render loop schedules exactly as it would scanning every frame.
    const state = createMinimapState();
    state.enabled = true;
    const ctx = {
      scene: { t: () => 0, c: () => 0 },
      datasets: new Map(),
    } as unknown as TickContext;

    tickMinimapOverview(ctx, state, 1000); // establishes lastOverviewScanMs
    state.overviewBudgetPending = true;
    expect(tickMinimapOverview(ctx, state, 1010)).toBe(true); // skipped → pending
    state.overviewBudgetPending = false;
    expect(tickMinimapOverview(ctx, state, 1020)).toBe(false); // skipped → not pending
  });

  it("keeps scheduling on a throttle-skip while chunks await fetch (no tail-chunk strand)", () => {
    // Regression: the render loop is purely dirty-driven, so a throttle-skipped
    // frame must signal continuation while members still await fetched chunks —
    // otherwise a tail chunk landing inside the interval strands un-uploaded
    // (loop quiesces before the next scan) until an unrelated interaction.
    const state = createMinimapState();
    state.enabled = true;
    const ctx = {
      scene: { t: () => 0, c: () => 0 },
      datasets: new Map(),
    } as unknown as TickContext;

    tickMinimapOverview(ctx, state, 1000); // establishes lastOverviewScanMs
    expect(state.overviewBudgetPending).toBe(false); // empty scan → budget not exhausted

    state.pendingFetch.set("m0", []); // a member is now awaiting fetched chunks
    expect(tickMinimapOverview(ctx, state, 1010)).toBe(true); // skipped but continuation kept

    state.pendingFetch.clear(); // seeding complete
    expect(tickMinimapOverview(ctx, state, 1020)).toBe(false); // skipped → loop may quiesce
  });
});
