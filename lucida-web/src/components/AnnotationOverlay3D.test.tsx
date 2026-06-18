// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay3D } from "./AnnotationOverlay3D.tsx";
import type { Annotation } from "./AnnotationOverlay.tsx";

/**
 * Stand-in for the WASM scene exercising only the 3D overlay's surface:
 * `annotations()` (the authoritative read), `project_annotation()` (per-frame
 * marker projection — returns a fixed on-screen point so a marker is visible),
 * `pick_annotation_voxel()` (the depth pick a Shift+drag move resolves through),
 * and `apply_command()` (local apply). `pick` is configurable per test so we can
 * exercise both a hit and a ray miss.
 */
function makeScene(
  initial: Annotation[],
  pick: (x: number, y: number) => number[] = () => [50, 60, 7],
): { scene: WasmScene; applied: Array<Record<string, unknown>> } {
  let pins: Annotation[] = JSON.parse(JSON.stringify(initial));
  const applied: Array<Record<string, unknown>> = [];
  const scene = {
    annotations: (_datasetId: string) => JSON.stringify(pins),
    // Every vertex projects to a fixed, on-screen point so the marker renders
    // (the overlay hides a marker only on an empty projection).
    project_annotation: (_ds: string, _x: number, _y: number, _z: number) =>
      new Float64Array([100, 100]),
    pick_annotation_voxel: (_ds: string, x: number, y: number) =>
      new Float64Array(pick(x, y)),
    apply_command: (json: string) => {
      const cmd = JSON.parse(json) as Record<string, unknown>;
      applied.push(cmd);
      // Reflect the commands the overlay + shared thread emit so a re-read shows
      // the optimistic result (mirrors the real apply-locally seam).
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
  // happy-dom may not implement setPointerCapture on the element; stub it to
  // record the transfer the overlay performs for a plain (orbit) press.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (canvas as any).setPointerCapture = (id: number) => capturedPointers.push(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (canvas as any).releasePointerCapture = () => {};
  const forwardedDowns: PointerEvent[] = [];
  canvas.addEventListener("pointerdown", (e) => forwardedDowns.push(e as PointerEvent));
  return { canvas, capturedPointers, forwardedDowns };
}

// The annotation-author identity is now a stable string (issue #777), not the
// per-connection numeric client id. Authoring helpers use `String(MY_ID)`, so a
// string literal here flows through every `author`/ownership comparison
// unchanged while matching the overlay's `myId: string` prop type.
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
  /** The view's Z/T/C. Defaults to the on-context view for the standard test
   * pins (z=3, t/c absent → 0); the off-context suite overrides it. */
  viewContext?: { z: number; t: number; c: number };
}) {
  const { scene, applied } = makeScene(opts.pins, opts.pick);
  const sent: Array<Record<string, unknown>> = [];
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = scene;
  let changed = 0;
  let version = 0;
  let viewContext = opts.viewContext ?? { z: 3, t: 0, c: 0 };
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
  // Re-read the authoritative pin set by bumping the document version, exactly as
  // App.tsx does after onDocumentChanged — so a test can observe a just-added
  // comment surface in the open thread.
  const bumpVersion = () => {
    version += 1;
    rerender(overlay(version));
  };
  // Navigate the view: re-render with a new context (a pure input), so a test can
  // assert the off-context status flips as the view moves to / from the pin's
  // Z/T/C.
  const setViewContext = (next: { z: number; t: number; c: number }) => {
    viewContext = next;
    rerender(overlay(version));
  };
  return { applied, sent, getChanged: () => changed, capturedPointers, forwardedDowns, bumpVersion, setViewContext };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("AnnotationOverlay3D — Shift+drag moves; plain drag orbits (issue #778)", () => {
  it("a Shift+drag on an own marker emits one move_annotation from the depth pick", () => {
    // pick returns [50, 60, 7] → the move stores position [50,60], z 7.
    const { sent, applied, getChanged } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 320, clientY: 280 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: "move_annotation", dataset_id: "wds-1", id: "pin-a", z: 7 });
    expect(moves[0].position).toEqual([50, 60]);
    // Applied locally too (apply-locally-and-send), and the doc-changed bump fired.
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
    // Slice 11 reserves a plain press for a thread-opening click, so the orbit is
    // handed to the canvas the instant the press becomes a real drag (passes the
    // slop) — not on the bare pointerdown. The marker must still never move the
    // pin on a plain gesture; it forwards the gesture to the canvas (replaying the
    // pointerdown + transferring capture) so the camera orbits as usual.
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
    // A peer's marker is now clickable (to open its thread), so a plain drag on it
    // must still orbit — it forwards to the canvas exactly like an own marker, and
    // of course never moves the (non-own) pin.
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
    // Move stays author-only: a Shift+drag on a peer's pin is treated as an orbit
    // (Shift only gates a move on an OWN pin), so it never emits a move_annotation.
    const { sent } = renderOverlay({ pins: [ownPin({ id: "pin-b", author: "999" })] });
    const marker = screen.getByTestId("annot-pin-pin-b");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 320, clientY: 280 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });
});

describe("AnnotationOverlay3D — comment thread, brought to 3D (issue #771)", () => {
  /** Open a pin's thread with a pure click (down+up same point, then the
   * synthetic click), the same gesture the 2D suite uses so drag-suppression
   * never interferes. */
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
    // Regression guard: forwarding a plain drag to the canvas must release the
    // marker's gesture state, so a later independent click isn't blocked.
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

describe("AnnotationOverlay3D — off-context vs the view's Z/T/C (issue #779)", () => {
  it("a pin matching the view is on-context (no off-context marker)", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 1 })],
      viewContext: { z: 5, t: 2, c: 1 },
    });
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
  });

  it("a pin on a different t renders off-context with helptext naming its z/t/c", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 9, c: 1 })],
      viewContext: { z: 5, t: 0, c: 1 },
    });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    // Same exact contract form as 2D (the shared helper).
    expect(marker.textContent).toBe("slice 5 · t=9 · ch=1");
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
  });

  it("a pin on a different channel (c) renders off-context", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 7 })],
      viewContext: { z: 5, t: 2, c: 0 },
    });
    expect(screen.getByTestId("annot-offcontext-pin-here").textContent).toBe("slice 5 · t=2 · ch=7");
  });

  it("navigating the view to the pin's Z/T/C returns it to on-context", () => {
    const { setViewContext } = renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 12, t: 3, c: 2 })],
      viewContext: { z: 3, t: 0, c: 0 },
    });
    expect(screen.getByTestId("annot-offcontext-pin-here")).toBeTruthy();
    setViewContext({ z: 12, t: 3, c: 2 });
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
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
      viewContext: { z: 4, t: 0, c: 0 },
    });
    expect(screen.getByTestId("annot-offcontext-pin-here")).toBeTruthy();
    const marker = screen.getByTestId("annot-pin-pin-here");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });
    expect(screen.getByText("still works")).toBeTruthy();
  });
});
