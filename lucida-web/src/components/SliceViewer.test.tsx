// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import type { RenderLoop } from "../renderLoop.ts";
import { toastQueue } from "../ui/toastQueue.ts";
import type { AnnotationDraft } from "./annotationDraft.ts";
import type { Tool } from "./annotationTool.ts";
import { SliceViewer } from "./SliceViewer.tsx";

const WIDTH = 400;
const HEIGHT = 300;

/** Where a pick in `view` at device pixel `(x, y)` lands in a dataset's frame. */
type Pick = (view: number, x: number, y: number) => [number, number, number];

/** XY views at one sample per pixel with the scene's origin at the pane's
 * corner, cutting Z in the middle of plane 0. */
const XY_PICK: Pick = (_view, x, y) => [x, y, 0.5];

/**
 * Two views side by side, each over its own element, a 400 by 300 pane at one
 * sample per pixel with the scene's origin at its corner. `drawn` names the
 * layers each view draws under a point, topmost first, as lucida-core answers,
 * and `pick` where a point under the pointer lands.
 */
function makeScene(drawn: (view: number, x: number, y: number) => string[], pick: Pick = XY_PICK) {
  const applied: Array<Record<string, unknown>> = [];
  const asked: Array<[number, number, number]> = [];
  const scene = {
    zoom: () => 1,
    center: () => new Float64Array([WIDTH / 2, HEIGHT / 2]),
    transposed: () => false,
    layers_at: (view: number, x: number, y: number) => {
      asked.push([view, x, y]);
      return JSON.stringify(drawn(view, x, y));
    },
    dataset_placement: () => new Float64Array(),
    pick_annotation_voxel: (view: number, _ds: string, x: number, y: number) => new Float64Array(pick(view, x, y)),
    resolved_layers: () => "[]",
    z: () => 0,
    t: () => 0,
    active_view: () => 0,
    apply_command: (json: string) => applied.push(JSON.parse(json) as Record<string, unknown>),
  } as unknown as WasmScene;
  return { scene, applied, asked };
}

function makePane(left: number): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: WIDTH });
  Object.defineProperty(element, "clientHeight", { value: HEIGHT });
  element.getBoundingClientRect = () =>
    ({ left, top: 0, width: WIDTH, height: HEIGHT, right: left + WIDTH, bottom: HEIGHT, x: left, y: 0, toJSON() {} }) as DOMRect;
  // happy-dom may lack pointer capture.
  element.setPointerCapture = () => {};
  document.body.append(element);
  return element;
}

function renderViews(opts: { drawn: (view: number, x: number, y: number) => string[]; selected: string | null; tool?: Tool; pick?: Pick }) {
  const { scene, applied, asked } = makeScene(opts.drawn, opts.pick);
  const selected: string[] = [];
  const panes = [makePane(0), makePane(WIDTH)];
  render(
    <>
      {panes.map((element, view) => (
        <SliceViewer
          key={view}
          scene={scene}
          surface={{ view, element }}
          active={view === 0}
          emitPresence={() => {}}
          breakFollow={() => {}}
          sendCursor={() => {}}
          loopRef={createRef<RenderLoop | null>()}
          selectedDatasetId={opts.selected}
          selectDataset={(id) => selected.push(id)}
          tool={opts.tool ?? "point"}
          myId="me"
          sendCommand={() => {}}
          onDocumentChanged={() => {}}
          annotationDraftRef={createRef<AnnotationDraft | null>()}
        />
      ))}
    </>,
  );
  return { panes, applied, asked, selected };
}

function press(element: HTMLElement, from: [number, number], to: [number, number] = from) {
  const at = ([clientX, clientY]: [number, number]) => ({ pointerId: 1, pointerType: "mouse", button: 0, clientX, clientY, bubbles: true });
  element.dispatchEvent(new PointerEvent("pointerdown", at(from)));
  element.dispatchEvent(new PointerEvent("pointermove", at(to)));
  element.dispatchEvent(new PointerEvent("pointerup", at(to)));
}

/** Each view draws one dataset over its whole pane: `left` in view 0, `right` in view 1. */
const SIDE_BY_SIDE = (view: number) => [view === 0 ? "left" : "right"];

const added = (applied: Array<Record<string, unknown>>) => applied.filter((c) => c.type === "add_annotation");

beforeEach(() => toastQueue.clear());
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("SliceViewer annotation targeting", () => {
  it("puts a point on the dataset its own view draws, not the selected one another view shows", () => {
    const { panes, applied, asked, selected } = renderViews({ drawn: SIDE_BY_SIDE, selected: "right" });
    press(panes[0], [100, 150]);
    expect(added(applied)).toMatchObject([{ dataset_id: "left", kind: "point", position: [100, 150] }]);
    // Asked of the view it was placed in, at its place in that view.
    expect(asked).toEqual([[0, 0.25, 0.5]]);
    expect(selected).toEqual(["left"]);

    press(panes[1], [WIDTH + 300, 150]);
    expect(added(applied)[1]).toMatchObject({ dataset_id: "right", position: [300, 150] });
    expect(selected).toEqual(["left", "right"]);
  });

  it("puts a box on the dataset under its first corner, through that view's camera", () => {
    const { panes, applied } = renderViews({ drawn: SIDE_BY_SIDE, selected: "right", tool: "box" });
    press(panes[0], [40, 60], [120, 90]);
    expect(added(applied)).toMatchObject([{ dataset_id: "left", kind: "box", position: [40, 60], end: [120, 90] }]);
    // Drawn in XY, its corners share their depth, which goes unsent.
    expect(added(applied)[0]).not.toHaveProperty("end_z");
  });

  it("stores a mark drawn in a side view at every axis of its frame, each corner at its own depth", () => {
    // View 1 cuts XZ through the middle of plane 40 along Y: X across, Z down.
    const xz: Pick = (view, x, y) => (view === 1 ? [x, 40.5, y / 10] : [x, y, 0.5]);
    const { panes, applied } = renderViews({ drawn: SIDE_BY_SIDE, selected: "right", tool: "box", pick: xz });
    press(panes[1], [WIDTH + 40, 60], [WIDTH + 120, 90]);
    expect(added(applied)).toMatchObject([
      { dataset_id: "right", kind: "box", position: [40, 40.5], z: 6, end: [120, 40.5], end_z: 9 },
    ]);
  });

  it("keeps the selected layer where the view draws it under the pointer, over a layer above it", () => {
    const { panes, applied, selected } = renderViews({ drawn: () => ["top", "below"], selected: "below" });
    press(panes[0], [100, 150]);
    expect(added(applied)).toMatchObject([{ dataset_id: "below" }]);
    expect(selected).toEqual(["below"]);
  });

  it("places nothing, and says so, where its view draws no layer", () => {
    const { panes, applied, selected } = renderViews({ drawn: () => [], selected: "right" });
    press(panes[0], [100, 150]);
    expect(added(applied)).toEqual([]);
    expect(selected).toEqual([]);
    expect(toastQueue.visibleToasts.map((t) => t.content.title)).toEqual(["Nothing here to annotate"]);
  });

  it("asks nothing when the press pans", () => {
    const { panes, applied, asked } = renderViews({ drawn: SIDE_BY_SIDE, selected: "right", tool: "pan" });
    press(panes[0], [100, 150]);
    expect(added(applied)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
