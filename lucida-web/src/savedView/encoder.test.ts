import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encode, decode, SavedViewDecodeError } from "./encoder.ts";
import {
  SAVED_VIEW_VERSION,
  type SavedView,
  type DatasetDisplaySettings,
  type ChannelSettings,
} from "./types.ts";

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

function defaultChannel(index: number): ChannelSettings {
  const cycle = ["magenta", "green", "cyan"] as const;
  return {
    visible: true,
    colormap: cycle[index % cycle.length],
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1.0,
  };
}

function defaultDatasetSettings(channelCount: number): DatasetDisplaySettings {
  return {
    visible: true,
    opacity: 1.0,
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1.0,
    blend_mode: "alpha",
    render_mode: "translucent",
    channel_blend_mode: "additive",
    channel_settings: Array.from({ length: channelCount }, (_, i) => defaultChannel(i)),
  };
}

describe("SavedView encoder", () => {
  describe("roundtrip", () => {
    it("empty view round-trips", async () => {
      const v = emptySliceView();
      const back = await decode(await encode(v));
      expect(back).toEqual(v);
    });

    it("single-dataset view round-trips", async () => {
      const v = emptySliceView();
      v.datasets = ["gs://bucket/a.zarr"];
      v.dataset_order = ["ds-aaaa"];
      v.active_layouts = { "ds-aaaa": "collection-3x3" };
      v.dataset_settings = { "ds-aaaa": defaultDatasetSettings(2) };
      v.view.t = 5;
      v.dataset_settings["ds-aaaa"].solo = 1;
      v.display.gamma = 1.5;
      const back = await decode(await encode(v));
      expect(back).toEqual(v);
    });

    it("multi-dataset view round-trips", async () => {
      const v = emptySliceView();
      v.datasets = [
        "gs://bucket/a.zarr",
        "/data/b.zarr",
        "https://example.com/c.zarr",
      ];
      v.dataset_order = ["ds-1", "ds-2", "ds-3"];
      v.active_layouts = { "ds-1": "L1", "ds-2": "L2" };
      v.dataset_settings = {
        "ds-1": { ...defaultDatasetSettings(1), opacity: 0.5 },
        "ds-2": { ...defaultDatasetSettings(3), gamma: 0.8 },
      };
      const back = await decode(await encode(v));
      expect(back).toEqual(v);
    });

    it("3D arcball camera round-trips", async () => {
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
      const back = await decode(await encode(v));
      expect(back.camera).toEqual(v.camera);
    });

    it("fly camera round-trips", async () => {
      const v = emptySliceView();
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
      const back = await decode(await encode(v));
      expect((back.camera as typeof v.camera).position).toEqual([10, 20, 30]);
    });

    it("view with z slab round-trips", async () => {
      const v = emptySliceView();
      v.view.z_range = { start: 10, end: 25 };
      const back = await decode(await encode(v));
      expect(back.view.z_range).toEqual({ start: 10, end: 25 });
    });

    it("a layer's solo round-trips, and its composite carries no key", async () => {
      const v = emptySliceView();
      v.dataset_settings = { a: { ...defaultDatasetSettings(3), solo: 2 }, b: defaultDatasetSettings(2) };
      const back = await decode(await encode(v));
      expect(back.dataset_settings.a.solo).toBe(2);
      expect(back.dataset_settings.b).not.toHaveProperty("solo");
      expect(back.view).not.toHaveProperty("c");
      expect(back.view).not.toHaveProperty("multi_channel");
    });

    it("a version 1 payload decodes with its scene-wide channel mode, defaults included", async () => {
      // Version 1 stripped `c: 0` and `multi_channel: false`, which meant
      // channel 0 alone; the scene decodes that into each layer's solo.
      const single = { ...emptySliceView(), v: 1 };
      const back = await decode(await encode(single));
      expect(back.view).toMatchObject({ c: 0, multi_channel: false });

      const composite = { ...emptySliceView(), v: 1, view: { z_range: { start: 0, end: 1 }, t: 0, c: 2, multi_channel: true } };
      const again = await decode(await encode(composite));
      expect(again.view).toMatchObject({ c: 2, multi_channel: true });
    });

    it("unicode in layout IDs round-trips", async () => {
      const v = emptySliceView();
      v.datasets = ["gs://bucket/a.zarr"];
      v.dataset_order = ["ds-x"];
      v.active_layouts = { "ds-x": "レイアウト-α" };
      const back = await decode(await encode(v));
      expect(back.active_layouts["ds-x"]).toBe("レイアウト-α");
    });

    it("zero-length dataset list round-trips", async () => {
      const v = emptySliceView();
      v.datasets = [];
      const back = await decode(await encode(v));
      expect(back.datasets).toEqual([]);
    });

    it("very long URL round-trips", async () => {
      const v = emptySliceView();
      const long = "gs://bucket/" + "a".repeat(2048) + ".zarr";
      v.datasets = [long];
      const back = await decode(await encode(v));
      expect(back.datasets[0]).toBe(long);
    });
  });

  describe("defaults stripping", () => {
    it("encoded payload of empty view is small", async () => {
      const v = emptySliceView();
      const s = await encode(v);
      // The gzipped body is hard to inspect; under 200 chars means the
      // defaults were stripped.
      expect(s.length).toBeLessThan(200);
    });

    it("dataset_settings default values restore identically after strip", async () => {
      const v = emptySliceView();
      v.datasets = ["gs://x"];
      v.dataset_order = ["ds-x"];
      v.dataset_settings = { "ds-x": defaultDatasetSettings(2) };
      const back = await decode(await encode(v));
      expect(back.dataset_settings["ds-x"]).toEqual(defaultDatasetSettings(2));
    });

    it("explicit detail level override round-trips", async () => {
      const v = emptySliceView();
      v.datasets = ["gs://x"];
      v.dataset_order = ["ds-x"];
      v.dataset_settings = {
        "ds-x": { ...defaultDatasetSettings(1), detail_level_override: 2 },
      };
      const back = await decode(await encode(v));
      expect(back.dataset_settings["ds-x"].detail_level_override).toBe(2);
    });

    it("a level pin to level 0 survives the round trip and is not mistaken for absent", async () => {
      const v = emptySliceView();
      v.datasets = ["gs://x"];
      v.dataset_order = ["ds-x"];
      v.dataset_settings = {
        "ds-x": { ...defaultDatasetSettings(1), detail_level_override: 0 },
      };
      const back = await decode(await encode(v));
      expect(back.dataset_settings["ds-x"].detail_level_override).toBe(0);
    });

    it("default null detail override strips as absent", async () => {
      const v = emptySliceView();
      v.datasets = ["gs://x"];
      v.dataset_order = ["ds-x"];
      v.dataset_settings = {
        "ds-x": { ...defaultDatasetSettings(1), detail_level_override: null },
      };
      const back = await decode(await encode(v));
      expect(back.dataset_settings["ds-x"].detail_level_override ?? null).toBeNull();
    });

    it("only non-default channel settings survive but indices preserved", async () => {
      const v = emptySliceView();
      v.datasets = ["gs://x"];
      v.dataset_order = ["ds-x"];
      const ch0 = defaultChannel(0);
      ch0.contrast_max = 1000; // non-default
      const settings = defaultDatasetSettings(2);
      settings.channel_settings = [ch0, defaultChannel(1)];
      v.dataset_settings = { "ds-x": settings };
      const back = await decode(await encode(v));
      expect(back.dataset_settings["ds-x"].channel_settings![0].contrast_max).toBe(1000);
      // index-1 default restored
      expect(back.dataset_settings["ds-x"].channel_settings![1].colormap).toBe("green");
    });

    it("user channel-name override round-trips; un-named channels stay absent", async () => {
      const v = emptySliceView();
      v.datasets = ["gs://x"];
      v.dataset_order = ["ds-x"];
      const ch0 = defaultChannel(0);
      ch0.name = "Region A"; // user override
      const settings = defaultDatasetSettings(2);
      settings.channel_settings = [ch0, defaultChannel(1)];
      v.dataset_settings = { "ds-x": settings };
      const back = await decode(await encode(v));
      expect(back.dataset_settings["ds-x"].channel_settings![0].name).toBe("Region A");
      // A channel with no override has no `name` key.
      expect(back.dataset_settings["ds-x"].channel_settings![1].name).toBeUndefined();
    });

    it("a channel whose ONLY non-default is a name override survives", async () => {
      // `name` alone must flip the stripper's `any` flag, or the channel
      // collapses to `{}` and the name is lost.
      const v = emptySliceView();
      v.datasets = ["gs://x"];
      v.dataset_order = ["ds-x"];
      const ch0 = defaultChannel(0); // every field default...
      ch0.name = "Region D"; // ...except the override.
      const settings = defaultDatasetSettings(1);
      settings.channel_settings = [ch0];
      v.dataset_settings = { "ds-x": settings };
      const back = await decode(await encode(v));
      expect(back.dataset_settings["ds-x"].channel_settings![0].name).toBe("Region D");
    });

    it("auto_contrast: false entries round-trip; true entries are stripped (default)", async () => {
      const v = emptySliceView();
      v.auto_contrast = { "ds-a": false, "ds-b": true, "ds-c": false };
      const back = await decode(await encode(v));
      expect(back.auto_contrast).toEqual({ "ds-a": false, "ds-c": false });
    });

    it("auto_contrast: undefined when only true entries present", async () => {
      const v = emptySliceView();
      v.auto_contrast = { "ds-a": true, "ds-b": true };
      const back = await decode(await encode(v));
      expect(back.auto_contrast).toBeUndefined();
    });
  });

  describe("version handling", () => {
    it("rejects payload missing version", async () => {
      // Hand-encode an object without `v`.
      const obj = { camera: { mode: "slice" } };
      const json = JSON.stringify(obj);
      const gz = await gzipForTest(new TextEncoder().encode(json));
      const b64 = base64UrlEncodeForTest(gz);
      await expect(decode(b64)).rejects.toBeInstanceOf(SavedViewDecodeError);
    });

    it("rejects payload with v: 0", async () => {
      const obj = { v: 0, camera: { mode: "slice" } };
      const gz = await gzipForTest(new TextEncoder().encode(JSON.stringify(obj)));
      await expect(decode(base64UrlEncodeForTest(gz))).rejects.toBeInstanceOf(SavedViewDecodeError);
    });

    it("warns and proceeds for v > 1", async () => {
      const v = emptySliceView();
      const futureView: SavedView = { ...v, v: 99 };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const back = await decode(await encode(futureView));
        expect(warn).toHaveBeenCalled();
        expect(back.v).toBe(99);
      } finally {
        warn.mockRestore();
      }
    });

    it("rejects an empty string payload", async () => {
      await expect(decode("")).rejects.toBeInstanceOf(SavedViewDecodeError);
    });

    it("rejects a non-base64url string", async () => {
      await expect(decode("not!!@@valid$$")).rejects.toBeInstanceOf(SavedViewDecodeError);
    });
  });

  describe("size budget", () => {
    /**
     * One dataset whose 384 groups are members, under a 24x16 collection
     * layout with default display. The cost driver is the per-channel
     * defaults, which the encoder strips.
     */
    it("384-group collection share link fits under 1 KB", async () => {
      const v = emptySliceView([1280, 720]);
      v.datasets = ["gs://bucket/big-collection-screen-2024.zarr"];
      v.dataset_order = ["ds-7777aaaabbbbcccc"];
      v.active_layouts = { "ds-7777aaaabbbbcccc": "collection-24x16-grid" };
      v.dataset_settings = {
        "ds-7777aaaabbbbcccc": defaultDatasetSettings(4),
      };
      v.camera = {
        mode: "slice",
        center: [12345.6789, -98765.4321],
        zoom: 8.5,
        viewport: [1280, 720],
      };
      v.view.t = 0;
      const s = await encode(v);
      expect(s.length, `encoded payload was ${s.length} chars`).toBeLessThan(1024);
    });
  });
});

// Local copies of the encoder's private gzip/base64url helpers. If the
// encoder switches algorithms, the hand-encoded version tests catch it.

async function gzipForTest(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(new Blob([bytes as BlobPart])).body!
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64UrlEncodeForTest(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

beforeEach(() => {
});

afterEach(() => {
  vi.restoreAllMocks();
});
