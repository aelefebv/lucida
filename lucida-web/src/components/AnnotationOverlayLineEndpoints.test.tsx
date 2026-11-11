// @vitest-environment happy-dom

/**
 * Line endpoint adjustment. Hovering the line reveals its two grips; dragging
 * one emits a single reshape `move_annotation` that moves only that vertex.
 *
 * Harness camera: zoom=1, center=(0,0), 800x600, dpr=1, so
 * world = (clientX - 400, clientY - 300).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay } from "./AnnotationOverlay.tsx";
import type { Annotation } from "./annotationDocument.ts";

function makeScene(initial: Annotation[]): {
  scene: WasmScene;
  applied: Array<Record<string, unknown>>;
} {
  let pins: Annotation[] = JSON.parse(JSON.stringify(initial));
  const applied: Array<Record<string, unknown>> = [];
  const scene = {
    annotations: (_datasetId: string) => JSON.stringify(pins),
    active_view: () => 0,
    zoom: () => 1,
    center: () => new Float64Array([0, 0]),
    dataset_placement: () => new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    apply_command: (json: string) => {
      const cmd = JSON.parse(json) as Record<string, unknown>;
      applied.push(cmd);
      // Reflect a reshape so a re-read sees both vertices.
      if (cmd.type === "move_annotation") {
        pins = pins.map((p) =>
          p.id === cmd.id
            ? {
                ...p,
                position: cmd.position as [number, number],
                z: cmd.z as number,
                ...(cmd.end !== undefined ? { end: cmd.end as [number, number] | null } : {}),
              }
            : p,
        );
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
  return canvas;
}

const MY_ID = "7";

function renderOverlay(opts: { pins: Annotation[]; myId?: string }) {
  const { scene, applied } = makeScene(opts.pins);
  const sent: Array<Record<string, unknown>> = [];
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = scene;
  let changed = 0;
  const canvas = makeCanvas();
  render(
    <AnnotationOverlay
      datasetId="wds-1"
      wasmSceneRef={sceneRef}
      surface={{ view: 0, element: canvas }}
      version={0}
      viewContext={{ z: 3, t: 0, channels: [0] }}
      myId={opts.myId ?? MY_ID}
      sendCommand={(json) => sent.push(JSON.parse(json) as Record<string, unknown>)}
      onDocumentChanged={() => {
        changed += 1;
      }}
      onViewportChanged={() => {}}
    />,
  );
  return { applied, sent, getChanged: () => changed };
}

/** An own LINE pin with anchor `position` and far endpoint `end`. */
function linePin(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "ln-1",
    position: [10, 20],
    end: [60, 80],
    z: 3,
    author: String(MY_ID),
    kind: "line",
    comments: [],
    ...overrides,
  };
}

