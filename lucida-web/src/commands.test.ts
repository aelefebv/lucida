/**
 * Locks the `apply_command` vocabulary: every command type in `commands.ts`
 * round-trips through the real wasm `scene.apply_command`, so the hand-written
 * mirrors can't drift from the Rust serde shapes. The case tables are `Record`s
 * keyed by tag, so tsc rejects a variant with no representative. The wire
 * goldens stop at the WebSocket envelope; this suite covers the TS-to-wasm
 * seam, including viewport commands that never cross the wire.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";

import type { DocumentCommand, ViewportCommand } from "./commands.ts";
import type { DatasetManifest } from "./manifestTypes.ts";
import type { SavedView } from "./savedView/types.ts";

beforeAll(async () => {
  // wasm-bindgen web target: init with the built .wasm bytes (cwd is lucida-web).
  const bytes = readFileSync(
    resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"),
  );
  await initWasm({ module_or_path: bytes });
});

const DS = "wds-vocab";

/** A small but structurally complete manifest (typed against the production
 *  mirror): 3 timepoints x 2 channels x 8 z-slices, one source layout, and one
 *  drawable uint32 label so the per-label commands have a real target
 *  (`set_label_*` is a no-op for out-of-range label indices). */
const manifest: DatasetManifest = {
  dataset_id: DS,
  name: "vocab-fixture.zarr",
  kind: "Single",
  entities: [{ id: "img-0", kind: "Image", parent: null, labels: {} }],
  transforms: [],
  images: [
    {
      image_id: "ms-0",
      owner: "img-0",
      multiscale: {
        axes: [
          { name: "t", kind: "Time" },
          { name: "c", kind: "Channel" },
          { name: "z", kind: "Space" },
          { name: "y", kind: "Space" },
          { name: "x", kind: "Space" },
        ],
        levels: [
          {
            level_index: 0,
            shape: [3, 2, 8, 512, 512],
            chunk_shape: [1, 1, 1, 256, 256],
            grid_shape: [3, 2, 8, 2, 2],
            scale: [1, 1, 1, 1, 1],
          },
          {
            level_index: 1,
            shape: [3, 2, 8, 256, 256],
            chunk_shape: [1, 1, 1, 256, 256],
            grid_shape: [3, 2, 8, 1, 1],
            scale: [1, 1, 1, 2, 2],
          },
        ],
        data_type: "Uint16",
      },
    },
  ],
  source_layouts: [
    {
      id: "layout-source",
      name: "Source positions",
      placements: [{ entity_id: "img-0", position: [0, 0] }],
    },
  ],
  default_layout_id: "layout-source",
  labels: [
    {
      name: "region-a",
      source_image_id: "ms-0",
      image: {
        image_id: "ms-0:label:region-a",
        owner: "img-0",
        multiscale: {
          axes: [
            { name: "z", kind: "Space" },
            { name: "y", kind: "Space" },
            { name: "x", kind: "Space" },
          ],
          levels: [
            {
              level_index: 0,
              shape: [1, 1, 8, 512, 512],
              chunk_shape: [1, 1, 1, 256, 256],
              grid_shape: [1, 1, 8, 2, 2],
              scale: [1, 1, 1, 1, 1],
            },
          ],
          data_type: "Uint32",
        },
      },
    },
  ],
};

/** A fresh scene with the fixture dataset loaded (settings seeded from the
 *  manifest, exactly as a snapshot restore seeds them). One per case so a
 *  destructive representative (`remove_dataset`) can't starve a later one. */
function freshScene(): WasmScene {
  const scene = new WasmScene(800, 600);
  scene.load_document(
    JSON.stringify({ manifests: { [DS]: manifest }, annotations: {} }),
  );
  return scene;
}

function apply(scene: WasmScene, cmd: DocumentCommand | ViewportCommand): void {
  scene.apply_command(JSON.stringify(cmd));
}

/** The author-view capture in the `add_annotation` representative, the one
 *  nested-document payload in the vocabulary. */
const pinView: SavedView = {
  v: 1,
  datasets: [],
  active_layouts: { [DS]: "layout-source" },
  camera: { mode: "slice", center: [256, 256], zoom: 1.5, viewport: [800, 600] },
  view: { z_range: { start: 2, end: 3 }, t: 1, c: 1, multi_channel: true },
  display: { contrast_min: 0, contrast_max: 4096, gamma: 1 },
  dataset_order: [DS],
  dataset_settings: {},
  auto_contrast: { [DS]: false },
};

// One representative per union member, keyed by tag so tsc enforces
// exhaustiveness.

