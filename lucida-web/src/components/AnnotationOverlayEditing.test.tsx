// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay } from "./AnnotationOverlay.tsx";
import type { Annotation, AnnotationOverlayHandle } from "./annotationDocument.ts";
import type { Tool } from "./annotationTool.ts";
import { __resetCommandsForTesting } from "../ui/commands.ts";
import { escapeTopLayer } from "../ui/escape.ts";
import { __resetShortcutsForTesting } from "../ui/shortcuts.ts";
import { LONG_PRESS_MS } from "../input/gestures.ts";

/**
 * Select-to-edit and the canvas menu in the 2D overlay. The harness camera is
 * zoom 1 centered on the origin over an 800x600 canvas at the page origin, so
 * world (x, y) sits at client (x + 400, y + 300).
 */
function makeScene(initial: Annotation[]) {
  let pins: Annotation[] = JSON.parse(JSON.stringify(initial));
  const applied: Array<Record<string, unknown>> = [];
  const scene = {
    annotations: () => JSON.stringify(pins),
    active_view: () => 0,
    zoom: () => 1,
    center: () => new Float64Array([0, 0]),
    dataset_placement: () => new Float64Array([0, 0, 0, 1, 1, 1]),
    export_presence: () => "not json",
    apply_command: (json: string) => {
      const cmd = JSON.parse(json) as Record<string, unknown>;
      applied.push(cmd);
      if (cmd.type === "move_annotation") {
        pins = pins.map((p) =>
          p.id === cmd.id
            ? { ...p, position: cmd.position as [number, number], ...(cmd.end ? { end: cmd.end as [number, number] } : {}) }
            : p,
        );
      } else if (cmd.type === "remove_annotation") {
        pins = pins.filter((p) => p.id !== cmd.id);
      } else if (cmd.type === "add_annotation") {
        pins = [...pins, { ...(cmd as unknown as Annotation), comments: [] }];
      }
    },
  } as unknown as WasmScene;
  return { scene, applied };
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.appendChild(canvas);
  return canvas;
}

const MY_ID = "7";

function renderOverlay(pins: Annotation[], tool: Tool = "pan") {
  const { scene, applied } = makeScene(pins);
  const sent: Array<Record<string, unknown>> = [];
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = scene;
  const handle = createRef<AnnotationOverlayHandle>();
  const canvas = makeCanvas();
  let version = 0;
  const ui = (v: number) => (
    <AnnotationOverlay
      ref={handle}
      datasetId="wds-1"
      wasmSceneRef={sceneRef}
      canvas={canvas}
      version={v}
      viewContext={{ z: 3, t: 1, channels: [0] }}
      myId={MY_ID}
      tool={tool}
      sendCommand={(json) => sent.push(JSON.parse(json) as Record<string, unknown>)}
      // Re-read as App does after a local change.
      onDocumentChanged={() => {
        version += 1;
        rerender(ui(version));
      }}
    />
  );
  const { rerender } = render(ui(version));
  return { canvas, applied, sent, handle };
}

function box(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "box-1",
    kind: "box",
    position: [10, 20],
    end: [60, 80],
    z: 3,
    author: MY_ID,
    comments: [],
    ...overrides,
  };
}

function point(overrides: Partial<Annotation> = {}): Annotation {
  return { id: "pin-a", kind: "point", position: [-100, -100], z: 3, author: MY_ID, comments: [], ...overrides };
}

/** A press and release on the canvas at a client point. */
function tapCanvas(canvas: HTMLCanvasElement, x: number, y: number, init: PointerEventInit = {}) {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: x, clientY: y, ...init });
  fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: x, clientY: y, ...init });
}

const handles = (id = "box-1") => document.querySelectorAll(`[data-testid^="annot-resize-${id}-"]`);

beforeEach(() => {
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  __resetCommandsForTesting();
  __resetShortcutsForTesting();
  vi.useRealTimers();
});

