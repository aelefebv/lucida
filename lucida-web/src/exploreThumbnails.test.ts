/**
 * `makeThumbnailRequester` — the Explore panel's per-candidate off-screen
 * render entry point. The layer list it feeds `client.thumbnailRender` is
 * camera-independent (content + placement only), so a batch of candidate
 * thumbnails must share ONE list per input state:
 *
 *   - same content/layout epochs + channel + settings → the wasm matrix
 *     export is read once, not once per candidate;
 *   - a content/layout epoch bump or settings change → the list is rebuilt;
 *   - a camera-only change (view epoch) → the cached list survives.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WasmScene } from "lucida-core";
import type { RenderClient } from "./renderer/renderClient.ts";
import type { DatasetState } from "./types.ts";
import type { SavedView } from "./savedView/types.ts";
import { makeThumbnailRequester } from "./exploreThumbnails.ts";

vi.mock("lucida-core", () => ({
  // invViewProj[16] + eye[3] + viewProj[16]; non-empty so the requester
  // proceeds to the render call.
  camera_matrices: vi.fn(() => new Float32Array(35)),
}));

interface SceneConfig {
  epochs: { content: number; layout: number; view: number; selection: number };
  settings: Record<string, unknown>;
  activeC: number;
}

function makeScene(config: SceneConfig) {
  const memberRenderIds = vi.fn(() => JSON.stringify(["img-0", "img-1"]));
  const scene = {
    epochs: () => JSON.stringify(config.epochs),
    all_dataset_settings: () => JSON.stringify(config.settings),
    c: () => config.activeC,
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

const view = { camera: { mode: "arcball" } } as unknown as SavedView;

describe("makeThumbnailRequester layer caching", () => {
  let config: SceneConfig;
  let sceneParts: ReturnType<typeof makeScene>;
  let rendered: unknown[][];
  let requestThumbnail: (view: SavedView, size: number) => Promise<ImageBitmap | null>;

  beforeEach(() => {
    config = {
      epochs: { content: 1, layout: 1, view: 1, selection: 1 },
      settings: { ds: { visible: true, contrast_min: 0, contrast_max: 100, gamma: 1 } },
      activeC: 0,
    };
    sceneParts = makeScene(config);
    rendered = [];
    const client = {
      thumbnailRender: vi.fn((layers: unknown[]) => {
        rendered.push(layers);
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

  it("shares one layer list across a batch of candidates", async () => {
    await requestThumbnail(view, 128);
    await requestThumbnail(view, 128);
    await requestThumbnail(view, 128);

    expect(sceneParts.memberRenderIds).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toBe(rendered[0]);
    expect(rendered[2]).toBe(rendered[0]);
  });

  it("rebuilds the list when the content epoch bumps", async () => {
    await requestThumbnail(view, 128);
    config.epochs = { ...config.epochs, content: 2 };
    await requestThumbnail(view, 128);

    expect(sceneParts.memberRenderIds).toHaveBeenCalledTimes(2);
    expect(rendered[1]).not.toBe(rendered[0]);
  });

  it("rebuilds the list when display settings change", async () => {
    await requestThumbnail(view, 128);
    config.settings = { ds: { visible: true, contrast_min: 5, contrast_max: 50, gamma: 1 } };
    await requestThumbnail(view, 128);

    expect(sceneParts.memberRenderIds).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached list across camera-only (view epoch) changes", async () => {
    await requestThumbnail(view, 128);
    config.epochs = { ...config.epochs, view: 9 };
    await requestThumbnail(view, 128);

    expect(sceneParts.memberRenderIds).toHaveBeenCalledTimes(1);
    expect(rendered[1]).toBe(rendered[0]);
  });

  it("returns null without rendering when the dataset is hidden", async () => {
    config.settings = { ds: { visible: false } };
    const result = await requestThumbnail(view, 128);

    expect(result).toBeNull();
    expect(rendered).toHaveLength(0);
  });
});
