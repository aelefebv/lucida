/**
 * A view captured from the real wasm scene restores into another scene and
 * captures back unchanged, in each camera family and slice plane. The seam
 * is the one a saved view crosses: `export_presence` on capture,
 * `import_presence` on restore.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";

import { singleImage } from "../pipeline/simulation/fixtures.ts";
import type { ViewportCommand } from "../commands.ts";
import { buildCapture } from "./captureBuilder.ts";
import { SAVED_VIEW_VERSION, type SavedView } from "./types.ts";

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

const CANVAS = [1200, 800] as const;
const DATASET = singleImage({
  id: "vol",
  pyramid: { shape: [2, 1, 64, 512, 512], chunk: [32, 128, 128], levels: 3 },
});

function openScene(): WasmScene {
  const scene = new WasmScene(CANVAS[0], CANVAS[1]);
  scene.apply_command(DATASET.openCommand);
  scene.set_viewport(CANVAS[0], CANVAS[1], 1);
  return scene;
}

function capture(scene: WasmScene): SavedView {
  return buildCapture({ scene, urlByDatasetId: new Map(), datasetReferenceMode: "workspace-dataset-id" });
}

const CASES: Record<string, ViewportCommand[]> = {
  "a framed slice": [{ type: "set_z", z: 12 }],
  "a placed slice": [
    { type: "pan", dx: 140, dy: -60 },
    { type: "zoom_by", factor: 2.5 },
    { type: "set_z_range", start: 20, end: 24 },
    { type: "set_t", t: 1 },
  ],
  "a side view": [
    { type: "set_slice_plane", plane: "xz" },
    { type: "set_y", y: 300 },
    { type: "pan", dx: 30, dy: 10 },
    { type: "zoom_by", factor: 1.5 },
  ],
  "a side view along X": [
    { type: "set_slice_plane", plane: "yz" },
    { type: "set_x", x: 77 },
  ],
  "an arcball": [
    { type: "set_mode_arcball" },
    { type: "arcball_rotate", d_theta: 0.4, d_phi: -0.2 },
    { type: "arcball_zoom", delta: 0.3 },
    { type: "set_z", z: 9 },
  ],
  "a fly camera": [
    { type: "set_mode_fly" },
    { type: "fly_tick", dt: 0.1, forward: 1, right: 0.5, up: 0, yaw: 0.2, pitch: -0.1, roll: 0 },
  ],
};

describe("a saved view through the scene", () => {
  for (const [name, commands] of Object.entries(CASES)) {
    it(`restores ${name} and captures it back unchanged`, () => {
      const source = openScene();
      for (const command of commands) source.apply_command(JSON.stringify(command));
      const saved = capture(source);
      expect(saved.v).toBe(SAVED_VIEW_VERSION);

      const restored = openScene();
      restored.import_presence(JSON.stringify({
        camera: saved.camera,
        view: saved.view,
        display: saved.display,
        camera_space: saved.camera_space,
      }));
      expect(capture(restored)).toEqual(saved);
    });
  }
});
