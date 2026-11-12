// @vitest-environment happy-dom

/**
 * One overlay per view, over every dataset the view draws: each dataset's
 * marks placed as that dataset is, kept through a change of the selected
 * layer, one menu that adds to the layer under the pointer, and a selection
 * per view that only the active view's Delete and Escape act on.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ComponentProps } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay } from "./AnnotationOverlay.tsx";
import { AnnotationOverlay3D } from "./AnnotationOverlay3D.tsx";
import type { Annotation } from "./annotationDocument.ts";
import type { ViewContext } from "./annotationContext.ts";
import { __resetCommandsForTesting } from "../ui/commands.ts";
import { escapeTopLayer } from "../ui/escape.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";

const MY_ID = "7";

/** Where each dataset is placed: `beta` sits 200 samples right of `alpha`. */
const OFFSET_X: Record<string, number> = { alpha: 0, beta: 200 };

/**
 * A scene holding pins per dataset. The 2D camera is zoom 1 centered on the
 * origin over an 800x600 view, so a point of `alpha`'s frame at (x, y) sits
 * at client (x + 400, y + 300), and one of `beta`'s 200 px farther right. The
 * view draws `alpha` everywhere and `beta` over its right half, on top.
 */
function makeScene(byDataset: Record<string, Annotation[]>) {
  const pins: Record<string, Annotation[]> = JSON.parse(JSON.stringify(byDataset));
  const sent: Array<Record<string, unknown>> = [];
  const scene = {
    annotations: (datasetId: string) => JSON.stringify(pins[datasetId] ?? []),
    active_view: () => 0,
    zoom: () => 1,
    center: () => new Float64Array([0, 0]),
    transposed: () => false,
    dataset_placement: (datasetId: string) => new Float64Array([OFFSET_X[datasetId] ?? 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    slice_plane: () => "xy",
    annotation_shift: () => new Float64Array(3),
    pick_annotation_voxel: (_view: number, datasetId: string, x: number, y: number) =>
      new Float64Array([x - 400 - (OFFSET_X[datasetId] ?? 0), y - 300, 3.5]),
    layers_at: (_view: number, x: number) => JSON.stringify(x > 0.5 ? ["beta", "alpha"] : ["alpha"]),
    // A volume view: every vertex lands where its dataset's frame point does in 2D.
    project_annotation: (_view: number, datasetId: string, x: number, y: number) =>
      new Float64Array([x + 400 + (OFFSET_X[datasetId] ?? 0), y + 300]),
    export_presence: () => "not json",
    apply_command: (json: string) => {
      const cmd = JSON.parse(json) as Record<string, unknown>;
      const id = cmd.dataset_id as string;
      if (cmd.type === "add_annotation") {
        pins[id] = [...(pins[id] ?? []), { ...(cmd as unknown as Annotation), comments: [] }];
      } else if (cmd.type === "remove_annotation") {
        pins[id] = (pins[id] ?? []).filter((p) => p.id !== cmd.id);
      }
    },
  } as unknown as WasmScene;
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = scene;
  return { sceneRef, sent };
}

function makeElement(): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: 600, configurable: true });
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

const ON_PLANE: ViewContext = { cut: { axis: "z", start: 3, end: 4 }, t: 0, channels: [0] };

function contexts(datasetIds: string[]): Map<string, ViewContext> {
  return new Map(datasetIds.map((id) => [id, ON_PLANE]));
}

function pin(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return { id, kind: "point", position: [10, 20], z: 3, author: MY_ID, comments: [], ...overrides };
}

/** One's own box from (10, 20) to (60, 80) of its dataset's frame. */
function box(id: string): Annotation {
  return pin(id, { kind: "box", end: [60, 80] });
}

type OverlayProps = ComponentProps<typeof AnnotationOverlay>;

/** The props a view's overlay takes, as CanvasLayers builds them. */
function viewProps(
  sceneRef: ReturnType<typeof makeScene>["sceneRef"],
  sent: Array<Record<string, unknown>>,
  view: number,
  element: HTMLElement,
  overrides: Partial<OverlayProps>,
): OverlayProps {
  return {
    viewContexts: contexts(["alpha"]),
    selectedDatasetId: null,
    onSelectDataset: () => {},
    active: true,
    wasmSceneRef: sceneRef,
    surface: { view, element },
    version: 0,
    myId: MY_ID,
    sendCommand: (json) => sent.push(JSON.parse(json) as Record<string, unknown>),
    onDocumentChanged: () => {},
    ...overrides,
  };
}

