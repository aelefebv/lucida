// @vitest-environment happy-dom

/**
 * Slice 18 (issue #790): a line can be adjusted by dragging EITHER endpoint —
 * only the grabbed end moves, the other stays anchored. These tests exercise the
 * line analog of the box's hover-revealed resize handles (slice 17): the two
 * endpoint grips (`annot-resize-<id>-start` / `-end`) are NOT always-on; hovering
 * the line's `<line>` shape reveals them; dragging one emits exactly one reshape
 * `move_annotation` that moves only that vertex.
 *
 * The scene/canvas stand-ins mirror the ones in AnnotationOverlay.test.tsx so the
 * world<->screen math is identical: zoom=1, center=(0,0), 800x600, dpr=1, so
 * world = (clientX − 400, clientY − 300). A release at client (cx,cy) lands at
 * world (cx−400, cy−300), which the expected reshapes below are computed from.
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
    zoom: () => 1,
    center: () => new Float64Array([0, 0]),
    apply_command: (json: string) => {
      const cmd = JSON.parse(json) as Record<string, unknown>;
      applied.push(cmd);
      // Reflect a reshape so a re-read sees both moved vertices (mirrors the real
      // apply-locally seam): a line endpoint drag carries both `position` and
      // `end`.
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
      canvas={canvas}
      version={0}
      viewContext={{ z: 3, t: 0, c: 0 }}
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

/** Reveal an own line's endpoint handles by hovering its segment — the line
 * analog of hovering a box's outline (handles are not always-on). */
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
    // The segment itself renders for everyone, but neither endpoint grip exists
    // until the line is hovered.
    expect(screen.getByTestId("annot-shape-ln-1")).toBeTruthy();
    expect(screen.queryByTestId("annot-resize-ln-1-start")).toBeNull();
    expect(screen.queryByTestId("annot-resize-ln-1-end")).toBeNull();
  });

  it("hovering an own line reveals both endpoint handles (start + end)", () => {
    renderOverlay({ pins: [linePin()] });
    hoverLine();
    expect(screen.getByTestId("annot-resize-ln-1-start")).toBeTruthy();
    expect(screen.getByTestId("annot-resize-ln-1-end")).toBeTruthy();
    // A line has exactly two grips — never the box's eight.
    for (const h of ["nw", "ne", "se", "sw", "n", "e", "s", "w"]) {
      expect(screen.queryByTestId(`annot-resize-ln-1-${h}`)).toBeNull();
    }
  });

  it("dragging START moves only position; end is unchanged", () => {
    const { sent, getChanged } = renderOverlay({ pins: [linePin()] });
    hoverLine();
    const start = screen.getByTestId("annot-resize-ln-1-start");

    // Press on START, travel past the 4px slop, release at client (300,250) →
    // world (-100,-50). Only the anchor (position) moves; the far end is held.
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

    // Press on END, travel past the slop, release at client (500,400) →
    // world (100,100). Only the far end moves; the anchor (position) is held.
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
    // Press + release within the 4px slop — a no-op (no reshape).
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
    // Regression: the body move (slice 10) is untouched by the endpoint work — a
    // Shift+drag on the dot emits a move_annotation carrying position+z but NO
    // `end` (a rigid translate, not a reshape).
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

  it("regression (#790): a plain click on a HOVERED line's anchor dot opens its thread", () => {
    // The bug: the `start` grip sat directly ON the `position` vertex — the same
    // point as the anchor dot — so while the line was hovered (grips visible) the
    // grip stacked over the dot and SWALLOWED a plain click, so the thread never
    // opened. The fix outsets the grip off the vertex so the dot stays the click
    // target. Mirrors the box's analogous dot-click regression.
    renderOverlay({
      pins: [linePin({ comments: [{ id: "c1", author: String(MY_ID), text: "on the line" }] })],
    });
    // Reveal the endpoint grips by hovering the line (so the `start` grip is in
    // the DOM, the exact condition the bug needs)…
    hoverLine();
    expect(screen.getByTestId("annot-resize-ln-1-start")).toBeTruthy();
    // …and a plain click on the anchor dot still opens the thread.
    const dot = screen.getByTestId("annot-pin-ln-1");
    fireEvent.pointerDown(dot, { pointerId: 6, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(dot, { pointerId: 6, clientX: 200, clientY: 200 });
    fireEvent.click(dot, { clientX: 200, clientY: 200 });
    expect(screen.getByText("on the line")).toBeTruthy();
  });

  it("regression (#790): a Shift+drag on a HOVERED line's anchor dot does a rigid move (no end), not a reshape", () => {
    // The other half of the bug: while hovered, the `start` grip over the anchor
    // dot stole the Shift+drag and started a single-endpoint RESHAPE (which emits
    // an `end`) instead of the rigid whole-line move (which emits NO `end`). After
    // the outset the dot owns the Shift+drag again, so the move carries position+z
    // and no `end`. Mirrors the box's "Shift+drag the dot still moves the WHOLE
    // box" regression.
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
 * GEOMETRY-level guard for the #790 fix (the load-bearing one).
 *
 * The event-on-dot regression tests above prove the BEHAVIOR (the dot still owns
 * the click / Shift+drag while the grips are revealed), but happy-dom dispatches
 * a fired pointer event straight to the element addressed by test-id regardless
 * of stacking or geometry — so those tests would still PASS even if the outset
 * were deleted and the `start` grip were drawn exactly on the anchor vertex. They
 * don't actually pin down WHERE the grip is painted.
 *
 * This suite closes that gap by reading the rendered position the RAF tick writes:
 * it asserts the `start` grip's CSS `transform` is pushed OFF the anchor dot's
 * vertex by ~HANDLE_OUTSET (9px), along the line's own axis, AWAY from the far
 * endpoint. If the outset is removed (grip drawn on the vertex), the grip and the
 * dot coincide and these assertions fail — which is exactly the property that
 * keeps the dot's click/Shift+drag from being swallowed.
 *
 * The handle positions are set inside a self-rescheduling `requestAnimationFrame`
 * loop, so — exactly like the box/dot handle-position tests in
 * AnnotationOverlay.test.tsx — we install a CAPTURING RAF stub before render to
 * hold each scheduled callback and drive the latest on demand via runFrame(),
 * then read `el.style.transform`.
 */
describe("AnnotationOverlay — the line start grip is OUTSET off the anchor dot (geometry, #790)", () => {
  // HANDLE_OUTSET in the component (CSS px each grip is nudged outward along the
  // line axis). Not exported, so mirrored here; the assertions allow a tolerance
  // so they pin the fix's intent (a ~9px lift) without coupling to the exact px.
  const HANDLE_OUTSET = 9;

  // Capture every scheduled RAF callback so we can run the live tick on demand
  // (the overlay reschedules at the end of each tick, so the latest is current),
  // instead of racing the free-running loop. Restored after each test. Mirrors
  // the re-anchoring suite's harness in AnnotationOverlay.test.tsx.
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

  /** Parse a `translate(<x>px, <y>px)` transform into its [x, y] CSS-px point.
   * Throws (failing the test) on anything that isn't a populated translate, so a
   * grip the tick never positioned can't masquerade as coinciding with the dot. */
  function translateOf(el: HTMLElement): [number, number] {
    const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(el.style.transform);
    if (!m) throw new Error(`expected a translate() transform, got: "${el.style.transform}"`);
    return [Number.parseFloat(m[1]), Number.parseFloat(m[2])];
  }

  it("draws the start grip ~HANDLE_OUTSET px off the anchor dot's vertex, along the line axis away from end", () => {
    // The standard own line: position (anchor/start) = (10,20), end = (60,80).
    // With the harness camera (zoom=1, center=(0,0), 800x600, dpr=1) world ->
    // screen is +(400,300), so the start vertex projects to (410,320) and end to
    // (460,380). The anchor dot rides the start vertex exactly; the start GRIP is
    // the same vertex nudged HANDLE_OUTSET px along −(start→end), i.e. away from
    // the far endpoint — so the dot stays the click/Shift+drag target (#790).
    renderOverlay({ pins: [linePin()] });
    // Reveal the endpoint grips by hovering the line (so the `start` grip is in
    // the DOM at all), then drive the tick that positions every marker.
    hoverLine();
    runFrame();

    const grip = translateOf(screen.getByTestId("annot-resize-ln-1-start"));
    // The anchor dot's position is the wrapper transform the tick writes (the dot
    // itself is centered inside the wrapper via a static margin offset, so the
    // wrapper transform IS the projected vertex).
    const dot = translateOf(screen.getByTestId("annot-pin-wrapper-ln-1"));

    // 1) The grip is NOT drawn on the anchor vertex — the crux of the fix. Were
    //    the outset removed, the grip would sit exactly on the dot and this fails.
    expect(grip).not.toEqual(dot);

    // 2) The displacement from the dot to the grip is ~HANDLE_OUTSET in MAGNITUDE
    //    (a small tolerance, so this asserts the fix's intent, not an exact px).
    const dx = grip[0] - dot[0];
    const dy = grip[1] - dot[1];
    const magnitude = Math.hypot(dx, dy);
    expect(Math.abs(magnitude - HANDLE_OUTSET)).toBeLessThan(0.5);
    // A bare floor too, so a future "tiny but nonzero" offset (which would still
    // let the grip overlap the 12px dot and re-break the click) can't pass.
    expect(magnitude).toBeGreaterThan(HANDLE_OUTSET - 0.5);

    // 3) The offset points DOWN the line's −axis (away from `end`): projecting the
    //    displacement onto the unit away-from-end direction recovers ~+HANDLE_OUTSET
    //    (a generic offset of the right magnitude in the WRONG direction would not).
    //    Screen axis start->end = (460-410, 380-320) = (50,60); away-from-end is
    //    its negation, normalized.
    const axX = 460 - 410;
    const axY = 380 - 320;
    const len = Math.hypot(axX, axY);
    const awayX = -axX / len;
    const awayY = -axY / len;
    const alongAway = dx * awayX + dy * awayY;
    expect(Math.abs(alongAway - HANDLE_OUTSET)).toBeLessThan(0.5);
  });

  it("the end grip is outset the OTHER way (+axis), so the two grips are not symmetric noise", () => {
    // A companion read that the outset is a real, directional lift on BOTH grips:
    // `end` rides the far vertex (460,380) pushed +axis (toward-away-from-start),
    // so its displacement from the end vertex projects onto +(start->end) as
    // ~+HANDLE_OUTSET. Together with the start assertion this rules out a
    // both-grips-on-the-vertex degenerate (which the behavior tests can't see).
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
