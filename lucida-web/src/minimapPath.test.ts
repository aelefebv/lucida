import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WasmScene } from "lucida-core";
import { createMinimapState, identityModelMatrix, intersectSliceViewWithMember, minimapCoarseLevelIndex, overviewKeyFor, overviewLayerParams, readMemberRenderMatrices, readMinimapOverviewEpochs, tickMinimap, tickMinimapOverview } from "./minimapPath.ts";
import { resolvedLayer, resolvedLayers, shownChannel } from "./resolvedLayerFixtures.ts";
import type { MinimapState } from "./minimapPath.ts";
import type { MultiscaleInfo } from "./manifestTypes.ts";
import { MINIMAP_DISPLAY_HOLD_MS, type TickContext, type MinimapOverlayData } from "./renderLoopTypes.ts";
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

describe("overviewLayerParams", () => {
  const geometry = (channel: number) => ({
    memberId: `m0:ch${channel}`,
    ownerDatasetId: "ds",
    channel,
    modelMatrix: identityModelMatrix(),
    invModelMatrix: identityModelMatrix(),
  });

  it("draws every shown channel of a composite with the canvas's window, colormap and blend", () => {
    const layers = resolvedLayers(resolvedLayer("ds", [
      shownChannel(0, { colormap: "magenta", contrast_max: 148, gamma: 0.8 }),
      shownChannel(1, { colormap: "green", contrast_min: 10, contrast_max: 200, gamma: 1.2 }),
      shownChannel(2, { colormap: "cyan" }),
    ]));
    const params = overviewLayerParams([geometry(0), geometry(1), geometry(2)], layers);
    expect(params.map((p) => [p.datasetId, p.colormap, p.contrastMin, p.contrastMax, p.gamma, p.blendMode])).toEqual([
      ["m0:ch0", "magenta", 0, 148, 0.8, "additive"],
      ["m0:ch1", "green", 10, 200, 1.2, "additive"],
      ["m0:ch2", "cyan", 0, 65535, 1, "additive"],
    ]);
  });

  it("skips a cached channel the layer no longer shows, as after a solo", () => {
    const layers = resolvedLayers(resolvedLayer("ds", [shownChannel(1, { blend_mode: "alpha" })], { solo: 1, channel_count: 3 }));
    const params = overviewLayerParams([geometry(0), geometry(1), geometry(2)], layers);
    expect(params.map((p) => [p.datasetId, p.blendMode])).toEqual([["m0:ch1", "alpha"]]);
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
        invModelMatrix: modelMatrix,
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
        invModelMatrix: modelMatrix,
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
        invModelMatrix: modelMatrix,
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
        invModelMatrix: modelMatrix,
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
      epochs: () => JSON.stringify({ content: 7, layout: 3, view: 99, selection: 5 }),
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

describe("tickMinimap overview/overlay split", () => {
  /**
   * A mutable fake scene exposing just the surface `tickMinimap` reads, so a
   * test can move the main camera and observe which work reruns.
   */
  interface FakeScene {
    theta: number;
    phi: number;
    z: number;
    zoom: number;
    center: [number, number];
    eye: [number, number, number];
    /**
     * The main camera's inverse view-projection, the frustum's source. A fly
     * look-around changes only this; eye and theta/phi stay fixed.
     */
    invViewProj: number[];
    order: string;
    settings: string;
    /** Bumped by a dataset add/remove (see readMinimapOverviewEpochs). */
    contentEpoch: number;
    /** Bumped by a layout switch / member reflow. */
    layoutEpoch: number;
    wasm: WasmScene;
  }

  /** `resolved_layers()` for the one layer `ds`, showing `channel` (default 0). */
  function layersJson(layer: { visible: boolean; opacity: number; contrast_max: number; channel?: number }): string {
    const channel = shownChannel(layer.channel ?? 0, { contrast_max: layer.contrast_max });
    return JSON.stringify([
      resolvedLayer("ds", [channel], { visible: layer.visible, opacity: layer.opacity }),
    ]);
  }

  function makeScene(): FakeScene {
    const s: FakeScene = {
      theta: 0.5,
      phi: 1.2,
      z: 0,
      zoom: 1,
      center: [0, 0],
      eye: [0, 0, 10],
      invViewProj: new Array<number>(16).fill(0),
      order: JSON.stringify(["ds"]),
      settings: layersJson(
        { visible: true, opacity: 1, contrast_max: 65535 },
      ),
      contentEpoch: 0,
      layoutEpoch: 0,
      wasm: undefined as unknown as WasmScene,
    };
    s.wasm = {
      camera_theta: () => s.theta,
      camera_phi: () => s.phi,
      resolved_layers: () => s.settings,
      dataset_order: () => s.order,
      z: () => s.z,
      t: () => 0,
      zoom: () => s.zoom,
      center: () => s.center,
      eye_position: () => new Float32Array(s.eye),
      epochs: () =>
        JSON.stringify({ content: s.contentEpoch, layout: s.layoutEpoch, view: 0, selection: s.settings }),
      // 36 floats: [0..16) invViewProj, [16..19) eye, [19..35) viewProj, [35] topDown.
      minimap_camera: () => new Float32Array(36),
      member_positions: () => JSON.stringify({ m0: [0, 0] }),
      dataset_placement: () => new Float64Array([0, 0, 0, 1, 1, 1]),
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

    // Pan the main camera: overlay must recompute, overview must not redraw.
    scene.center = [1000, 1000];
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(2);
    const secondBounds = overlay.mock.calls[1][0].sliceViewports[0].bounds;
    expect(secondBounds).not.toEqual(firstBounds);
    // The static layer is drawn in the minimap's own fixed viewProj, which a 2D
    // pan never moves, so it is reused. Only the viewport rect above changed.
    expect(overlay.mock.calls[1][0].staticDirty).toBe(false);
  });

  it("hands the overlay each member's box placed in the scene frame", () => {
    const scene = makeScene();
    // Samples half a scene unit across, the frame starting at scene (50, 20).
    scene.wasm.dataset_placement = () => new Float64Array([50, 20, 0, 0.5, 0.5, 1]);
    const overlay = vi.fn();
    tickMinimap(makeCtx(scene, "slice", { n: 0 }), makeState(overlay), 0);
    const [member] = overlay.mock.calls[0][0].members;
    expect(member.position).toEqual([50, 20]);
    expect([member.width, member.height]).toEqual([250, 250]);
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

    scene.settings = layersJson({ visible: true, opacity: 1, contrast_max: 65535, channel: 1 });
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(2);

    state.uploadGeneration++;
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(3);

    scene.settings = layersJson(
      { visible: true, opacity: 0.5, contrast_max: 100 },
    );
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

    // Contrast-only edit: the overview re-renders with the new display values
    // but reuses cached member geometry.
    const readSpy = vi.spyOn(scene.wasm, "member_positions");
    const matSpy = vi.spyOn(scene.wasm, "member_render_matrices");
    scene.settings = layersJson(
      { visible: true, opacity: 1, contrast_max: 100 },
    );
    tickMinimap(ctx, state, 0);

    expect(renderCount.n).toBe(2);
    expect(readSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
    // The overlay (viewport/frustum) does not depend on display values.
    expect(overlay.mock.calls.length).toBe(overlayCallsBefore);
  });

  it("holds a display-only redraw while the camera moves and draws it once the camera is still", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    expect(tickMinimap(ctx, state, 0, 1000)).toBeNull();
    expect(renderCount.n).toBe(1);

    // A pan and a contrast edit in one tick, as auto-contrast makes them: the
    // viewport rect follows the pan, the overview keeps its last display.
    scene.center = [1000, 1000];
    scene.settings = layersJson({ visible: true, opacity: 1, contrast_max: 100 });
    expect(tickMinimap(ctx, state, 0, 1100)).toBe(MINIMAP_DISPLAY_HOLD_MS);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(2);

    // The camera keeps moving, so the edit stays held from the latest move.
    scene.center = [1100, 1000];
    expect(tickMinimap(ctx, state, 0, 1200)).toBe(MINIMAP_DISPLAY_HOLD_MS);
    expect(tickMinimap(ctx, state, 0, 1300)).toBe(MINIMAP_DISPLAY_HOLD_MS - 100);
    expect(renderCount.n).toBe(1);

    // Still for the hold: the overview redraws, once.
    expect(tickMinimap(ctx, state, 0, 1200 + MINIMAP_DISPLAY_HOLD_MS)).toBeNull();
    expect(renderCount.n).toBe(2);
    expect(tickMinimap(ctx, state, 0, 2000)).toBeNull();
    expect(renderCount.n).toBe(2);
  });

  it("draws a display-only edit at once when the camera is still", () => {
    const scene = makeScene();
    const renderCount = { n: 0 };
    const state = makeState(vi.fn());
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0, 1000);
    scene.settings = layersJson({ visible: true, opacity: 1, contrast_max: 100 });
    expect(tickMinimap(ctx, state, 0, 1010)).toBeNull();
    expect(renderCount.n).toBe(2);
  });

  it("rebuilds and re-reads members when a dataset's visibility changes", () => {
    const scene = makeScene();
    scene.settings = layersJson(
      { visible: false, opacity: 1, contrast_max: 65535 },
    );
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "slice", renderCount);

    tickMinimap(ctx, state, 0);
    // Hidden dataset draws nothing.
    expect(renderCount.n).toBe(0);

    // Showing it adds a drawn layer, a geometry change, so members are re-read
    // even though order, z, channel, upload, and epochs are unchanged.
    const readSpy = vi.spyOn(scene.wasm, "member_positions");
    scene.settings = layersJson(
      { visible: true, opacity: 1, contrast_max: 65535 },
    );
    tickMinimap(ctx, state, 0);

    expect(readSpy).toHaveBeenCalled();
    expect(renderCount.n).toBe(1);
  });

  it("skips the O(N) overview redraw on a slice-mode z-scrub but updates the plane indicator", () => {
    // The overview render takes no Z, so a Z-scrub must reuse the cached
    // overview and refresh only the overlay's current-plane indicator.
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

    // Overview not redrawn and no members re-read; overlay refreshed with the
    // new plane.
    expect(renderCount.n).toBe(1);
    expect(readSpy).not.toHaveBeenCalled();
    expect(overlay).toHaveBeenCalledTimes(2);
    expect(overlay.mock.calls[1][0].currentZ).toBe(3);
    // Camera and geometry unchanged, so the static layer is not re-stroked;
    // only the Z-plane indicator is.
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

    // A layout switch bumps only the layout epoch. The next tick moves only the
    // camera, yet the overview must rebuild or it keeps drawing old placement.
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
      minimapRender: (_l: unknown, _iv: unknown, _vp: unknown, _e: unknown, w: number) => {
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

    // First rebuild at DPR 2: backing size = round(200 × 2) = 400.
    tickMinimap(ctx, state, 0);
    expect(renderSizes).toEqual([400]);

    // Window dragged onto a DPR-1 monitor, then a display-only contrast edit. The
    // DPR change must force a full rebuild at the new backing size (200), not a
    // display-only re-render at the stale 400 cached from the old DPR.
    globalThis.devicePixelRatio = 1;
    const readSpy = vi.spyOn(scene.wasm, "member_positions");
    scene.settings = layersJson(
      { visible: true, opacity: 1, contrast_max: 100 },
    );
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

    // A pure orbit changes only theta/phi. Member reads must not rerun, but the
    // overview must redraw for the new angle and the overlay must refresh.
    const posSpy = vi.spyOn(scene.wasm, "member_positions");
    const matSpy = vi.spyOn(scene.wasm, "member_render_matrices");
    const idSpy = vi.spyOn(scene.wasm, "member_render_ids");
    const dsMatSpy = vi.spyOn(scene.wasm, "scene_model_matrix_for");
    const volShapeSpy = vi.spyOn(scene.wasm, "dataset_volume_shape");
    // Return a distinct camera for the new angle so the overlay's viewProj moves.
    const camSpy = vi.spyOn(scene.wasm, "minimap_camera").mockReturnValue(
      new Float32Array(36).fill(7, 0, 35),
    );

    scene.theta = 1.0;
    scene.phi = 0.3;
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
    expect(orbitCall.theta).toBe(1.0);
    expect(orbitCall.phi).toBe(0.3);
    expect(orbitCall.mainInvViewProj).not.toBeNull();
    expect(Array.from(orbitCall.viewProj)).not.toEqual(Array.from(firstViewProj));
  });

  it("in volume mode re-strokes the frustum on a fly look-around without redrawing the overview", () => {
    // Fly look-around: only scene.inv_view_proj() moves; eye and theta/phi are
    // unchanged. The overlay must fire with the fresh pose, with no overview
    // render, no member reads and no member outlines stroked again.
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
    tickMinimap(ctx, state, 0);

    // No overview redraw, no minimap camera recompute, no member re-read.
    expect(renderCount.n).toBe(1);
    expect(camSpy).not.toHaveBeenCalled();
    expect(posSpy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled();
    expect(idSpy).not.toHaveBeenCalled();

    // Overlay re-stroked with the fresh pose; the frustum is drawn with the
    // viewport overlays, so the outlines' layer is reused.
    expect(overlay).toHaveBeenCalledTimes(2);
    const lookCall = overlay.mock.calls[1][0];
    expect(lookCall.staticDirty).toBe(false);
    expect(lookCall.mainInvViewProj).not.toBeNull();
    expect(Array.from(lookCall.mainInvViewProj as Float32Array)).toEqual(scene.invViewProj);
    // Eye-only inputs did not move, so this is not an orbit: no viewProj change.
    expect(lookCall.theta).toBe(scene.theta);
    expect(lookCall.phi).toBe(scene.phi);

    // An idle tick with a stable pose must early-return: no overlay call, no
    // overview render.
    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(overlay).toHaveBeenCalledTimes(2);
  });

  it("in volume mode does not double-render the overview when a look-around accompanies an orbit", () => {
    // An orbit moves theta/phi (one overview redraw) and the main camera pose.
    // The pose lives only in the overlay key, so it must not add a second render.
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

  /** A camera payload whose last float marks the top-down camera. */
  function topDownCamera(): Float32Array {
    const cam = new Float32Array(36);
    cam[35] = 1;
    return cam;
  }

  it("tells the overlay which projection the minimap camera chose", () => {
    const scene = makeScene();
    const overlay = vi.fn();
    const ctx = makeCtx(scene, "slice", { n: 0 });

    tickMinimap(ctx, makeState(overlay), 0);
    expect(overlay.mock.calls[0][0].topDown).toBe(false);

    vi.spyOn(scene.wasm, "minimap_camera").mockReturnValue(topDownCamera());
    tickMinimap(ctx, makeState(overlay), 0);
    expect(overlay.mock.calls[1][0].topDown).toBe(true);
  });

  it("in volume mode leaves a top-down overview alone on an orbit", () => {
    // The top-down camera ignores theta/phi, so recomputing it would read every
    // member in wasm and redraw the overview for an identical picture.
    const scene = makeScene();
    const camSpy = vi.spyOn(scene.wasm, "minimap_camera").mockReturnValue(topDownCamera());
    const renderCount = { n: 0 };
    const overlay = vi.fn();
    const state = makeState(overlay);
    const ctx = makeCtx(scene, "volume", renderCount);

    tickMinimap(ctx, state, 0);
    expect(renderCount.n).toBe(1);
    expect(camSpy).toHaveBeenCalledTimes(1);

    scene.theta = 1.0;
    scene.phi = 0.3;
    scene.eye = [1, 2, 5];
    tickMinimap(ctx, state, 0);

    expect(renderCount.n).toBe(1);
    expect(camSpy).toHaveBeenCalledTimes(1);
    // The main camera moved, so its frustum footprint is still re-stroked,
    // and the top-down outlines did not move.
    expect(overlay).toHaveBeenCalledTimes(2);
    expect(overlay.mock.calls[1][0].staticDirty).toBe(false);
    expect(overlay.mock.calls[1][0].topDown).toBe(true);
  });
});

/** A CPU cache that never failed a chunk. */
const noFailures = { failedChunksVersion: () => 0, failedChunks: () => [] };

describe("tickMinimapOverview throttle", () => {
  it("throttles the O(members) seed-scan to the scan interval", () => {
    // The seed-scan must run at most once per interval, not every rAF.
    // The resolved layers are read once per scan after the throttle gate, so
    // their call count tracks scans that ran; empty `datasets` isolates the gate.
    const tSpy = vi.fn(() => "[]");
    const state = createMinimapState();
    state.enabled = true;
    const ctx = {
      scene: { resolved_layers: tSpy },
      datasets: new Map(),
      cpuCache: noFailures,
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
      scene: { t: () => 0, resolved_layers: () => "[]" },
      datasets: new Map(),
      cpuCache: noFailures,
    } as unknown as TickContext;

    tickMinimapOverview(ctx, state, 1000); // establishes lastOverviewScanMs
    state.overviewBudgetPending = true;
    expect(tickMinimapOverview(ctx, state, 1010)).toBe(true); // skipped → pending
    state.overviewBudgetPending = false;
    expect(tickMinimapOverview(ctx, state, 1020)).toBe(false); // skipped → not pending
  });

  it("keeps scheduling on a throttle-skip once an awaited chunk lands (no tail-chunk strand), and not before", () => {
    // The loop is dirty-driven, so a throttle-skipped frame must signal
    // continuation when a chunk a member awaits has landed inside the interval,
    // or it strands until an unrelated interaction. While nothing has landed it
    // must not: the arrival dirties the loop itself, and asking for frames
    // until then redraws at frame rate, forever if nothing fetches the chunk.
    const state = createMinimapState();
    state.enabled = true;
    const cache = new Map<string, { data: ArrayBuffer; dataType: string }>();
    const ctx = {
      scene: { t: () => 0, resolved_layers: () => "[]" },
      datasets: new Map(),
      cpuCache: {
        ...noFailures,
        getCachedChunk: (memberId: string, key: string) => cache.get(`${memberId}/${key}`) ?? null,
      },
    } as unknown as TickContext;

    tickMinimapOverview(ctx, state, 1000); // establishes lastOverviewScanMs
    expect(state.overviewBudgetPending).toBe(false); // empty scan → budget not exhausted

    // A collection member: the cache holds its chunks under the owning entity.
    state.pendingFetch.set("ds:image:m0", [{ level: 2, x: 0, y: 0, z: 0, t: 0, c: 0, key: "2/0/0/0/0/0" }]);
    state.memberOwner.set("ds:image:m0", "ds:tile:m0");
    expect(tickMinimapOverview(ctx, state, 1010)).toBe(false); // awaited, not landed → idle

    cache.set("ds:tile:m0/2/0/0/0/0/0", { data: new ArrayBuffer(0), dataType: "uint16" });
    expect(tickMinimapOverview(ctx, state, 1020)).toBe(false); // empty data is nothing to upload

    cache.set("ds:tile:m0/2/0/0/0/0/0", { data: new ArrayBuffer(8), dataType: "uint16" });
    expect(tickMinimapOverview(ctx, state, 1030)).toBe(true); // landed → the next scan uploads it

    state.pendingFetch.clear(); // seeding complete
    expect(tickMinimapOverview(ctx, state, 1040)).toBe(false); // skipped → loop may quiesce
  });
});

describe("tickMinimapOverview on a collection", () => {
  it("finds a member's coarse chunk under its owning entity and uploads it under its image", () => {
    // Collection members have an image id that differs from the entity id the
    // CPU cache keys chunks by. Reading the cache by image id never found them,
    // so the minimap of every collection stayed empty.
    const state = createMinimapState();
    state.enabled = true;
    const cache = new Map<string, { data: ArrayBuffer; dataType: string }>();
    cache.set("ds:tile:A/1/0/1/0/0/0/0/0", { data: new ArrayBuffer(8), dataType: "uint16" });
    const uploads: { overview: string; keys: string[] }[] = [];
    const ctx = {
      scene: { t: () => 0, resolved_layers: () => "[]" },
      datasets: new Map([
        [
          "ds",
          {
            manifest: {
              images: [
                {
                  image_id: "ds:image:A/1/0",
                  owner: "ds:tile:A/1/0",
                  multiscale: {
                    data_type: "Uint16",
                    coarse_level_index: 1,
                    levels: [
                      { level_index: 0, shape: [1, 1, 1, 4, 4], chunk_shape: [1, 1, 1, 4, 4] },
                      { level_index: 1, shape: [1, 1, 1, 2, 2], chunk_shape: [1, 1, 1, 2, 2] },
                    ],
                  },
                },
              ],
            },
          },
        ],
      ]),
      cpuCache: {
        ...noFailures,
        getCachedChunk: (entityId: string, key: string) => cache.get(`${entityId}/${key}`) ?? null,
      },
      client: {
        minimapUploadOverviewChunksForLayer: (overview: string, chunks: { key: string }[]) => {
          uploads.push({ overview, keys: chunks.map((chunk) => chunk.key) });
        },
      },
    } as unknown as TickContext;

    tickMinimapOverview(ctx, state, 1000);

    const overview = overviewKeyFor("ds:image:A/1/0", 0);
    expect(uploads).toEqual([{ overview, keys: ["1/0/0/0/0/0"] }]);
    expect(state.overviewSeeded.has(overview)).toBe(true);
    expect(state.pendingFetch.has("ds:image:A/1/0")).toBe(false);
  });
});

describe("tickMinimapOverview with a chunk that failed for good", () => {
  it("opens the member's overview once with no chunk, so the worker can draw it hatched", () => {
    const state = createMinimapState();
    state.enabled = true;
    const uploads: { overview: string; chunks: number; imageId: string; level: number }[] = [];
    const ctx = {
      scene: { t: () => 0, resolved_layers: () => "[]" },
      datasets: new Map([
        [
          "ds",
          {
            manifest: {
              images: [
                {
                  image_id: "ds",
                  owner: "ds",
                  multiscale: {
                    data_type: "Uint16",
                    coarse_level_index: 1,
                    levels: [
                      { level_index: 0, shape: [1, 1, 1, 4, 4], chunk_shape: [1, 1, 1, 4, 4] },
                      { level_index: 1, shape: [1, 1, 1, 2, 2], chunk_shape: [1, 1, 1, 2, 2] },
                    ],
                  },
                },
              ],
            },
          },
        ],
      ]),
      cpuCache: {
        getCachedChunk: () => null,
        failedChunksVersion: () => 1,
        failedChunks: () => [{ datasetId: "ds", imageId: "ds", chunkKey: "1/0/0/0/0/0", failure: null }],
      },
      client: {
        minimapUploadOverviewChunksForLayer: (overview: string, chunks: unknown[], imageId: string, level: number) => {
          uploads.push({ overview, chunks: chunks.length, imageId, level });
        },
      },
    } as unknown as TickContext;

    tickMinimapOverview(ctx, state, 1000);
    tickMinimapOverview(ctx, state, 2000);

    expect(uploads).toEqual([{ overview: overviewKeyFor("ds", 0), chunks: 0, imageId: "ds", level: 1 }]);
  });
});
