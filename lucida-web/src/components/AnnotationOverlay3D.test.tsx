// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay3D } from "./AnnotationOverlay3D.tsx";
import type { Annotation } from "./annotationDocument.ts";

/**
 * Stand-in for the WASM scene covering only the 3D overlay's surface. `pick` is
 * configurable per test to exercise both a hit and a ray miss.
 */
function makeScene(
  initial: Annotation[],
  pick: (x: number, y: number) => number[] = () => [50, 60, 7],
): { scene: WasmScene; applied: Array<Record<string, unknown>> } {
  let pins: Annotation[] = JSON.parse(JSON.stringify(initial));
  const applied: Array<Record<string, unknown>> = [];
  const scene = {
    annotations: (_datasetId: string) => JSON.stringify(pins),
    // A fixed on-screen point so the marker renders.
    project_annotation: (_ds: string, _x: number, _y: number, _z: number) =>
      new Float64Array([100, 100]),
    pick_annotation_voxel: (_ds: string, x: number, y: number) =>
      new Float64Array(pick(x, y)),
    dataset_volume_shape: () => new Uint32Array([5, 100, 100]),
    export_presence: () => "not json",
    apply_command: (json: string) => {
      const cmd = JSON.parse(json) as Record<string, unknown>;
      applied.push(cmd);
      // Reflect emitted commands so a re-read shows the optimistic result.
      if (cmd.type === "move_annotation") {
        pins = pins.map((p) =>
          p.id === cmd.id
            ? { ...p, position: cmd.position as [number, number], z: cmd.z as number }
            : p,
        );
      } else if (cmd.type === "add_comment") {
        pins = pins.map((p) =>
          p.id === cmd.annotation_id
            ? {
                ...p,
                comments: [
                  ...(p.comments ?? []),
                  { id: cmd.id as string, author: cmd.author as string, text: cmd.text as string },
                ],
              }
            : p,
        );
      } else if (cmd.type === "edit_comment") {
        pins = pins.map((p) =>
          p.id === cmd.annotation_id
            ? {
                ...p,
                comments: (p.comments ?? []).map((c) =>
                  c.id === cmd.id ? { ...c, text: cmd.text as string } : c,
                ),
              }
            : p,
        );
      } else if (cmd.type === "remove_comment") {
        pins = pins.map((p) =>
          p.id === cmd.annotation_id
            ? { ...p, comments: (p.comments ?? []).filter((c) => c.id !== cmd.id) }
            : p,
        );
      } else if (cmd.type === "remove_annotation") {
        pins = pins.filter((p) => p.id !== cmd.id);
      }
    },
  } as unknown as WasmScene;
  return { scene, applied };
}

/** A canvas with a fixed layout box that records pointer-capture transfers and
 * any pointerdown events forwarded (dispatched) onto it. */
function makeCanvas() {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const capturedPointers: number[] = [];
  // happy-dom may lack setPointerCapture; stub it to record the orbit handoff.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (canvas as any).setPointerCapture = (id: number) => capturedPointers.push(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (canvas as any).releasePointerCapture = () => {};
  const forwardedDowns: PointerEvent[] = [];
  canvas.addEventListener("pointerdown", (e) => forwardedDowns.push(e as PointerEvent));
  return { canvas, capturedPointers, forwardedDowns };
}

const MY_ID = "7";

function ownPin(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "pin-a",
    position: [10, 20],
    z: 3,
    author: String(MY_ID),
    kind: "point",
    comments: [],
    ...overrides,
  };
}