const documentCases: {
  [K in DocumentCommand["type"]]: Extract<DocumentCommand, { type: K }>;
} = {
  set_user_transform: {
    type: "set_user_transform",
    dataset_id: DS,
    transform: { translation: [12.5, -4, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] },
  },
  remove_dataset: { type: "remove_dataset", id: DS },
  rename_dataset: { type: "rename_dataset", id: DS, name: "renamed.zarr" },
  register_layout: {
    type: "register_layout",
    dataset_id: DS,
    layout: {
      id: "layout-grid",
      name: "Grid",
      placements: [{ entity_id: "img-0", position: [0, 600] }],
    },
  },
  set_active_layout: {
    type: "set_active_layout",
    dataset_id: DS,
    layout_id: "layout-source",
  },
  add_annotation: {
    type: "add_annotation",
    dataset_id: DS,
    id: "pin-1",
    position: [10, 20],
    end: [40, 60],
    z: 2,
    t: 1,
    c: 1,
    author: "ada@example",
    kind: "box",
    view: pinView,
  },
  remove_annotation: { type: "remove_annotation", dataset_id: DS, id: "pin-1" },
  move_annotation: {
    type: "move_annotation",
    dataset_id: DS,
    id: "pin-1",
    position: [30, 40],
    end: null,
    z: 3,
  },
  add_comment: {
    type: "add_comment",
    dataset_id: DS,
    annotation_id: "pin-1",
    id: "comment-1",
    author: "7",
    text: "boundary looks off",
  },
  remove_comment: {
    type: "remove_comment",
    dataset_id: DS,
    annotation_id: "pin-1",
    id: "comment-1",
  },
  edit_comment: {
    type: "edit_comment",
    dataset_id: DS,
    annotation_id: "pin-1",
    id: "comment-1",
    text: "boundary confirmed",
  },
};

const viewportCases: {
  [K in ViewportCommand["type"]]: Extract<ViewportCommand, { type: K }>;
} = {
  set_view_layout: { type: "set_view_layout", layout: "columns" },
  set_active_view: { type: "set_active_view", view: 1 },
  set_view_datasets: { type: "set_view_datasets", view: 1, datasets: { only: [DS] } },
  move_dataset_to_view: { type: "move_dataset_to_view", view: 1, dataset_id: DS },
  maximize_view: { type: "maximize_view", view: null },
  set_mode_slice: { type: "set_mode_slice" },
  set_mode_arcball: { type: "set_mode_arcball" },
  set_mode_fly: { type: "set_mode_fly" },
  pan: { type: "pan", dx: 12.5, dy: -4 },
  zoom_by: { type: "zoom_by", factor: 1.25 },
  set_center: { type: "set_center", x: 128, y: 256 },
  set_zoom: { type: "set_zoom", value: 2 },
  arcball_rotate: { type: "arcball_rotate", d_theta: 0.1, d_phi: -0.2 },
  arcball_zoom: { type: "arcball_zoom", delta: 30 },
  arcball_pan: { type: "arcball_pan", dx: 5, dy: 6 },
  arcball_center_on_voxel: {
    type: "arcball_center_on_voxel",
    dataset_id: DS,
    x: 100,
    y: 120,
    z: 4,
  },
  fly_tick: {
    type: "fly_tick",
    dt: 0.016,
    forward: 1,
    right: 0,
    up: 0,
    yaw: 0.01,
    pitch: 0,
    roll: 0,
  },
  set_z: { type: "set_z", z: 5 },
  set_z_range: { type: "set_z_range", start: 1, end: 4 },
  set_t: { type: "set_t", t: 2 },
  set_y: { type: "set_y", y: 9 },
  set_x: { type: "set_x", x: 4 },
  set_slice_plane: { type: "set_slice_plane", plane: "xz" },
  set_contrast: { type: "set_contrast", min: 10, max: 5000 },
  set_gamma: { type: "set_gamma", gamma: 0.8 },
  set_dataset_order: { type: "set_dataset_order", order: [DS] },
  set_dataset_visible: { type: "set_dataset_visible", dataset_id: DS, visible: false },
  set_dataset_opacity: { type: "set_dataset_opacity", dataset_id: DS, opacity: 0.5 },
  set_dataset_contrast: {
    type: "set_dataset_contrast",
    dataset_id: DS,
    min: 20,
    max: 4000,
  },
  set_dataset_gamma: { type: "set_dataset_gamma", dataset_id: DS, gamma: 1.2 },
  set_dataset_blend_mode: {
    type: "set_dataset_blend_mode",
    dataset_id: DS,
    blend_mode: "additive",
  },
  set_dataset_render_mode: {
    type: "set_dataset_render_mode",
    dataset_id: DS,
    render_mode: "max_intensity",
  },
  set_dataset_detail_level_override: {
    type: "set_dataset_detail_level_override",
    dataset_id: DS,
    level: 1,
  },
  set_channel_solo: { type: "set_channel_solo", dataset_id: DS, channel: 1 },
  set_channel_visible: {
    type: "set_channel_visible",
    dataset_id: DS,
    channel: 1,
    visible: false,
  },
  set_channel_colormap: {
    type: "set_channel_colormap",
    dataset_id: DS,
    channel: 1,
    colormap: "magenta",
  },
  set_channel_name: {
    type: "set_channel_name",
    dataset_id: DS,
    channel: 1,
    name: "Region A",
  },
  set_channel_contrast: {
    type: "set_channel_contrast",
    dataset_id: DS,
    channel: 1,
    min: 5,
    max: 500,
  },
  set_channel_gamma: {
    type: "set_channel_gamma",
    dataset_id: DS,
    channel: 1,
    gamma: 0.9,
  },
  set_channel_blend_mode: {
    type: "set_channel_blend_mode",
    dataset_id: DS,
    blend_mode: "max",
  },
  set_label_visible: {
    type: "set_label_visible",
    dataset_id: DS,
    label: 0,
    visible: true,
  },
  set_label_opacity: {
    type: "set_label_opacity",
    dataset_id: DS,
    label: 0,
    opacity: 0.35,
  },
};

