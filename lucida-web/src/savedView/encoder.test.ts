import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import { encode, decode, SavedViewDecodeError } from "./encoder.ts";
import {
  SAVED_VIEW_VERSION,
  type SavedView,
  type DatasetDisplaySettings,
  type ChannelSettings,
  type Colormap,
} from "./types.ts";
import { loadWasm } from "../viewProperties.ts";

beforeAll(() => loadWasm());

afterEach(() => {
  vi.restoreAllMocks();
});

function emptySliceView(viewport: [number, number] = [800, 600]): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport },
    view: { z_range: { start: 0, end: 1 }, t: 0 },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: [],
    dataset_settings: {},
  };
}

function channel(colormap: Colormap): ChannelSettings {
  return { visible: true, colormap, contrast_min: 0, contrast_max: 65535, gamma: 1.0 };
}

function datasetSettings(colormaps: Colormap[]): DatasetDisplaySettings {
  return {
    visible: true,
    opacity: 1.0,
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1.0,
    blend_mode: "alpha",
    render_mode: "translucent",
    channel_blend_mode: "additive",
    channel_settings: colormaps.map(channel),
  };
}

/** A payload as some other writer made it, bypassing the encoder. */
function handEncoded(obj: unknown): string {
  return gzipSync(JSON.stringify(obj)).toString("base64url");
}

/** The JSON a payload carries. */
function inflated(payload: string): Record<string, unknown> {
  return JSON.parse(gunzipSync(Buffer.from(payload, "base64url")).toString("utf8"));
}

