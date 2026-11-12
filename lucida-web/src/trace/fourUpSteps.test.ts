/**
 * Scripted steps in four-up against the real wasm scene: the view the trace
 * seam reads (the share button's capture) and the layout step's show lists.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";

import { applyViewportCommand } from "../applyAndSend.ts";
import { singleImage } from "../pipeline/simulation/fixtures.ts";
import { buildCapture } from "../savedView/captureBuilder.ts";
import type { ArcballCamera, SavedView, SliceCamera } from "../savedView/types.ts";
import { viewLayoutActions } from "../viewLayout.ts";
import { layOutViews, viewSignature } from "./steps.ts";

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

const FIRST = singleImage({ id: "first", pyramid: { shape: [1, 1, 64, 256, 256], chunk: [32, 128, 128], levels: 2 } });
const SECOND = singleImage({ id: "second", pyramid: { shape: [1, 1, 64, 256, 256], chunk: [32, 128, 128], levels: 2 } });

function openScene(...datasets: (typeof FIRST)[]) {
  const scene = new WasmScene(1200, 800);
  for (const dataset of datasets) scene.apply_command(dataset.openCommand);
  scene.set_viewport(1200, 800, 1);
  const actions = viewLayoutActions(() => scene, () => null);
  // What `lucidaTrace.view()` answers.
  const view = (): SavedView => buildCapture({ scene, urlByDatasetId: new Map(), datasetReferenceMode: "workspace-dataset-id" });
  const shown = () => actions.views().map((id) => JSON.parse(scene.view_datasets(id)) as unknown);
  return { scene, actions, view, shown };
}

describe("the view a step records in four-up", () => {
  it("holds each view's own camera, and a gesture in one view moves that camera alone", () => {
    const { scene, actions, view } = openScene(FIRST);
    actions.setLayout("four_up");
    const ids = actions.views();
    const before = view();
    const cameras = (saved: SavedView) => saved.views!.views.map((shown) => shown.camera);
    const [xy, yz, xz, volume] = cameras(before) as [SliceCamera, SliceCamera, SliceCamera, ArcballCamera];
    expect([xy.mode, xy.plane ?? "xy"]).toEqual(["slice", "xy"]);
    expect([yz.plane, yz.transposed]).toEqual(["yz", true]);
    expect(xz.plane).toBe("xz");
    expect(volume.mode).toBe("arcball");

    // A wheel in the XZ view makes it active, then zooms it about the pointer.
    actions.activate(ids[2]);
    applyViewportCommand(scene, { type: "zoom_at", factor: 1.1, at: [0.5, 0.5] });
    const zoomed = view();
    const after = cameras(zoomed) as [SliceCamera, SliceCamera, SliceCamera, ArcballCamera];
    expect(after[2].zoom / xz.zoom).toBeCloseTo(1.1, 12);
    expect([after[0], after[1], after[3]]).toEqual([xy, yz, volume]);
    // The top-level camera is the active view's: XY's before, XZ's after.
    expect(before.camera).toEqual(xy);
    expect(zoomed.camera).toEqual(after[2]);
    expect(viewSignature(zoomed)).not.toEqual(viewSignature(before));

    // A wheel in the volume moves its camera in by the factor.
    actions.activate(ids[3]);
    applyViewportCommand(scene, { type: "arcball_zoom", delta: 1 / 1.1 - 1 });
    const orbited = cameras(view()) as [SliceCamera, SliceCamera, SliceCamera, ArcballCamera];
    expect(volume.distance / orbited[3].distance).toBeCloseTo(1.1, 12);
    expect(orbited.slice(0, 3)).toEqual(after.slice(0, 3));
  });

  it("is the same view when a press only changes which view is active", () => {
    const { actions, view } = openScene(FIRST);
    actions.setLayout("four_up");
    const before = view();
    actions.activate(actions.views()[1]);
    const after = view();
    expect(after.camera).not.toEqual(before.camera);
    expect(viewSignature(after)).toEqual(viewSignature(before));
  });
});

describe("a scripted four-up layout", () => {
  const both = { only: ["first", "second"] };

  it("shows the datasets its lists name in all four views", () => {
    const { actions, shown } = openScene(FIRST, SECOND);
    expect(layOutViews(actions, "four_up", [["first", "second"]], false)).toEqual({ applied: true, reason: null });
    expect(actions.layout()).toBe("four_up");
    expect(shown()).toEqual([both, both, both, both]);
  });

  it("shows one set in every view however the lists split it", () => {
    const { actions, shown } = openScene(FIRST, SECOND);
    layOutViews(actions, "four_up", [["first"], ["second"]], false);
    expect(shown()).toEqual([both, both, both, both]);
  });

  it("shows only the named set when the page is four-up already, with every view shown again", () => {
    const { actions, shown } = openScene(FIRST, SECOND);
    actions.setLayout("four_up");
    actions.maximize(actions.views()[0]);
    layOutViews(actions, "four_up", [["second"]], false);
    const second = { only: ["second"] };
    expect(shown()).toEqual([second, second, second, second]);
  });

  it("adds the set to what every view shows with keep, and with no lists shows every dataset", () => {
    const { actions, shown } = openScene(FIRST, SECOND);
    layOutViews(actions, "four_up", [], false);
    expect(shown()).toEqual(["all", "all", "all", "all"]);
    layOutViews(actions, "four_up", [["second"]], false);
    layOutViews(actions, "four_up", [["first"]], true);
    const kept = { only: ["second", "first"] };
    expect(shown()).toEqual([kept, kept, kept, kept]);
  });

  it("still moves each list into its own view in the other layouts", () => {
    const { actions, shown } = openScene(FIRST, SECOND);
    layOutViews(actions, "columns", [["first"], ["second"]], false);
    expect(shown()).toEqual([{ only: ["first"] }, { only: ["second"] }]);
    expect(layOutViews(actions, "columns", [["first"], ["second"], ["first"]], false)).toEqual({
      applied: false,
      reason: "a columns layout has 2 view(s), not 3",
    });
  });
});
