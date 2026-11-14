/**
 * Link all and Unlink all against the real wasm scene, for a pair of slice
 * views, a pair of volumes and one of each: every property the cameras
 * share links, one they don't waits as it was, and Unlink all turns off
 * whatever can be set.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";

import { singleImage } from "./pipeline/simulation/fixtures.ts";
import { layoutForEach, layoutsFor, mostViews, viewLayoutActions } from "./viewLayout.ts";

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

// Two datasets without units, of different shapes: a pair whose links all
// default to off.
const FIRST = singleImage({ id: "first", pyramid: { shape: [2, 1, 64, 512, 512], chunk: [32, 128, 128], levels: 3 } });
const SECOND = singleImage({ id: "second", pyramid: { shape: [2, 1, 32, 256, 256], chunk: [32, 128, 128], levels: 2 } });

function sideBySide(modes: ["slice" | "arcball", "slice" | "arcball"]) {
  const scene = new WasmScene(1200, 800);
  scene.apply_command(FIRST.openCommand);
  scene.apply_command(SECOND.openCommand);
  scene.set_viewport(1200, 800, 1);
  const actions = viewLayoutActions(() => scene, () => null);
  actions.setLayout("columns");
  const views = actions.views();
  views.forEach((view, at) => {
    actions.show(view, [["first", "second"][at]]);
    if (modes[at] === "arcball") {
      actions.activate(view);
      scene.apply_command(JSON.stringify({ type: "set_mode_arcball" }));
    }
  });
  actions.activate(views[0]);
  const modesNow = () => Object.fromEntries(actions.links()?.properties.map((link) => [link.property, link.mode]) ?? []);
  return { actions, modesNow };
}

const OFF = { pan: "off", zoom: "off", orientation: "off", z: "off", t: "off", contrast: "off", colormap: "off" };

describe("linkAll", () => {
  it("links everything two slice views of one plane share, and orientation waits", () => {
    const { actions, modesNow } = sideBySide(["slice", "slice"]);
    expect(modesNow()).toEqual(OFF);
    actions.linkAll("linked");
    expect(modesNow()).toEqual({ ...OFF, pan: "linked", zoom: "linked", z: "linked", t: "linked", contrast: "linked", colormap: "linked" });
    actions.linkAll("off");
    expect(modesNow()).toEqual(OFF);
  });

  it("links everything two volumes share, and Z waits", () => {
    const { actions, modesNow } = sideBySide(["arcball", "arcball"]);
    actions.linkAll("linked");
    expect(modesNow()).toEqual({ ...OFF, pan: "linked", zoom: "linked", orientation: "linked", t: "linked", contrast: "linked", colormap: "linked" });
  });

  it("links only time and the channels between a slice view and a volume, and Unlink all turns off a waiting link", () => {
    const { actions, modesNow } = sideBySide(["slice", "arcball"]);
    actions.link("orientation", "relative");
    actions.linkAll("linked");
    expect(modesNow()).toEqual({ ...OFF, orientation: "relative", t: "linked", contrast: "linked", colormap: "linked" });
    actions.linkAll("off");
    expect(modesNow()).toEqual(OFF);
  });
});

describe("layoutForEach", () => {
  it("gives two datasets two views side by side, stacked on a phone, and three or four the quarters", () => {
    expect([1, 2, 3, 4].map((count) => layoutForEach(count, false))).toEqual(["single", "columns", "grid", "grid"]);
    expect([1, 2, 3, 4].map((count) => layoutForEach(count, true))).toEqual(["single", "rows", "grid", "grid"]);
  });
});

describe("mostViews", () => {
  it("holds four views on a wide screen and two on a phone", () => {
    expect(mostViews(layoutsFor(false))).toBe(4);
    expect(mostViews(layoutsFor(true))).toBe(2);
  });
});

describe("layOutEmpty", () => {
  it("divides the canvas with every view showing nothing, the first view too", () => {
    const scene = new WasmScene(1200, 800);
    scene.apply_command(FIRST.openCommand);
    const actions = viewLayoutActions(() => scene, () => null);
    const views = actions.layOutEmpty("grid");
    expect(views).toEqual(actions.views());
    expect(views.map((view) => JSON.parse(scene.view_datasets(view)))).toEqual(views.map(() => ({ only: [] })));
  });
});