// The frame clock's ticks run on demand, so a test reads a frame's projection.
let scheduled: FrameRequestCallback[] = [];
let originalRaf: typeof globalThis.requestAnimationFrame;
beforeEach(() => {
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
  scheduled = [];
  originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    scheduled.push(cb);
    return scheduled.length as unknown as number;
  }) as typeof globalThis.requestAnimationFrame;
});
afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  cleanup();
  document.body.innerHTML = "";
  __resetCommandsForTesting();
  __resetShortcutsForTesting();
});

function runFrame() {
  scheduled[scheduled.length - 1]?.(performance.now());
}

/** The pins an overlay's layer shows. */
const pinIds = (layer: Element) =>
  [...layer.querySelectorAll('[data-testid^="annot-pin-wrapper-"]')].map((el) =>
    el.getAttribute("data-testid")!.replace("annot-pin-wrapper-", ""),
  );
const layersIn = (container: HTMLElement) => container.querySelectorAll(".lc-annotation-layer");
const transformOf = (id: string) => screen.getByTestId(`annot-pin-wrapper-${id}`).style.transform;
const menuItems = () => within(screen.getByRole("menu")).getAllByRole("menuitem");

describe("a view's overlay draws every dataset it draws", () => {
  it("places each dataset's marks as that dataset is placed", () => {
    const { sceneRef, sent } = makeScene({ alpha: [pin("a1")], beta: [pin("b1")] });
    const element = makeElement();
    render(<AnnotationOverlay {...viewProps(sceneRef, sent, 0, element, { viewContexts: contexts(["alpha", "beta"]) })} />);
    runFrame();
    expect(transformOf("a1")).toBe("translate(410px, 320px)");
    expect(transformOf("b1")).toBe("translate(610px, 320px)");
  });

  it("keeps every dataset's marks through a change of the selected layer", () => {
    const { sceneRef, sent } = makeScene({ alpha: [pin("a1")], beta: [pin("b1")] });
    const element = makeElement();
    const props = (selectedDatasetId: string) =>
      viewProps(sceneRef, sent, 0, element, { viewContexts: contexts(["alpha", "beta"]), selectedDatasetId });
    const { rerender, container } = render(<AnnotationOverlay {...props("alpha")} />);
    expect(pinIds(container)).toEqual(["a1", "b1"]);
    rerender(<AnnotationOverlay {...props("beta")} />);
    expect(pinIds(container)).toEqual(["a1", "b1"]);
  });

  it("in two views, each keeps its own datasets' marks through a selection change", () => {
    const { sceneRef, sent } = makeScene({ alpha: [pin("a1")], beta: [pin("b1")] });
    const left = makeElement();
    const right = makeElement();
    const views = (selectedDatasetId: string) => (
      <>
        <AnnotationOverlay {...viewProps(sceneRef, sent, 0, left, { viewContexts: contexts(["alpha"]), selectedDatasetId, active: true })} />
        <AnnotationOverlay {...viewProps(sceneRef, sent, 1, right, { viewContexts: contexts(["beta"]), selectedDatasetId, active: false })} />
      </>
    );
    const { rerender, container } = render(views("alpha"));
    expect([...layersIn(container)].map(pinIds)).toEqual([["a1"], ["b1"]]);
    rerender(views("beta"));
    expect([...layersIn(container)].map(pinIds)).toEqual([["a1"], ["b1"]]);
  });

  it("the volume overlay draws every dataset's marks through its own projection", () => {
    const { sceneRef, sent } = makeScene({ alpha: [pin("a1")], beta: [pin("b1")] });
    const element = makeElement();
    const props = viewProps(sceneRef, sent, 0, element, {
      viewContexts: new Map([
        ["alpha", { cut: null, t: 0, channels: [0] }],
        ["beta", { cut: null, t: 0, channels: [0] }],
      ]),
    });
    render(<AnnotationOverlay3D {...props} />);
    runFrame();
    expect(transformOf("a1")).toBe("translate(410px, 320px)");
    expect(transformOf("b1")).toBe("translate(610px, 320px)");
  });
});