function renderOverlay(opts: {
  pins: Annotation[];
  myId?: string;
  pick?: (x: number, y: number) => number[];
  /** The view's Z/T/C. Defaults to on-context for the standard pins (z=3). */
  viewContext?: { z: number; t: number; channels: number[] };
}) {
  const { scene, applied } = makeScene(opts.pins, opts.pick);
  const sent: Array<Record<string, unknown>> = [];
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = scene;
  let changed = 0;
  let version = 0;
  let viewContext = opts.viewContext ?? { z: 3, t: 0, channels: [0] };
  const { canvas, capturedPointers, forwardedDowns } = makeCanvas();
  const overlay = (v: number) => (
    <AnnotationOverlay3D
      datasetId="wds-1"
      wasmSceneRef={sceneRef}
      canvas={canvas}
      version={v}
      viewContext={viewContext}
      myId={opts.myId ?? MY_ID}
      sendCommand={(json) => sent.push(JSON.parse(json) as Record<string, unknown>)}
      onDocumentChanged={() => {
        changed += 1;
      }}
    />
  );
  const { rerender } = render(overlay(version));
  // Re-read the pin set as App.tsx does after onDocumentChanged.
  const bumpVersion = () => {
    version += 1;
    rerender(overlay(version));
  };
  const setViewContext = (next: { z: number; t: number; channels: number[] }) => {
    viewContext = next;
    rerender(overlay(version));
  };
  return { applied, sent, getChanged: () => changed, canvas, capturedPointers, forwardedDowns, bumpVersion, setViewContext };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("AnnotationOverlay3D — Shift+drag moves; plain drag orbits", () => {
  it("a Shift+drag on an own marker emits one move_annotation that moves in-plane but preserves the pin's slice (z)", () => {
    // pick returns [50, 60, 7]: the move takes [50,60] in-plane but keeps the
    // pin's own z (3). A 3D drag moves a pin within its slice, never re-slices.
    const { sent, applied, getChanged } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 320, clientY: 280 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    // z is the pin's own depth (3), not the ray-picked voxel depth (7).
    expect(moves[0]).toMatchObject({ type: "move_annotation", dataset_id: "wds-1", id: "pin-a", z: 3 });
    expect(moves[0].z).not.toBe(7);
    // The pin still moves: in-plane position comes from the picked voxel.
    expect(moves[0].position).toEqual([50, 60]);
    // A move carries no t/c (it leaves timepoint/channel untouched).
    expect(moves[0]).not.toHaveProperty("t");
    expect(moves[0]).not.toHaveProperty("c");
    // Applied locally too, and the doc-changed bump fired.
    expect(applied.some((c) => c.type === "move_annotation")).toBe(true);
    expect(getChanged()).toBe(1);
  });

  it("a Shift+drag that releases on a ray miss does NOT move (declines)", () => {
    // pick returns an empty vec → ray missed → the pin stays put, nothing emitted.
    const { sent, applied } = renderOverlay({ pins: [ownPin()], pick: () => [] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 320, clientY: 280 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("a stationary Shift-press (within slop) emits no move", () => {
    const { sent } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 202, clientY: 201 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 202, clientY: 201 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("a plain DRAG on an own marker is handed to the canvas (orbit) and never moves", () => {
    // A plain press is reserved for a thread-opening click, so the orbit is
    // handed to the canvas only once the press passes the slop: the marker
    // replays the pointerdown on the canvas and transfers capture.
    const { sent, applied, capturedPointers, forwardedDowns } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 9, button: 0, clientX: 200, clientY: 200 });
    // Travel past the 4px slop → it's a real drag, so it's handed to the canvas.
    fireEvent.pointerMove(marker, { pointerId: 9, clientX: 300, clientY: 260 });

    // No move (the pin is never moved by a plain gesture)…
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.some((c) => c.type === "move_annotation")).toBe(false);
    // …capture was transferred to the canvas so it owns the rest of the drag…
    expect(capturedPointers).toContain(9);
    // …and the pointerdown was replayed on the canvas (from the press point) so
    // it starts its orbit.
    expect(forwardedDowns.some((e) => e.pointerId === 9 && !e.shiftKey)).toBe(true);
  });

  it("a plain DRAG on a PEER's marker also orbits (forwarded to the canvas)", () => {
    // A peer's marker is clickable to open its thread, so a plain drag must
    // still forward to the canvas like an own marker.
    const { sent, capturedPointers, forwardedDowns } = renderOverlay({
      pins: [ownPin({ id: "pin-b", author: "999" })],
    });
    const marker = screen.getByTestId("annot-pin-pin-b");

    fireEvent.pointerDown(marker, { pointerId: 4, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 4, clientX: 280, clientY: 240 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(capturedPointers).toContain(4);
    expect(forwardedDowns.some((e) => e.pointerId === 4 && !e.shiftKey)).toBe(true);
  });

  it("a peer's marker can't be moved — even a Shift+drag emits no move", () => {
    // Move is author-only: Shift+drag on a peer's pin is an orbit.
    const { sent } = renderOverlay({ pins: [ownPin({ id: "pin-b", author: "999" })] });
    const marker = screen.getByTestId("annot-pin-pin-b");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 320, clientY: 280 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });
});

describe("AnnotationOverlay3D — comment thread, brought to 3D", () => {
  /** Open a pin's thread with a pure click (down and up at one point, then the
   * click) so drag suppression never interferes. */
  function openThread(pinId: string) {
    const marker = screen.getByTestId(`annot-pin-${pinId}`);
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });
  }

  it("clicking a 3D pin opens its thread popover (annot-thread-<id>)", () => {
    renderOverlay({ pins: [ownPin()] });
    // Closed to start — no popover.
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
    openThread("pin-a");
    expect(screen.getByTestId("annot-thread-pin-a")).toBeTruthy();
    // Clicking again closes it (toggle), like 2D.
    openThread("pin-a");
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
  });

  it("the open 3D thread shows the pin's existing comment text", () => {
    renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: "999", text: "from a peer" }] })],
    });
    openThread("pin-a");
    expect(screen.getByText("from a peer")).toBeTruthy();
  });

  it("adding a comment in the 3D thread emits one add_comment with the typed text", () => {
    const { sent, getChanged, bumpVersion } = renderOverlay({ pins: [ownPin()] });
    openThread("pin-a");

    const input = screen.getByTestId("comment-add-input-pin-a") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "looks great in 3D" } });
    fireEvent.click(screen.getByTestId("comment-add-send-pin-a"));

    const adds = sent.filter((c) => c.type === "add_comment");
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({
      type: "add_comment",
      dataset_id: "wds-1",
      annotation_id: "pin-a",
      author: String(MY_ID),
      text: "looks great in 3D",
    });
    // It carries a client-supplied id (so local apply + peer broadcast converge).
    expect(typeof adds[0].id).toBe("string");
    expect((adds[0].id as string).length).toBeGreaterThan(0);
    // The document-changed bump fired so dependent overlays re-read.
    expect(getChanged()).toBe(1);

    // And after the host re-reads (version bump), the new comment is visible —
    // read + add without leaving 3D.
    bumpVersion();
    expect(screen.getByText("looks great in 3D")).toBeTruthy();
  });

  it("Enter in the add box also emits one add_comment", () => {
    const { sent } = renderOverlay({ pins: [ownPin()] });
    openThread("pin-a");

    const input = screen.getByTestId("comment-add-input-pin-a");
    fireEvent.change(input, { target: { value: "via enter" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const adds = sent.filter((c) => c.type === "add_comment");
    expect(adds).toHaveLength(1);
    expect(adds[0].text).toBe("via enter");
  });

  it("an empty/whitespace comment emits nothing", () => {
    const { sent } = renderOverlay({ pins: [ownPin()] });
    openThread("pin-a");
    const input = screen.getByTestId("comment-add-input-pin-a");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sent.some((c) => c.type === "add_comment")).toBe(false);
  });

  it("the 3D thread matches 2D: an own pin's thread shows edit + delete controls", () => {
    renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "mine" }] })],
    });
    openThread("pin-a");
    // Author-only affordances are present in 3D exactly as in 2D.
    expect(screen.getByTestId("comment-edit-c1")).toBeTruthy();
    expect(screen.getByTestId("pin-delete-pin-a")).toBeTruthy();
  });

  it("editing an own comment in 3D emits one edit_comment with trimmed text", () => {
    const { sent } = renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "original" }] })],
    });
    openThread("pin-a");

    fireEvent.click(screen.getByTestId("comment-edit-c1"));
    const input = screen.getByTestId("comment-edit-input-c1") as HTMLInputElement;
    expect(input.value).toBe("original");
    fireEvent.change(input, { target: { value: "  edited in 3D  " } });
    fireEvent.click(screen.getByTestId("comment-edit-save-c1"));

    const edits = sent.filter((c) => c.type === "edit_comment");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      type: "edit_comment",
      dataset_id: "wds-1",
      annotation_id: "pin-a",
      id: "c1",
      text: "edited in 3D",
    });
  });

  it("deleting a pin in 3D is two-step: arm emits nothing, Confirm emits one remove_annotation", () => {
    const { sent, getChanged } = renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "one" }] })],
    });
    openThread("pin-a");

    // Arm the confirm — nothing emitted yet (deletion is deliberate).
    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));
    expect(screen.getByTestId("pin-delete-confirm-pin-a")).toBeTruthy();
    expect(sent.some((c) => c.type === "remove_annotation")).toBe(false);

    // Confirm emits exactly one remove_annotation for this pin.
    fireEvent.click(screen.getByTestId("pin-delete-confirm-pin-a"));
    const removes = sent.filter((c) => c.type === "remove_annotation");
    expect(removes).toHaveLength(1);
    expect(removes[0]).toEqual({ type: "remove_annotation", dataset_id: "wds-1", id: "pin-a" });
    expect(getChanged()).toBe(1);
  });

  it("a peer can open a peer's pin thread and add a comment (anyone may comment)", () => {
    const { sent } = renderOverlay({
      pins: [ownPin({ id: "pin-b", author: "999", comments: [{ id: "c1", author: "999", text: "peer note" }] })],
    });
    openThread("pin-b");

    // The thread opens and shows the peer's comment…
    expect(screen.getByTestId("annot-thread-pin-b")).toBeTruthy();
    expect(screen.getByText("peer note")).toBeTruthy();
    // …but no author-only controls for a pin/comment that isn't mine.
    expect(screen.queryByTestId("pin-delete-pin-b")).toBeNull();
    expect(screen.queryByTestId("comment-edit-c1")).toBeNull();

    // Anyone may add a comment, including on a peer's pin.
    const input = screen.getByTestId("comment-add-input-pin-b");
    fireEvent.change(input, { target: { value: "replying" } });
    fireEvent.click(screen.getByTestId("comment-add-send-pin-b"));
    const adds = sent.filter((c) => c.type === "add_comment");
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ annotation_id: "pin-b", author: String(MY_ID), text: "replying" });
  });

  it("a Shift+drag move does NOT toggle the thread (the trailing click is swallowed)", () => {
    // A real Shift+drag move on an own pin must not also pop the thread.
    renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 320, clientY: 280 });
    // The browser fires a click after the drag; it must be swallowed.
    fireEvent.click(marker, { clientX: 320, clientY: 280 });
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
  });

  it("a plain orbit drag does NOT open the thread (the trailing click is swallowed)", () => {
    renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");
    // A plain drag past the slop → orbit (forwarded to canvas); the browser fires
    // a trailing click which must be swallowed so the thread doesn't pop.
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300, clientY: 260 });
    fireEvent.click(marker, { clientX: 300, clientY: 260 });
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
  });

  it("a click after an orbit drag still opens the thread (no stuck gesture state)", () => {
    // Forwarding a plain drag must release the marker's gesture state, so a
    // later independent click isn't blocked.
    renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    // First gesture: a real orbit drag (forwarded). The browser may not deliver a
    // trailing click here (the pointer is released over the canvas, not the marker).
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300, clientY: 260 });
    // (no pointerup on the marker — the canvas owns it after the forward)

    // Second, independent gesture: a clean click must open the thread.
    fireEvent.pointerDown(marker, { pointerId: 2, button: 0, clientX: 320, clientY: 280 });
    fireEvent.pointerUp(marker, { pointerId: 2, clientX: 320, clientY: 280 });
    fireEvent.click(marker, { clientX: 320, clientY: 280 });
    expect(screen.getByTestId("annot-thread-pin-a")).toBeTruthy();
  });

  it("an open thread lifts its pin's wrapper above the others (z-order)", () => {
    const wrapperZ = (pinId: string) =>
      Number.parseInt((screen.getByTestId(`annot-pin-wrapper-${pinId}`) as HTMLElement).style.zIndex, 10);
    renderOverlay({
      pins: [ownPin({ id: "pin-a" }), ownPin({ id: "pin-b", position: [12, 22] })],
    });
    // Equal base before opening.
    expect(wrapperZ("pin-a")).toBe(wrapperZ("pin-b"));
    openThread("pin-a");
    // The open pin is lifted strictly above the closed one so its popover clears
    // the other marker, regardless of DOM order.
    expect(wrapperZ("pin-a")).toBeGreaterThan(wrapperZ("pin-b"));
  });
});