describe("AnnotationOverlay — select to edit", () => {
  it("a tap inside one's own box selects it and shows its handles without a hover", () => {
    const { canvas } = renderOverlay([box()]);
    expect(handles()).toHaveLength(0);
    act(() => tapCanvas(canvas, 435, 350));
    expect(handles()).toHaveLength(8);
    expect(screen.getByTestId("annot-shape-box-1").getAttribute("data-selected")).toBe("true");
  });

  it("a tap on empty canvas deselects", () => {
    const { canvas } = renderOverlay([box()]);
    act(() => tapCanvas(canvas, 435, 350));
    act(() => tapCanvas(canvas, 700, 550));
    expect(handles()).toHaveLength(0);
  });

  it("a finger's tap selects from farther off the stroke than a mouse's click", () => {
    const { canvas } = renderOverlay([box()]);
    // 15 px left of the box's left edge (client x 410).
    act(() => tapCanvas(canvas, 395, 350));
    expect(handles()).toHaveLength(0);
    act(() => tapCanvas(canvas, 395, 350, { pointerType: "touch" }));
    expect(handles()).toHaveLength(8);
  });

  it("never selects a collaborator's box", () => {
    const { canvas } = renderOverlay([box({ author: "999" })]);
    act(() => tapCanvas(canvas, 435, 350));
    expect(handles()).toHaveLength(0);
  });

  it("leaves taps to a drawing tool, which draws", () => {
    const { canvas } = renderOverlay([box()], "point");
    act(() => tapCanvas(canvas, 435, 350));
    expect(handles()).toHaveLength(0);
  });

  it("a press that travels, a pan, selects nothing", () => {
    const { canvas } = renderOverlay([box()]);
    act(() => {
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 435, clientY: 350 });
      fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, clientX: 480, clientY: 360 });
    });
    expect(handles()).toHaveLength(0);
  });

  it("dragging the selected box moves it whole, with no end and no Shift", () => {
    const { canvas, sent } = renderOverlay([box()]);
    act(() => tapCanvas(canvas, 435, 350));
    const body = screen.getByTestId("annot-body-box-1");
    fireEvent.pointerDown(body, { pointerId: 2, button: 0, clientX: 435, clientY: 350 });
    fireEvent.pointerMove(body, { pointerId: 2, clientX: 455, clientY: 340 });
    fireEvent.pointerUp(body, { pointerId: 2, clientX: 465, clientY: 330 });
    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([40, 0]);
    expect(moves[0].end).toBeUndefined();
  });

  it("clicking a box's outline selects it", () => {
    renderOverlay([box()]);
    fireEvent.click(screen.getByTestId("annot-shape-box-1"));
    expect(handles()).toHaveLength(8);
  });

  it("a click selects one's own pin, after which a plain drag moves it", () => {
    const { sent, applied } = renderOverlay([point()]);
    const marker = screen.getByTestId("annot-pin-pin-a");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.click(marker);
    expect(marker.getAttribute("data-selected")).toBe("true");

    fireEvent.pointerDown(marker, { pointerId: 2, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 2, clientX: 340, clientY: 220 });
    fireEvent.pointerUp(marker, { pointerId: 2, clientX: 350, clientY: 250 });
    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([-50, -50]);
    expect(applied.some((c) => c.type === "pan")).toBe(false);
  });

  it("a finger's drag on a pin goes to the canvas, where the gestures are", () => {
    const { canvas } = renderOverlay([point({ author: "999" })]);
    const downs: PointerEvent[] = [];
    canvas.addEventListener("pointerdown", (e) => downs.push(e as PointerEvent));
    const marker = screen.getByTestId("annot-pin-pin-a");
    fireEvent.pointerDown(marker, { pointerId: 5, pointerType: "touch", button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 5, pointerType: "touch", clientX: 330, clientY: 200 });
    expect(downs).toHaveLength(1);
    expect(downs[0].pointerType).toBe("touch");
    expect([downs[0].clientX, downs[0].clientY]).toEqual([300, 200]);
  });

  it("Escape deselects before it does anything else", () => {
    const { canvas } = renderOverlay([box()]);
    act(() => tapCanvas(canvas, 435, 350));
    // The tool palette's Escape runs the newest layer first.
    act(() => {
      expect(escapeTopLayer()).toBe(true);
    });
    expect(handles()).toHaveLength(0);
    expect(escapeTopLayer()).toBe(false);
  });
});

