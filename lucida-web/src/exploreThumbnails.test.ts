/**
 * `makeThumbnailRequester`, the Explore panel's per-candidate off-screen
 * render entry point.
 *
 * What a candidate shows comes from the scene resolving it, so a preview draws
 * the composite the canvas draws, and a candidate that solos a channel draws
 * that channel. The layer list is camera-independent, so a batch of candidate
 * thumbnails shares one list per input state:
 *
 *   - same content/layout epochs + resolved layers → the wasm matrix export is
 *     read once, not once per candidate;
 *   - a content/layout epoch bump or a display change → the list is rebuilt;
 *   - a camera-only change (view epoch) → the cached list survives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WasmScene } from "lucida-core";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { OverviewDisplay, OverviewLayers } from "./renderer/workerProtocol.ts";
import type { DatasetState } from "./types.ts";
import type { SavedView } from "./savedView/types.ts";
import { makeThumbnailRequester } from "./exploreThumbnails.ts";
import { resolvedLayer, shownChannel } from "./resolvedLayerFixtures.ts";
import type { ResolvedLayer } from "./resolvedLayers.ts";

vi.mock("lucida-core", () => ({
  // invViewProj[16] + eye[3] + viewProj[16]; non-empty so the requester
  // proceeds to the render call.
  camera_matrices: vi.fn(() => new Float32Array(35)),
}));

interface SceneConfig {
  epochs: { content: number; layout: number; view: number; selection: number };
  /** What the scene shows; a candidate that solos a channel shows it alone. */
  layer: ResolvedLayer;
}

function makeScene(config: SceneConfig) {
  const memberRenderIds = vi.fn(() => JSON.stringify(["img-0", "img-1"]));
  const scene = {
    epochs: () => JSON.stringify(config.epochs),
    resolved_view_layers: (json: string) => {
      const candidate = JSON.parse(json) as SavedView;
      const solo = candidate.dataset_settings?.ds?.solo;
      if (typeof solo !== "number") return JSON.stringify([config.layer]);
      const ch = config.layer.channels.find((c) => c.channel === solo)!;
      return JSON.stringify([{ ...config.layer, solo, channels: [{ ...ch, blend_mode: "alpha" }] }]);
    },
    member_render_ids: memberRenderIds,
    member_render_matrices: () => new Float32Array(2 * 32),
  } as unknown as WasmScene;
  return { scene, memberRenderIds };
}

function makeDatasets(): Map<string, DatasetState> {
  const ds = {
    manifest: {
      images: [{ image_id: "img-0" }, { image_id: "img-1" }],
    },
  } as unknown as DatasetState;
  return new Map([["ds", ds]]);
}

const composite = resolvedLayer("ds", [
  shownChannel(0, { colormap: "magenta", contrast_max: 100 }),
  shownChannel(1, { colormap: "green", contrast_min: 5, contrast_max: 50 }),
  shownChannel(2, { colormap: "cyan", gamma: 0.8 }),
]);

const view = { camera: { mode: "arcball" }, dataset_settings: {} } as unknown as SavedView;

function soloView(channel: number): SavedView {
  return { ...view, dataset_settings: { ds: { solo: channel } } } as unknown as SavedView;
}

describe("makeThumbnailRequester", () => {
  let config: SceneConfig;
  let sceneParts: ReturnType<typeof makeScene>;
  let rendered: Array<{ layers: OverviewLayers; displays: Array<OverviewDisplay | null> }>;
  let requestThumbnail: (view: SavedView, size: number) => Promise<ImageBitmap | null>;

  beforeEach(() => {
    config = {
      epochs: { content: 1, layout: 1, view: 1, selection: 1 },
      layer: composite,
    };
    sceneParts = makeScene(config);
    rendered = [];
    const client = {
      thumbnailRender: vi.fn((layers: OverviewLayers, displays: Array<OverviewDisplay | null>) => {
        rendered.push({ layers, displays });
        return Promise.resolve({} as ImageBitmap);
      }),
    } as unknown as RenderClient;
    requestThumbnail = makeThumbnailRequester({
      getScene: () => sceneParts.scene,
      getClient: () => client,
      getDatasets: makeDatasets,
      datasetId: "ds",
    });
  });

  /** Each overview the `at`th render draws, with the display it takes. */
  function drawn(at: number): Array<[string, OverviewDisplay | null]> {
    const { layers, displays } = rendered[at];
    return layers.keys.map((key, i) => [key, displays[layers.displays[i]]]);
  }

  it("previews the composite the view shows, every channel in its own colormap and window", async () => {
    await requestThumbnail(view, 128);
    expect(drawn(0).map(([key, d]) => [key, d?.colormap, d?.contrastMin, d?.contrastMax, d?.gamma, d?.blendMode])).toEqual([
      ["img-0:ch0", "magenta", 0, 100, 1, "additive"],
      ["img-0:ch1", "green", 5, 50, 1, "additive"],
      ["img-0:ch2", "cyan", 0, 65535, 0.8, "additive"],
      ["img-1:ch0", "magenta", 0, 100, 1, "additive"],
      ["img-1:ch1", "green", 5, 50, 1, "additive"],
      ["img-1:ch2", "cyan", 0, 65535, 0.8, "additive"],
    ]);
  });

  it("previews a candidate that solos a channel with that channel alone", async () => {
    await requestThumbnail(soloView(1), 128);
    expect(drawn(0).map(([key, d]) => [key, d?.colormap])).toEqual([
      ["img-0:ch1", "green"],
      ["img-1:ch1", "green"],
    ]);
  });

  it("shares one layer list across a batch of candidates", async () => {
    await requestThumbnail(view, 128);
    await requestThumbnail(view, 128);
    await requestThumbnail(view, 128);

    expect(sceneParts.memberRenderIds).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveLength(3);
    expect(rendered[1].layers).toBe(rendered[0].layers);
    expect(rendered[2].layers).toBe(rendered[0].layers);
  });

  it("rebuilds the list when the content epoch bumps", async () => {
    await requestThumbnail(view, 128);
    config.epochs = { ...config.epochs, content: 2 };
    await requestThumbnail(view, 128);

    expect(sceneParts.memberRenderIds).toHaveBeenCalledTimes(2);
    expect(rendered[1].layers).not.toBe(rendered[0].layers);
  });

  it("rebuilds the list when the display changes", async () => {
    await requestThumbnail(view, 128);
    config.layer = resolvedLayer("ds", [shownChannel(0, { contrast_min: 5, contrast_max: 50 })]);
    await requestThumbnail(view, 128);

    expect(sceneParts.memberRenderIds).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached list across camera-only (view epoch) changes", async () => {
    await requestThumbnail(view, 128);
    config.epochs = { ...config.epochs, view: 9 };
    await requestThumbnail(view, 128);

    expect(sceneParts.memberRenderIds).toHaveBeenCalledTimes(1);
    expect(rendered[1].layers).toBe(rendered[0].layers);
  });

  it("returns null without rendering when the dataset is hidden", async () => {
    config.layer = { ...composite, visible: false };
    const result = await requestThumbnail(view, 128);

    expect(result).toBeNull();
    expect(rendered).toHaveLength(0);
  });
});