describe("AnnotationOverlay3D — off-context vs the view's Z/T/C", () => {
  it("a pin matching the view is on-context (no off-context marker)", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 1 })],
      viewContext: { z: 5, t: 2, channels: [1] },
    });
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
  });

  it("a pin on a different t renders off-context with helptext naming its z/t/c", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 9, c: 1 })],
      viewContext: { z: 5, t: 0, channels: [1] },
    });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    expect(marker.textContent).toBe("Z 6 · T 10 · Channel 2");
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
  });

  it("a pin on a different channel (c) renders off-context", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 7 })],
      viewContext: { z: 5, t: 2, channels: [0] },
    });
    expect(screen.getByTestId("annot-offcontext-pin-here").textContent).toBe("Z 6 · T 3 · Channel 8");
  });

  it("navigating the view to the pin's Z/T/C returns it to on-context", () => {
    const { setViewContext } = renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 12, t: 3, c: 2 })],
      viewContext: { z: 3, t: 0, channels: [0] },
    });
    expect(screen.getByTestId("annot-offcontext-pin-here")).toBeTruthy();
    setViewContext({ z: 12, t: 3, channels: [2] });
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
  });

  it("a 3D Shift+drag keeps an on-context pin on-context — it can't push the pin off its own slice", () => {
    // The pick returns depth 99, but the move keeps the pin's own z, so the
    // re-read pin stays on-context on the unchanged view.
    const { sent, bumpVersion } = renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 0, c: 0 })],
      viewContext: { z: 5, t: 0, channels: [0] },
      pick: () => [42, 24, 99],
    });
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();

    const marker = screen.getByTestId("annot-pin-pin-here");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 320, clientY: 280 });

    // The move went out (the pin moved in-plane) preserving the pin's slice…
    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].z).toBe(5);
    expect(moves[0].position).toEqual([42, 24]);

    // ...so after the re-read it is still on-context.
    bumpVersion();
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
  });

  it("regression: an off-context pin still opens its thread on click", () => {
    renderOverlay({
      pins: [
        ownPin({
          id: "pin-here",
          z: 12,
          t: 3,
          c: 2,
          comments: [{ id: "c1", author: String(MY_ID), text: "still works" }],
        }),
      ],
      viewContext: { z: 4, t: 0, channels: [0] },
    });
    expect(screen.getByTestId("annot-offcontext-pin-here")).toBeTruthy();
    const marker = screen.getByTestId("annot-pin-pin-here");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });
    expect(screen.getByText("still works")).toBeTruthy();
  });
});