/** Reveal an own line's endpoint handles by hovering its segment. */
function hoverLine(id = "ln-1") {
  fireEvent.pointerEnter(screen.getByTestId(`annot-shape-${id}`));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("AnnotationOverlay — adjust a line endpoint (move_annotation reshape)", () => {
  it("an own line shows no endpoint handles before hover (not always-on)", () => {
    renderOverlay({ pins: [linePin()] });
    expect(screen.getByTestId("annot-shape-ln-1")).toBeTruthy();
    expect(screen.queryByTestId("annot-resize-ln-1-start")).toBeNull();
    expect(screen.queryByTestId("annot-resize-ln-1-end")).toBeNull();
  });

  it("hovering an own line reveals both endpoint handles (start + end)", () => {
    renderOverlay({ pins: [linePin()] });
    hoverLine();
    expect(screen.getByTestId("annot-resize-ln-1-start")).toBeTruthy();
    expect(screen.getByTestId("annot-resize-ln-1-end")).toBeTruthy();
    // Never the box's eight.
    for (const h of ["nw", "ne", "se", "sw", "n", "e", "s", "w"]) {
      expect(screen.queryByTestId(`annot-resize-ln-1-${h}`)).toBeNull();
    }
  });

  it("dragging START moves only position; end is unchanged", () => {
    const { sent, getChanged } = renderOverlay({ pins: [linePin()] });
    hoverLine();
    const start = screen.getByTestId("annot-resize-ln-1-start");

    // Release at client (300,250) = world (-100,-50).
    fireEvent.pointerDown(start, { pointerId: 1, button: 0, clientX: 410, clientY: 320 });
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 350, clientY: 300 });
    fireEvent.pointerUp(start, { pointerId: 1, clientX: 300, clientY: 250 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      type: "move_annotation",
      dataset_id: "wds-1",
      id: "ln-1",
      z: 3,
    });
    expect(moves[0].position).toEqual([-100, -50]); // grabbed end moved to release
    expect(moves[0].end).toEqual([60, 80]); // far endpoint UNCHANGED (original)
    expect(getChanged()).toBe(1);
  });

  it("dragging END moves only end; position is unchanged", () => {
    const { sent, getChanged } = renderOverlay({ pins: [linePin()] });
    hoverLine();
    const end = screen.getByTestId("annot-resize-ln-1-end");

    // Release at client (500,400) = world (100,100).
    fireEvent.pointerDown(end, { pointerId: 2, button: 0, clientX: 460, clientY: 380 });
    fireEvent.pointerMove(end, { pointerId: 2, clientX: 480, clientY: 390 });
    fireEvent.pointerUp(end, { pointerId: 2, clientX: 500, clientY: 400 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([10, 20]); // anchor UNCHANGED (original)
    expect(moves[0].end).toEqual([100, 100]); // grabbed end moved to release
    expect(getChanged()).toBe(1);
  });

  it("the reshape applies locally too (optimistic), exactly once", () => {
    const { applied, sent } = renderOverlay({ pins: [linePin()] });
    hoverLine();
    const end = screen.getByTestId("annot-resize-ln-1-end");
    fireEvent.pointerDown(end, { pointerId: 3, button: 0, clientX: 460, clientY: 380 });
    fireEvent.pointerMove(end, { pointerId: 3, clientX: 500, clientY: 400 });
    fireEvent.pointerUp(end, { pointerId: 3, clientX: 500, clientY: 400 });
    expect(applied.filter((c) => c.type === "move_annotation")).toHaveLength(1);
    expect(sent.filter((c) => c.type === "move_annotation")).toHaveLength(1);
  });

  it("a press on an endpoint that never passes the slop emits nothing", () => {
    const { sent } = renderOverlay({ pins: [linePin()] });
    hoverLine();
    const start = screen.getByTestId("annot-resize-ln-1-start");
    fireEvent.pointerDown(start, { pointerId: 4, button: 0, clientX: 410, clientY: 320 });
    fireEvent.pointerMove(start, { pointerId: 4, clientX: 412, clientY: 321 });
    fireEvent.pointerUp(start, { pointerId: 4, clientX: 412, clientY: 321 });
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("a non-author line shows no endpoint handles even when hovered", () => {
    renderOverlay({ pins: [linePin({ id: "ln-peer", author: "999" })] });
    // Hovering a peer line does nothing (no handlers wired, inert stroke).
    fireEvent.pointerEnter(screen.getByTestId("annot-shape-ln-peer"));
    expect(screen.queryByTestId("annot-resize-ln-peer-start")).toBeNull();
    expect(screen.queryByTestId("annot-resize-ln-peer-end")).toBeNull();
    // The peer line's dot still renders (visible to everyone).
    expect(screen.getByTestId("annot-pin-ln-peer")).toBeTruthy();
  });

  it("a point renders no endpoint handles (regression — points are not adjustable)", () => {
    renderOverlay({ pins: [{ id: "pt-1", position: [10, 20], z: 3, author: String(MY_ID), kind: "point", comments: [] }] });
    // A point has no `annot-shape` to hover, and never any endpoint grips.
    expect(screen.queryByTestId("annot-shape-pt-1")).toBeNull();
    expect(screen.queryByTestId("annot-resize-pt-1-start")).toBeNull();
    expect(screen.queryByTestId("annot-resize-pt-1-end")).toBeNull();
  });

  it("the whole-line move (Shift+drag the dot) still emits a rigid move with no end", () => {
    const { sent } = renderOverlay({ pins: [linePin()] });
    const dot = screen.getByTestId("annot-pin-ln-1");
    fireEvent.pointerDown(dot, { pointerId: 5, button: 0, shiftKey: true, clientX: 410, clientY: 320 });
    fireEvent.pointerMove(dot, { pointerId: 5, shiftKey: true, clientX: 500, clientY: 400 });
    fireEvent.pointerUp(dot, { pointerId: 5, shiftKey: true, clientX: 500, clientY: 400 });
    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([100, 100]); // dot dropped at world (100,100)
    expect(moves[0].end).toBeUndefined(); // rigid translate carries no end
  });

  it("regression: a plain click on a HOVERED line's anchor dot opens its thread", () => {
    // A `start` grip drawn on the anchor vertex would stack over the dot and
    // swallow the click, so the grip is outset off the vertex.
    renderOverlay({
      pins: [linePin({ comments: [{ id: "c1", author: String(MY_ID), text: "on the line" }] })],
    });
    hoverLine();
    expect(screen.getByTestId("annot-resize-ln-1-start")).toBeTruthy();
    const dot = screen.getByTestId("annot-pin-ln-1");
    fireEvent.pointerDown(dot, { pointerId: 6, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(dot, { pointerId: 6, clientX: 200, clientY: 200 });
    fireEvent.click(dot, { clientX: 200, clientY: 200 });
    expect(screen.getByText("on the line")).toBeTruthy();
  });

  it("regression: a Shift+drag on a HOVERED line's anchor dot does a rigid move (no end), not a reshape", () => {
    // A grip over the dot would steal the Shift+drag and reshape one endpoint
    // instead of moving the whole line.
    const { sent } = renderOverlay({ pins: [linePin()] });
    hoverLine();
    expect(screen.getByTestId("annot-resize-ln-1-start")).toBeTruthy();
    const dot = screen.getByTestId("annot-pin-ln-1");
    fireEvent.pointerDown(dot, { pointerId: 7, button: 0, shiftKey: true, clientX: 410, clientY: 320 });
    fireEvent.pointerMove(dot, { pointerId: 7, shiftKey: true, clientX: 500, clientY: 400 });
    fireEvent.pointerUp(dot, { pointerId: 7, shiftKey: true, clientX: 500, clientY: 400 });
    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([100, 100]); // whole-line move to release
    expect(moves[0].end).toBeUndefined(); // RIGID move carries NO end (not a reshape)
  });
});

/**
 * Geometry guard for the grip outset. happy-dom dispatches a fired event to the
 * test-id'd element regardless of stacking, so the click tests above would pass
 * even with the grip drawn on the vertex. This reads the transform the RAF tick
 * writes and asserts the grip sits about HANDLE_OUTSET px off the vertex, along
 * the line axis, away from the other end.
 */
describe("AnnotationOverlay — the line start grip is OUTSET off the anchor dot (geometry)", () => {
  // Mirrors the component's unexported HANDLE_OUTSET; assertions use a tolerance.
  const HANDLE_OUTSET = 9;

  // Capture scheduled RAF callbacks so a test runs the live tick on demand
  // instead of racing the free-running loop.
  let scheduled: FrameRequestCallback[] = [];
  let originalRaf: typeof globalThis.requestAnimationFrame;
  beforeEach(() => {
    scheduled = [];
    originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      scheduled.push(cb);
      return scheduled.length as unknown as number;
    }) as typeof globalThis.requestAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
  });
  /** Run the most recently scheduled RAF tick (the live one). */
  function runFrame() {
    const cb = scheduled[scheduled.length - 1];
    if (cb) cb(performance.now());
  }

  /** Parse a `translate(<x>px, <y>px)` transform. Throws on anything else, so an
   * unpositioned grip can't pass as coinciding with the dot. */
  function translateOf(el: HTMLElement): [number, number] {
    const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(el.style.transform);
    if (!m) throw new Error(`expected a translate() transform, got: "${el.style.transform}"`);
    return [Number.parseFloat(m[1]), Number.parseFloat(m[2])];
  }

  it("draws the start grip ~HANDLE_OUTSET px off the anchor dot's vertex, along the line axis away from end", () => {
    // Start (10,20) projects to (410,320) and end (60,80) to (460,380).
    renderOverlay({ pins: [linePin()] });
    hoverLine();
    runFrame();

    const grip = translateOf(screen.getByTestId("annot-resize-ln-1-start"));
    // The wrapper transform is the projected vertex; the dot is centered in it.
    const dot = translateOf(screen.getByTestId("annot-pin-wrapper-ln-1"));

    // 1) The grip is not drawn on the anchor vertex.
    expect(grip).not.toEqual(dot);

    // 2) The displacement is about HANDLE_OUTSET in magnitude.
    const dx = grip[0] - dot[0];
    const dy = grip[1] - dot[1];
    const magnitude = Math.hypot(dx, dy);
    expect(Math.abs(magnitude - HANDLE_OUTSET)).toBeLessThan(0.5);
    // A floor too: a tiny offset would still overlap the 12px dot.
    expect(magnitude).toBeGreaterThan(HANDLE_OUTSET - 0.5);

    // 3) The offset points away from `end` along the line axis.
    const axX = 460 - 410;
    const axY = 380 - 320;
    const len = Math.hypot(axX, axY);
    const awayX = -axX / len;
    const awayY = -axY / len;
    const alongAway = dx * awayX + dy * awayY;
    expect(Math.abs(alongAway - HANDLE_OUTSET)).toBeLessThan(0.5);
  });

  it("the end grip is outset the OTHER way (+axis), so the two grips are not symmetric noise", () => {
    // The end grip is pushed along +axis, away from `start`.
    renderOverlay({ pins: [linePin()] });
    hoverLine();
    runFrame();

    const endGrip = translateOf(screen.getByTestId("annot-resize-ln-1-end"));
    // The far vertex projects to (460,380) under the harness camera.
    const endVertex: [number, number] = [460, 380];
    const dx = endGrip[0] - endVertex[0];
    const dy = endGrip[1] - endVertex[1];
    expect(Math.hypot(dx, dy)).toBeGreaterThan(HANDLE_OUTSET - 0.5);

    const axX = 460 - 410;
    const axY = 380 - 320;
    const len = Math.hypot(axX, axY);
    const towardX = axX / len; // +axis: away from `start`
    const towardY = axY / len;
    const alongToward = dx * towardX + dy * towardY;
    expect(Math.abs(alongToward - HANDLE_OUTSET)).toBeLessThan(0.5);
  });
});