describe("command vocabulary: every DocumentCommand is accepted by the real wasm apply_command", () => {
  it.each(Object.entries(documentCases))("%s", (_tag, cmd) => {
    const scene = freshScene();
    expect(() => apply(scene, cmd)).not.toThrow();
  });
});

describe("command vocabulary: every ViewportCommand is accepted by the real wasm apply_command", () => {
  it.each(Object.entries(viewportCases))("%s", (_tag, cmd) => {
    const scene = freshScene();
    expect(() => apply(scene, cmd)).not.toThrow();
  });
});

describe("command vocabulary: state-visible commands change the scene", () => {
  it("set_z moves the z selector", () => {
    const scene = freshScene();
    apply(scene, viewportCases.set_z);
    expect(scene.z()).toBe(5);
  });

  it("set_t moves the timepoint selector", () => {
    const scene = freshScene();
    apply(scene, viewportCases.set_t);
    expect(scene.t()).toBe(2);
  });

  it("set_channel_solo solos one channel of the addressed layer", () => {
    const scene = freshScene();
    apply(scene, viewportCases.set_channel_solo);
    const layers = JSON.parse(scene.resolved_layers(scene.active_view())) as {
      dataset_id: string;
      solo: number | null;
      channels: { channel: number }[];
    }[];
    const layer = layers.find((l) => l.dataset_id === DS);
    expect(layer?.solo).toBe(1);
    expect(layer?.channels.map((c) => c.channel)).toEqual([1]);
  });

  it("set_channel_contrast lands in the addressed channel's settings", () => {
    const scene = freshScene();
    apply(scene, viewportCases.set_channel_contrast);
    const settings = JSON.parse(scene.all_dataset_settings()) as Record<
      string,
      { channel_settings?: { contrast_min: number; contrast_max: number }[] }
    >;
    expect(settings[DS].channel_settings?.[1]).toMatchObject({
      contrast_min: 5,
      contrast_max: 500,
    });
  });

  it("move_annotation repositions an added pin (add_annotation seeds it)", () => {
    const scene = freshScene();
    apply(scene, documentCases.add_annotation);
    apply(scene, documentCases.move_annotation);
    const pins = JSON.parse(scene.annotations(DS)) as {
      id: string;
      position: [number, number];
      z: number;
    }[];
    const pin = pins.find((p) => p.id === "pin-1");
    expect(pin).toBeDefined();
    expect(pin!.position).toEqual([30, 40]);
    expect(pin!.z).toBe(3);
  });
});

describe("command vocabulary: malformed commands throw at apply_command", () => {
  it("an unknown type tag throws (a tag typo cannot silently no-op)", () => {
    const scene = freshScene();
    const bogus: Record<string, unknown> = { type: "set_zeta", z: 1 };
    expect(() => scene.apply_command(JSON.stringify(bogus))).toThrow();
  });

  it("a wrongly-typed field value throws (serde rejects the payload)", () => {
    const scene = freshScene();
    const bogus: Record<string, unknown> = { type: "pan", dx: "fast", dy: 0 };
    expect(() => scene.apply_command(JSON.stringify(bogus))).toThrow();
  });
});