describe("SavedView encoder", () => {
  describe("roundtrip", () => {
    it("empty view round-trips", () => {
      const v = emptySliceView();
      expect(decode(encode(v))).toEqual(v);
    });

    it("a multi-dataset view round-trips", () => {
      const v = emptySliceView();
      v.datasets = ["gs://bucket/a.zarr", "/data/b.zarr", "https://example.com/c.zarr"];
      v.dataset_order = ["ds-1", "ds-2", "ds-3"];
      v.active_layouts = { "ds-1": "L1", "ds-2": "L2" };
      v.dataset_settings = {
        "ds-1": { ...datasetSettings(["gray"]), opacity: 0.5 },
        "ds-2": { ...datasetSettings(["magenta", "green", "yellow"]), gamma: 0.8, solo: 2 },
      };
      v.view.t = 5;
      v.display.gamma = 1.5;
      expect(decode(encode(v))).toEqual(v);
    });

    it("3D cameras round-trip", () => {
      const v = emptySliceView();
      v.camera = {
        mode: "arcball",
        target: [1, 2, 3],
        theta: 0.5,
        phi: 0.3,
        distance: 100,
        fov: 45,
        viewport: [1024, 768],
        near: 0.1,
        far: 1000,
      };
      expect(decode(encode(v)).camera).toEqual(v.camera);
      v.camera = {
        mode: "fly",
        position: [10, 20, 30],
        orientation: [0, 0, 0, 1],
        fov: 60,
        viewport: [1280, 720],
        near: 0.1,
        far: 5000,
        speed_multiplier: 1.0,
      };
      expect(decode(encode(v)).camera).toEqual(v.camera);
    });

    it("a camera's floats survive to the last bit", () => {
      const v = emptySliceView();
      v.camera = {
        mode: "arcball",
        target: [0.1 + 0.2, -1e-300, 123456.78901234567],
        theta: 1.2853981633974483,
        phi: Math.PI / 7,
        distance: 2.8834740896113678,
        fov: 45,
        viewport: [1024, 768],
        near: 0.1,
        far: 1000,
      };
      expect(decode(encode(v)).camera).toEqual(v.camera);
    });

    it("a layer's solo round-trips, and its composite carries no key", () => {
      const v = emptySliceView();
      v.dataset_settings = {
        a: { ...datasetSettings(["magenta", "green", "cyan"]), solo: 2 },
        b: datasetSettings(["magenta", "green"]),
      };
      const back = decode(encode(v));
      expect(back.dataset_settings.a.solo).toBe(2);
      expect(back.dataset_settings.b).not.toHaveProperty("solo");
      expect(back.view).not.toHaveProperty("c");
      expect(back.view).not.toHaveProperty("multi_channel");
    });

    it("a version 1 view keeps its scene-wide channel mode, defaults included", () => {
      // Version 1 left out `c: 0` and `multi_channel: false`, which meant
      // channel 0 alone; the scene decodes that into each layer's solo.
      const single = { ...emptySliceView(), v: 1 };
      expect(decode(encode(single)).view).toMatchObject({ c: 0, multi_channel: false });

      const composite = {
        ...emptySliceView(),
        v: 1,
        view: { z_range: { start: 0, end: 1 }, t: 0, c: 2, multi_channel: true },
      };
      expect(decode(encode(composite)).view).toMatchObject({ c: 2, multi_channel: true });
    });

    it("unicode and very long strings round-trip", () => {
      const v = emptySliceView();
      const long = "gs://bucket/" + "a".repeat(2048) + ".zarr";
      v.datasets = [long];
      v.active_layouts = { "ds-x": "レイアウト-α" };
      const back = decode(encode(v));
      expect(back.datasets[0]).toBe(long);
      expect(back.active_layouts["ds-x"]).toBe("レイアウト-α");
    });

    it("re-encoding a decoded view is stable", () => {
      const v = emptySliceView();
      v.dataset_settings = { a: datasetSettings(["gray"]) };
      const payload = encode(v);
      expect(encode(decode(payload))).toBe(payload);
    });
  });

  describe("defaults", () => {
    it("an all-default view's payload carries nothing but its camera", () => {
      expect(inflated(encode(emptySliceView()))).toEqual({
        v: SAVED_VIEW_VERSION,
        camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 600] },
      });
    });

    it("a one-channel layer in gray carries its colormap, and the default cycle does not", () => {
      const v = emptySliceView();
      v.dataset_settings = {
        one: datasetSettings(["gray"]),
        three: datasetSettings(["magenta", "green", "cyan"]),
      };
      expect(inflated(encode(v)).dataset_settings).toEqual({
        one: { channel_settings: [{ colormap: "gray" }] },
        three: { channel_settings: [{}, {}, {}] },
      });
    });

    it("a channel left as `{}` restores the colormap of its index", () => {
      const payload = handEncoded({
        v: 2,
        camera: emptySliceView().camera,
        dataset_settings: { one: { channel_settings: [{}] }, two: { channel_settings: [{}, {}] } },
      });
      const back = decode(payload);
      expect(back.dataset_settings.one.channel_settings![0].colormap).toBe("magenta");
      expect(back.dataset_settings.two.channel_settings![1].colormap).toBe("green");
    });

    it("a level pin to level 0 survives, and none strips as absent", () => {
      const v = emptySliceView();
      v.dataset_settings = {
        pinned: { ...datasetSettings(["gray"]), detail_level_override: 0 },
        free: { ...datasetSettings(["gray"]), detail_level_override: null },
      };
      const back = decode(encode(v));
      expect(back.dataset_settings.pinned.detail_level_override).toBe(0);
      expect(back.dataset_settings.free).not.toHaveProperty("detail_level_override");
    });

    it("a channel whose only non-default is a name keeps it; others carry no name", () => {
      const v = emptySliceView();
      v.dataset_settings = { x: datasetSettings(["magenta", "green"]) };
      v.dataset_settings.x.channel_settings![0].name = "Region D";
      const back = decode(encode(v));
      expect(back.dataset_settings.x.channel_settings![0].name).toBe("Region D");
      expect(back.dataset_settings.x.channel_settings![1]).not.toHaveProperty("name");
    });

    it("auto_contrast keeps only its false entries", () => {
      const v = emptySliceView();
      v.auto_contrast = { "ds-a": false, "ds-b": true, "ds-c": false };
      expect(decode(encode(v)).auto_contrast).toEqual({ "ds-a": false, "ds-c": false });
      v.auto_contrast = { "ds-a": true };
      expect(decode(encode(v)).auto_contrast).toBeUndefined();
    });
  });

  describe("version handling", () => {
    it("rejects a payload without a positive version", () => {
      expect(() => decode(handEncoded({ camera: { mode: "slice" } }))).toThrow(SavedViewDecodeError);
      expect(() => decode(handEncoded({ v: 0, camera: { mode: "slice" } }))).toThrow(SavedViewDecodeError);
    });

    it("warns and proceeds for a newer version", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const back = decode(handEncoded({ ...emptySliceView(), v: 99 }));
      expect(warn).toHaveBeenCalled();
      expect(back.v).toBe(99);
    });

    it("always writes the current version", () => {
      expect(inflated(encode({ ...emptySliceView(), v: 99 })).v).toBe(SAVED_VIEW_VERSION);
    });

    it("rejects an empty or non-base64url payload", () => {
      expect(() => decode("")).toThrow(SavedViewDecodeError);
      expect(() => decode("not!!@@valid$$")).toThrow(SavedViewDecodeError);
    });
  });

  describe("size budget", () => {
    /**
     * One dataset whose 384 groups are members, under a 24x16 collection
     * layout with default display. The cost driver is the per-channel
     * defaults, which the encoder leaves out.
     */
    it("384-group collection share link fits under 1 KB", () => {
      const v = emptySliceView([1280, 720]);
      v.datasets = ["gs://bucket/big-collection-screen-2024.zarr"];
      v.dataset_order = ["ds-7777aaaabbbbcccc"];
      v.active_layouts = { "ds-7777aaaabbbbcccc": "collection-24x16-grid" };
      v.dataset_settings = {
        "ds-7777aaaabbbbcccc": datasetSettings(["magenta", "green", "cyan", "magenta"]),
      };
      v.camera = {
        mode: "slice",
        center: [12345.6789, -98765.4321],
        zoom: 8.5,
        viewport: [1280, 720],
      };
      const s = encode(v);
      expect(s.length, `encoded payload was ${s.length} chars`).toBeLessThan(1024);
    });
  });
});