describe("AnnotationOverlay3D — passive pin-select stays gentle; Go to author's view", () => {
  const VIEW = {
    v: 1,
    datasets: [],
    active_layouts: {},
    camera: {
      mode: "arcball",
      target: [1, 2, 3],
      theta: 0.5,
      phi: 1.0,
      distance: 100,
      fov: 45,
      viewport: [800, 600],
      near: 0.1,
      far: 1000,
    },
    view: { z_range: { start: 7, end: 8 }, t: 2, c: 1 },
    display: { contrast_min: 0, contrast_max: 1234, gamma: 2.2 },
    dataset_order: [],
    dataset_settings: {},
  } as const;

  function renderWithGoTo(pin: Annotation) {
    const { scene, applied } = makeScene([pin]);
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = scene;
    const goToCalls: string[] = [];
    const { canvas } = makeCanvas();
    render(
      <AnnotationOverlay3D
        datasetId="wds-1"
        wasmSceneRef={sceneRef}
        canvas={canvas}
        version={0}
        viewContext={{ z: 3, t: 0, channels: [0] }}
        myId={MY_ID}
        sendCommand={() => {}}
        onDocumentChanged={() => {}}
        onViewportChanged={() => {}}
        onGoToAuthorView={(id) => goToCalls.push(id)}
      />,
    );
    return { applied, goToCalls };
  }

  it("a plain click on a pin opens its thread but does NOT restore the author's view (gentle)", () => {
    const pin = ownPin({ id: "pin-v", view: JSON.parse(JSON.stringify(VIEW)) });
    const { applied } = renderWithGoTo(pin);

    fireEvent.pointerDown(screen.getByTestId("annot-pin-pin-v"), { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(screen.getByTestId("annot-pin-pin-v"), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByTestId("annot-pin-pin-v"));
    expect(screen.getByTestId("annot-thread-pin-v")).toBeTruthy();

    const types = applied.map((c) => c.type);
    expect(types).not.toContain("set_contrast");
    expect(types).not.toContain("set_z_range");
    expect(types).not.toContain("set_mode_arcball");
    expect(types).not.toContain("arcball_center_on_voxel"); // no recenter on passive select
  });

  it("exposes 'Go to author's view' in the 3D thread and fires it on click", () => {
    const pin = ownPin({ id: "pin-v", view: JSON.parse(JSON.stringify(VIEW)) });
    const { goToCalls } = renderWithGoTo(pin);

    fireEvent.pointerDown(screen.getByTestId("annot-pin-pin-v"), { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(screen.getByTestId("annot-pin-pin-v"), { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByTestId("annot-pin-pin-v"));
    fireEvent.click(screen.getByTestId("pin-goto-author-view-pin-v"));
    expect(goToCalls).toEqual(["pin-v"]);
  });
});

describe("AnnotationOverlay3D — comment-count badge on the marker", () => {
  it("a pin with comments carries the count badge, and its marker's name says the count", () => {
    renderOverlay({
      pins: [
        ownPin({
          comments: [
            { id: "c1", author: String(MY_ID), text: "first" },
            { id: "c2", author: "peer", text: "second" },
          ],
        }),
      ],
    });
    const marker = screen.getByTestId("annot-pin-pin-a");
    expect(marker.tagName).toBe("BUTTON");
    expect(marker.getAttribute("aria-label")).toBe("Pin by you, 2 comments");
    expect(document.querySelector(".lc-annotation-count")?.textContent).toBe("2");
  });

  it("a pin with an empty thread carries no badge", () => {
    renderOverlay({ pins: [ownPin({ comments: [] })] });
    expect(document.querySelector(".lc-annotation-count")).toBeNull();
  });

  it("clicking the badge opens the pin's thread (same toggle as the dot)", () => {
    renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi from 3d" }] })],
    });
    fireEvent.click(document.querySelector(".lc-annotation-count")!);
    expect(screen.getByTestId("annot-thread-pin-a")).toBeTruthy();
    expect(screen.getByText("hi from 3d")).toBeTruthy();
  });
});

describe("AnnotationOverlay3D — select to edit and the canvas menu", () => {
  it("a click selects one's own pin, after which a plain drag moves it instead of orbiting", () => {
    const { sent, forwardedDowns } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.click(marker);
    expect(marker.getAttribute("data-selected")).toBe("true");

    fireEvent.pointerDown(marker, { pointerId: 2, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(marker, { pointerId: 2, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(marker, { pointerId: 2, clientX: 160, clientY: 140 });
    expect(sent.filter((c) => c.type === "move_annotation")).toHaveLength(1);
    expect(forwardedDowns).toHaveLength(0);
  });

  it("hands a finger's drag to the canvas as a touch, for its gesture recognizer", () => {
    const { forwardedDowns } = renderOverlay({ pins: [ownPin({ author: "999" })] });
    const marker = screen.getByTestId("annot-pin-pin-a");
    fireEvent.pointerDown(marker, { pointerId: 6, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(marker, { pointerId: 6, pointerType: "touch", clientX: 130, clientY: 100 });
    expect(forwardedDowns.map((e) => e.pointerType)).toEqual(["touch"]);
  });

  it("a right-click drops a point where the volume is picked, clamped to its depth", async () => {
    const { sent, canvas } = renderOverlay({ pins: [], pick: () => [50, 60, 4.9] });
    act(() => {
      fireEvent.contextMenu(canvas, { clientX: 300, clientY: 200 });
    });
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "Comment here",
      "Drop a point",
      "Copy coordinates",
    ]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Drop a point" }));
    const adds = sent.filter((c) => c.type === "add_annotation");
    expect(adds).toHaveLength(1);
    // The volume is 5 planes deep, so a far-face pick lands on the last one.
    expect(adds[0]).toMatchObject({ kind: "point", position: [50, 60], z: 4 });
  });

  it("offers no point where the press misses the volume", () => {
    const { canvas } = renderOverlay({ pins: [], pick: () => [] });
    act(() => {
      fireEvent.contextMenu(canvas, { clientX: 300, clientY: 200 });
    });
    expect(screen.getByRole("menuitem", { name: "Drop a point" }).getAttribute("aria-disabled")).toBe("true");
  });
});
