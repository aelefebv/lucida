// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay } from "./AnnotationOverlay.tsx";
import type { ViewContext } from "./annotationContext.ts";
import type { Annotation } from "./annotationDocument.ts";
import type { SlicePlane } from "../renderer/slicePlane.ts";

const MY_ID = "7";

/**
 * A slice view of `plane`, 800 by 600 at one device pixel per sample with the
 * scene's origin in its middle, over a dataset at its declared place whose
 * planes along Z lie 2 samples apart in the scene. A pick lands on the plane
 * at its cut, in the middle of plane `cut`.
 */
function makeScene(plane: SlicePlane, pins: Annotation[], cut: number) {
  const sent: Array<Record<string, unknown>> = [];
  const scene = {
    annotations: () => JSON.stringify(pins),
    active_view: () => 0,
    zoom: () => 1,
    center: () => new Float64Array([0, 0]),
    transposed: () => false,
    slice_plane: () => plane,
    draws_annotations: () => true,
    dataset_placement: () => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2]),
    pick_annotation_voxel: (_view: number, _ds: string, x: number, y: number) => {
      const [across, down] = [x - 400, y - 300];
      const middle = cut + 0.5;
      if (plane === "xz") return new Float64Array([across, middle, down / 2]);
      if (plane === "yz") return new Float64Array([middle, across, down / 2]);
      return new Float64Array([across, down, middle]);
    },
    apply_command: (json: string) => sent.push(JSON.parse(json) as Record<string, unknown>),
  } as unknown as WasmScene;
  return { scene, sent };
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return canvas;
}

function renderIn(plane: SlicePlane, pins: Annotation[], cut: ViewContext["cut"]) {
  const { scene, sent } = makeScene(plane, pins, cut?.start ?? 0);
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = scene;
  render(
    <AnnotationOverlay
      datasetId="ds"
      wasmSceneRef={sceneRef}
      surface={{ view: 0, element: makeCanvas() }}
      version={0}
      viewContext={{ cut, t: 0, channels: [0] }}
      myId={MY_ID}
      sendCommand={() => {}}
      onDocumentChanged={() => {}}
    />,
  );
  return { sent };
}

// Capture scheduled frames so a test runs the overlay's tick on demand.
let scheduled: FrameRequestCallback[] = [];
let originalRaf: typeof globalThis.requestAnimationFrame;
beforeEach(() => {
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
  scheduled = [];
  originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    scheduled.push(cb);
    return scheduled.length;
  }) as typeof globalThis.requestAnimationFrame;
});
afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  cleanup();
});

function runFrame() {
  scheduled[scheduled.length - 1]?.(performance.now());
}

function transformOf(testId: string): string {
  return (screen.getByTestId(testId) as HTMLElement).style.transform;
}

/** A point of one's own, placed in an XY view on plane 9 at X 30, Y 40. */
const point: Annotation = { id: "p", kind: "point", position: [30, 40], z: 9.5, author: MY_ID, comments: [] };

describe("AnnotationOverlay in each plane", () => {
  it("draws a point at its place across and down the plane the view cuts", () => {
    renderIn("xy", [point], { axis: "z", start: 9, end: 10 });
    runFrame();
    expect(transformOf("annot-pin-wrapper-p")).toBe("translate(430px, 340px)");
    cleanup();
    // XZ: X across, Z down, 2 scene units a plane.
    renderIn("xz", [point], { axis: "y", start: 40, end: 41 });
    runFrame();
    expect(transformOf("annot-pin-wrapper-p")).toBe("translate(430px, 319px)");
    cleanup();
    // YZ: Y across, Z down.
    renderIn("yz", [point], { axis: "x", start: 30, end: 31 });
    runFrame();
    expect(transformOf("annot-pin-wrapper-p")).toBe("translate(440px, 319px)");
  });

  it("dims a point the side view's cut misses, naming its plane along that axis", () => {
    renderIn("xz", [point], { axis: "y", start: 12, end: 13 });
    const marker = screen.getByTestId("annot-pin-p");
    expect(marker.dataset.offContext).toBe("true");
    expect(screen.getByTestId("annot-offcontext-p").textContent).toBe("Y 41 · T 1 · Channel 1");
  });

  it("moves a point across a side view's plane, keeping its place along the cut", () => {
    const { sent } = renderIn("xz", [point], { axis: "y", start: 40, end: 41 });
    const marker = screen.getByTestId("annot-pin-p");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 430, clientY: 319 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 470, clientY: 350 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 450, clientY: 340 });
    const moves = sent.filter((c) => c.type === "move_annotation");
    // X 50 across and Z 20 down; it keeps Y 40, not the cut's middle.
    expect(moves).toMatchObject([{ position: [50, 40], z: 20 }]);
  });

  it("shows a box's handles only in the plane it was drawn in", () => {
    // Drawn in XZ at Y 40.5, from X 10 Z 2 to X 30 Z 6.
    const box: Annotation = {
      id: "b", kind: "box", position: [10, 40.5], z: 2, end: [30, 40.5], end_z: 6, author: MY_ID, comments: [],
    };
    renderIn("xz", [box], { axis: "y", start: 40, end: 41 });
    fireEvent.click(screen.getByTestId("annot-shape-b"));
    expect(screen.queryAllByTestId(/^annot-resize-b-/)).toHaveLength(8);
    cleanup();
    // In XY it shows edge on, as a line it can't be resized along.
    renderIn("xy", [box], { axis: "z", start: 4, end: 5 });
    fireEvent.click(screen.getByTestId("annot-shape-b"));
    expect(screen.queryAllByTestId(/^annot-resize-b-/)).toHaveLength(0);
  });

  it("reshapes a side-view box there, each corner at its own depth", () => {
    const box: Annotation = {
      id: "b", kind: "box", position: [10, 40.5], z: 2, end: [30, 40.5], end_z: 6, author: MY_ID, comments: [],
    };
    const { sent } = renderIn("xz", [box], { axis: "y", start: 40, end: 41 });
    fireEvent.click(screen.getByTestId("annot-shape-b"));
    const se = screen.getByTestId("annot-resize-b-se");
    // The `se` corner sits at X 30 Z 6, screen (430, 312); drag it to X 50 Z 10.
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 430, clientY: 312 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 440, clientY: 316 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 450, clientY: 320 });
    expect(sent.filter((c) => c.type === "move_annotation")).toMatchObject([
      { position: [10, 40.5], z: 2, end: [50, 40.5], end_z: 10 },
    ]);
  });
});
