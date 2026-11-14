/**
 * Opens that name their view, against the real wasm scene: each dataset
 * joins the view its open named once the open has completed and the scene
 * holds it, whichever comes first.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";

import { openTargets } from "./openTargets.ts";
import { singleImage } from "./pipeline/simulation/fixtures.ts";
import { layoutForEach, viewLayoutActions } from "./viewLayout.ts";

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

const IDS = ["first", "second", "third", "fourth"];
const DATASETS = IDS.map((id) =>
  singleImage({ id, pyramid: { shape: [1, 1, 16, 128, 128], chunk: [16, 64, 64], levels: 2 } }),
);
const urlOf = (id: string) => `/data/${id}.ome.zarr`;

function rig() {
  const scene = new WasmScene(1200, 800);
  scene.set_viewport(1200, 800, 1);
  const actions = viewLayoutActions(() => scene, () => null);
  const targets = openTargets({
    addToView: (view, datasetId) => actions.add(view, [datasetId]),
    holds: (datasetId) => (JSON.parse(scene.dataset_ids()) as string[]).includes(datasetId),
  });
  // The dataset reaching the scene, as the session's `dataset_opened` arm does it.
  const arrive = (at: number) => {
    scene.apply_command(DATASETS[at].openCommand);
    targets.opened(IDS[at]);
  };
  const complete = (at: number) => targets.completed(urlOf(IDS[at]), IDS[at]);
  const shows = (view: number) => JSON.parse(scene.view_datasets(view)) as "all" | { only: string[] };
  return { scene, actions, targets, arrive, complete, shows };
}

describe("openTargets", () => {
  it.each([2, 3, 4])("opens %i datasets one to a view, in the layout for their count", (count) => {
    const { scene, actions, targets, arrive, complete, shows } = rig();
    const views = actions.layOutEmpty(layoutForEach(count, false));
    IDS.slice(0, count).forEach((id, at) => targets.expect(urlOf(id), views[at]));
    // The server's word and the dataset arrive in either order.
    for (let at = 0; at < count; at++) {
      if (at % 2 === 0) {
        complete(at);
        arrive(at);
      } else {
        arrive(at);
        complete(at);
      }
    }
    expect(scene.view_layout()).toBe(count === 2 ? "columns" : "grid");
    expect(views.map(shows)).toEqual(
      views.map((_, at) => ({ only: at < count ? [IDS[at]] : [] })),
    );
  });

  it("adds to a view that lists its own datasets, and a view of every dataset shows it too", () => {
    const { actions, targets, arrive, complete, shows } = rig();
    actions.setLayout("columns");
    const [all, own] = actions.views();
    targets.expect(urlOf("first"), own);
    arrive(0);
    complete(0);
    expect(shows(own)).toEqual({ only: ["first"] });
    expect(shows(all)).toBe("all");
  });

  it("lands nothing for an open no view waits on, or one that failed", () => {
    const { actions, targets, arrive, complete, shows } = rig();
    actions.setLayout("columns");
    const [, own] = actions.views();
    targets.expect(urlOf("first"), own);
    targets.failed(urlOf("first"));
    arrive(0);
    complete(0);
    expect(shows(own)).toEqual({ only: [] });
  });

  it("answers several opens of one URL in the order they went out", () => {
    const { actions, targets, arrive, complete, shows } = rig();
    const views = actions.layOutEmpty("grid");
    targets.expect(urlOf("first"), views[1]);
    targets.expect(urlOf("first"), views[2]);
    complete(0);
    arrive(0);
    expect(views.map(shows)).toEqual([{ only: [] }, { only: ["first"] }, { only: [] }, { only: [] }]);
    complete(0);
    expect(views.map(shows)).toEqual([{ only: [] }, { only: ["first"] }, { only: ["first"] }, { only: [] }]);
  });

  it("adds to all four views in four-up, which show one set of datasets", () => {
    const { actions, targets, arrive, complete, shows } = rig();
    arrive(0);
    const [first] = actions.views();
    actions.show(first, ["first"]);
    actions.setLayout("four_up");
    const views = actions.views();
    targets.expect(urlOf("second"), views[2]);
    arrive(1);
    complete(1);
    expect(views.map(shows)).toEqual(views.map(() => ({ only: ["first", "second"] })));
  });
});