describe("AnnotationOverlay — Delete", () => {
  it("Delete removes the selected box at once when it has no comments", () => {
    const { canvas, sent } = renderOverlay([box()]);
    act(() => tapCanvas(canvas, 435, 350));
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(sent.filter((c) => c.type === "remove_annotation")).toEqual([
      { type: "remove_annotation", dataset_id: "wds-1", id: "box-1" },
    ]);
  });

  it("asks first, in the thread, when comments would go with it", () => {
    const { canvas, sent } = renderOverlay([box({ comments: [{ id: "c1", author: "999", text: "look" }] })]);
    act(() => tapCanvas(canvas, 435, 350));
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(sent.some((c) => c.type === "remove_annotation")).toBe(false);
    expect(screen.getByTestId("annot-thread-box-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pin-delete-confirm-box-1"));
    expect(sent.filter((c) => c.type === "remove_annotation")).toHaveLength(1);
  });

  it("does nothing with nothing selected", () => {
    const { sent } = renderOverlay([box()]);
    act(() => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    expect(sent).toHaveLength(0);
  });
});

describe("AnnotationOverlay — canvas menu", () => {
  const menuItems = () => within(screen.getByRole("menu")).getAllByRole("menuitem").map((e) => e.textContent);

  it("a right-click on empty canvas offers to comment, drop a point, and copy coordinates", () => {
    const { canvas } = renderOverlay([box()]);
    act(() => {
      fireEvent.contextMenu(canvas, { clientX: 700, clientY: 550 });
    });
    expect(menuItems()).toEqual(["Comment here", "Drop a point", "Copy coordinates"]);
  });

  it("a right-click on one's own box selects it and offers to delete it", async () => {
    const { canvas, sent } = renderOverlay([box()]);
    act(() => {
      fireEvent.contextMenu(canvas, { clientX: 435, clientY: 350 });
    });
    expect(menuItems()).toContain("Delete boxDel");
    expect(handles()).toHaveLength(8);
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete box/ }));
    expect(sent.filter((c) => c.type === "remove_annotation")).toHaveLength(1);
  });

  it("Drop a point adds one's own point where the menu opened, on the current plane", async () => {
    const { canvas, sent } = renderOverlay([]);
    act(() => {
      fireEvent.contextMenu(canvas, { clientX: 500, clientY: 350 });
    });
    await userEvent.click(screen.getByRole("menuitem", { name: "Drop a point" }));
    const adds = sent.filter((c) => c.type === "add_annotation");
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ kind: "point", position: [100, 50], end: null, z: 3, t: 1, c: 0, author: MY_ID });
  });

  it("Comment here adds a point and opens its thread", async () => {
    const { canvas, sent } = renderOverlay([]);
    act(() => {
      fireEvent.contextMenu(canvas, { clientX: 500, clientY: 350 });
    });
    await userEvent.click(screen.getByRole("menuitem", { name: "Comment here" }));
    const id = sent.find((c) => c.type === "add_annotation")?.id as string;
    expect(screen.getByTestId(`annot-thread-${id}`)).toBeTruthy();
  });

  it("opens from a long press the viewer reports", () => {
    const { handle } = renderOverlay([]);
    act(() => handle.current?.openContextMenu({ clientX: 500, clientY: 350 }));
    expect(menuItems()).toEqual(["Comment here", "Drop a point", "Copy coordinates"]);
  });

  it("opens from a finger held on a shape's stroke, selecting the shape", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderOverlay([box()]);
    const stroke = screen.getByTestId("annot-shape-box-1");
    fireEvent.pointerDown(stroke, { pointerId: 4, pointerType: "touch", button: 0, clientX: 410, clientY: 350 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(menuItems()).toContain("Delete boxDel");
    expect(handles()).toHaveLength(8);
  });

  it("opens from a finger held on one's own pin, selecting it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderOverlay([point()]);
    const marker = screen.getByTestId("annot-pin-pin-a");
    fireEvent.pointerDown(marker, { pointerId: 3, pointerType: "touch", button: 0, clientX: 300, clientY: 200 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(menuItems()).toContain("Delete pointDel");
    expect(marker.getAttribute("data-selected")).toBe("true");
  });
});
