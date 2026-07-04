/**
 * Vocabulary lock for the `apply_command` JSON boundary: every command type in
 * `commands.ts` round-trips through the REAL wasm `scene.apply_command`
 * (`lucida-core/pkg`, the same bundle production loads), so the hand-written
 * TS mirrors cannot drift from the Rust serde shapes — a Rust-side tag or
 * field rename fails this suite even though the wire goldens deliberately
 * stop at the WebSocket envelope and never cross the TS->wasm seam.
 *
 * Three layers of lock:
 *  1. Type level: the case tables are `Record`s keyed by each union's `type`
 *     tags, so tsc rejects a vocabulary variant with no representative here
 *     (and a case whose body doesn't match its variant).
 *  2. Acceptance: every representative deserializes on the Rust side —
 *     `apply_command` throws on any JSON that matches neither enum.
 *  3. State: a handful of commands assert the scene actually changed via the
 *     scene's query surface, proving the values land (not just parse).
 *
 * Division of labor with `wireGoldens.test.ts`: the goldens lock the
 * client<->server envelopes (including the document-command bodies as
 * producers serialize them) against Rust-generated fixtures — field presence
 * and values via parsed comparison; JSON key order is serde-irrelevant and
 * not locked. This suite locks the local-apply vocabulary — including every
 * viewport command, which never crosses the server wire at all.
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
      name: "nuclei",
      source_image_id: "ms-0",
      image: {
        image_id: "ms-0:label:nuclei",
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

/** The author-view capture embedded in the `add_annotation` representative —
 *  exercises the one nested-document payload in the vocabulary. */
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

// ---------------------------------------------------------------------------
// Representative values — one per union member, keyed by tag so tsc enforces
// exhaustiveness against the vocabulary module.
// ---------------------------------------------------------------------------

const documentCases: {
  [K in DocumentCommand["type"]]: Extract<DocumentCommand, { type: K }>;
} = {
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
  set_c: { type: "set_c", c: 1 },
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
  set_multi_channel: { type: "set_multi_channel", enabled: true },
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
    name: "Nuclei",
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

// ---------------------------------------------------------------------------
// Acceptance: every representative parses on the Rust side
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// State visibility: the values land, not just parse
// ---------------------------------------------------------------------------

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

  it("set_c moves the channel selector", () => {
    const scene = freshScene();
    apply(scene, viewportCases.set_c);
    expect(scene.c()).toBe(1);
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

// ---------------------------------------------------------------------------
// Rejection: a bad command fails loudly at the boundary
// ---------------------------------------------------------------------------

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