describe("a view's menu adds to the layer under the pointer", () => {
  function renderView(selectedDatasetId: string | null) {
    const { sceneRef, sent } = makeScene({ alpha: [], beta: [] });
    const element = makeElement();
    const selections: string[] = [];
    render(
      <AnnotationOverlay
        {...viewProps(sceneRef, sent, 0, element, {
          viewContexts: contexts(["alpha", "beta"]),
          selectedDatasetId,
          onSelectDataset: (id) => selections.push(id),
        })}
      />,
    );
    return { element, sent, selections };
  }

  async function dropPointAt(element: HTMLElement, clientX: number, clientY: number) {
    act(() => {
      fireEvent.contextMenu(element, { clientX, clientY });
    });
    await userEvent.click(screen.getByRole("menuitem", { name: "Drop a point" }));
  }

  it("goes on the topmost layer there, in its own frame, and selects that layer", async () => {
    const { element, sent, selections } = renderView(null);
    // The right half draws beta over alpha.
    await dropPointAt(element, 700, 350);
    expect(sent.filter((c) => c.type === "add_annotation")).toEqual([
      expect.objectContaining({ dataset_id: "beta", position: [100, 50], z: 3.5 }),
    ]);
    expect(selections).toEqual(["beta"]);
  });

  it("goes on the selected layer where the view draws it there, under another", async () => {
    const { element, sent, selections } = renderView("alpha");
    await dropPointAt(element, 700, 350);
    expect(sent.filter((c) => c.type === "add_annotation")).toEqual([
      expect.objectContaining({ dataset_id: "alpha", position: [300, 50], z: 3.5 }),
    ]);
    expect(selections).toEqual(["alpha"]);
  });

  it("goes on the layer the view draws there rather than a selected layer it doesn't", async () => {
    const { element, sent, selections } = renderView("beta");
    // The left half draws only alpha.
    await dropPointAt(element, 300, 350);
    expect(sent.filter((c) => c.type === "add_annotation")).toEqual([
      expect.objectContaining({ dataset_id: "alpha", position: [-100, 50] }),
    ]);
    expect(selections).toEqual(["alpha"]);
  });

  it("offers no point where the view draws no layer", () => {
    const { sceneRef, sent } = makeScene({ alpha: [] });
    (sceneRef.current as unknown as { layers_at: () => string }).layers_at = () => "[]";
    const element = makeElement();
    render(<AnnotationOverlay {...viewProps(sceneRef, sent, 0, element, {})} />);
    act(() => {
      fireEvent.contextMenu(element, { clientX: 300, clientY: 350 });
    });
    expect(menuItems().map((item) => item.getAttribute("aria-disabled"))).toEqual(["true", "true", "true"]);
  });
});

describe("each view keeps its own selection", () => {
  /** Two views, each drawing one dataset with one's own box, the left one active. */
  function renderTwoViews() {
    const { sceneRef, sent } = makeScene({ alpha: [box("box-a")], beta: [box("box-b")] });
    const left = makeElement();
    const right = makeElement();
    const views = (active: 0 | 1) => (
      <>
        <AnnotationOverlay {...viewProps(sceneRef, sent, 0, left, { viewContexts: contexts(["alpha"]), active: active === 0 })} />
        <AnnotationOverlay {...viewProps(sceneRef, sent, 1, right, { viewContexts: contexts(["beta"]), active: active === 1 })} />
      </>
    );
    const { rerender } = render(views(0));
    // A tap inside each box selects it: alpha's at client (435, 350), beta's
    // 200 px farther right.
    const tap = (element: HTMLElement, x: number) => {
      fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: x, clientY: 350 });
      fireEvent.pointerUp(element, { pointerId: 1, button: 0, clientX: x, clientY: 350 });
    };
    act(() => tap(left, 435));
    act(() => tap(right, 635));
    return { sent, setActive: (active: 0 | 1) => rerender(views(active)) };
  }

  const selected = (id: string) => screen.getByTestId(`annot-shape-${id}`).getAttribute("data-selected");

  it("selects in each view, and Delete removes only the active view's", () => {
    const { sent } = renderTwoViews();
    expect(selected("box-a")).toBe("true");
    expect(selected("box-b")).toBe("true");
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(sent.filter((c) => c.type === "remove_annotation")).toEqual([
      { type: "remove_annotation", dataset_id: "alpha", id: "box-a" },
    ]);
  });

  it("moves Delete to the view that becomes active", () => {
    const { sent, setActive } = renderTwoViews();
    setActive(1);
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(sent.filter((c) => c.type === "remove_annotation")).toEqual([
      { type: "remove_annotation", dataset_id: "beta", id: "box-b" },
    ]);
  });

  it("Escape deselects in the active view only", () => {
    renderTwoViews();
    act(() => {
      expect(escapeTopLayer()).toBe(true);
    });
    expect(selected("box-a")).toBeNull();
    expect(selected("box-b")).toBe("true");
    expect(escapeTopLayer()).toBe(false);
  });
});
