// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay, type Annotation } from "./AnnotationOverlay.tsx";

/**
 * A hand-rolled stand-in for the WASM scene, exercising only the surface this
 * overlay touches: `annotations()` (the authoritative read), `apply_command()`
 * (local apply), and the camera accessors `zoom()` / `center()` used by the
 * world<->screen projection. Pin state is mutated by apply_command so a re-read
 * reflects an optimistic move/edit, mirroring the real apply-locally seam.
 */
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
      // Reflect the two commands this slice emits so a re-read shows the result.
      if (cmd.type === "move_annotation") {
        pins = pins.map((p) =>
          p.id === cmd.id
            ? { ...p, position: cmd.position as [number, number], z: cmd.z as number }
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
      } else if (cmd.type === "remove_annotation") {
        pins = pins.filter((p) => p.id !== cmd.id);
      }
    },
  } as unknown as WasmScene;
  return { scene, applied };
}

/** A canvas whose layout box is a fixed 800x600 at the origin, so world<->screen
 * math is deterministic regardless of happy-dom's zero-size default. */
function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return canvas;
}

const MY_ID = 7;

function renderOverlay(opts: {
  pins: Annotation[];
  myId?: number;
}) {
  const { scene, applied } = makeScene(opts.pins);
  const sent: Array<Record<string, unknown>> = [];
  const sceneRef = createRef<WasmScene | null>();
  // Prime the ref before render (RefObject.current is writable in tests).
  sceneRef.current = scene;
  let changed = 0;
  let viewportChanged = 0;
  const canvas = makeCanvas();
  render(
    <AnnotationOverlay
      datasetId="wds-1"
      wasmSceneRef={sceneRef}
      canvas={canvas}
      version={0}
      myId={opts.myId ?? MY_ID}
      sendCommand={(json) => sent.push(JSON.parse(json) as Record<string, unknown>)}
      onDocumentChanged={() => {
        changed += 1;
      }}
      onViewportChanged={() => {
        viewportChanged += 1;
      }}
    />,
  );
  return {
    applied,
    sent,
    getChanged: () => changed,
    getViewportChanged: () => viewportChanged,
  };
}

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

beforeEach(() => {
  // Stabilize DPR for the projection math.
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("AnnotationOverlay — move a pin (move_annotation)", () => {
  it("Shift+dragging an own pin past the slop emits one move_annotation in world space", () => {
    // Moving now requires Shift+click+drag (issue #778): a plain drag pans, so
    // the move gesture must carry the Shift modifier from the pointerdown on.
    const { sent, getChanged } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    // Shift-press, travel well past PIN_CLICK_SLOP (4px), release. With zoom=1,
    // center=(0,0), 800x600 canvas: world = screenPx - half. Release at
    // client (500, 400) → world (500-400, 400-300) = (100, 100).
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 260, clientY: 260 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 500, clientY: 400 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      type: "move_annotation",
      dataset_id: "wds-1",
      id: "pin-a",
      z: 3,
    });
    expect(moves[0].position).toEqual([100, 100]);
    expect(getChanged()).toBe(1);
  });

  it("a Shift-press without travel is not a move (no move_annotation)", () => {
    const { sent } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    // A Shift press whose travel stays within the 4px slop never becomes a drag,
    // so it emits no move.
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 202, clientY: 201 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 202, clientY: 201 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("a click (no drag) still toggles the thread open", () => {
    renderOverlay({ pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    // A pure click: down + up at the same point, then the synthetic click.
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });

    // Thread popover opened → the existing comment is visible.
    expect(screen.getByText("hi")).toBeTruthy();
  });

  it("a real drag (a pan) does NOT toggle the thread (the trailing click is swallowed)", () => {
    renderOverlay({ pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    // A plain drag pans the view; like any real drag it must swallow the trailing
    // click the browser fires so the drop doesn't also pop the thread.
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 400, clientY: 400 });
    // The browser still fires a click after a drag; the overlay must swallow it.
    fireEvent.click(marker, { clientX: 400, clientY: 400 });

    // Thread did NOT open: the comment text is not shown.
    expect(screen.queryByText("hi")).toBeNull();
  });

  it("a drag with no trailing click does not poison the next click (thread still opens)", () => {
    renderOverlay({ pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    // First gesture: a real (pan) drag, but the browser never delivers the
    // trailing click (e.g. pointer released off-element). The suppression flag is
    // left set.
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 400, clientY: 400 });
    // (no click here)

    // Second, independent gesture: a clean click should open the thread, not be
    // swallowed by the stale flag — the next pointerdown clears it.
    fireEvent.pointerDown(marker, { pointerId: 2, button: 0, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(marker, { pointerId: 2, clientX: 400, clientY: 400 });
    fireEvent.click(marker, { clientX: 400, clientY: 400 });

    expect(screen.getByText("hi")).toBeTruthy();
  });

  it("a non-author pin carries the dot testid but a Shift+drag emits no move", () => {
    const { sent } = renderOverlay({
      pins: [ownPin({ id: "pin-b", author: "999" })],
    });
    // Slice 7 widened the dot testid to EVERY pin so any pin's thread can be
    // opened — a peer's pin now carries `annot-pin-<id>` too.
    expect(screen.getByTestId("annot-pin-pin-b")).toBeTruthy();

    // The move gesture stays author-only: even a Shift+drag on a peer's pin
    // emits nothing (the dot has no pointer handlers wired for a non-author).
    const marker = screen.getByTestId("annot-pin-pin-b");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 400, clientY: 400 });
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("shift-click (no travel) neither moves nor removes a pin", () => {
    const { sent, getChanged } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");
    // The old one-shot shift-click-to-remove is gone. A stationary Shift-press is
    // the start of a (would-be) move gesture, so it emits neither a move nor a
    // remove — and, per #778, it doesn't toggle the thread either (Shift is the
    // move modifier; the trailing click is swallowed — asserted separately).
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { shiftKey: true, clientX: 200, clientY: 200 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(sent.some((c) => c.type === "remove_annotation")).toBe(false);
    expect(getChanged()).toBe(0);
  });
});

describe("AnnotationOverlay — Shift gates move; plain drag pans (issue #778)", () => {
  it("a plain drag on an own pin pans the view and emits NO move", () => {
    // The headline of the slice: a plain (non-Shift) drag that starts on an own
    // marker must pan the view exactly like dragging the canvas — never move the
    // pin. Pan = apply-locally-only viewport command, so it lands in `applied`
    // (apply_command) but never in `sent` (it isn't broadcast).
    const { applied, sent } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 240, clientY: 220 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300, clientY: 260 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 300, clientY: 260 });

    // No move was emitted (locally applied or sent).
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.some((c) => c.type === "move_annotation")).toBe(false);
    // At least one viewport pan was applied to the scene…
    const pans = applied.filter((c) => c.type === "pan");
    expect(pans.length).toBeGreaterThanOrEqual(1);
    // …and a pan is viewport state, never broadcast.
    expect(sent.some((c) => c.type === "pan")).toBe(false);
  });

  it("the pan forwarded is dpr-aware and negated (the SliceViewer pan)", () => {
    // dpr=2 (set here), incremental travel of +30 CSS px in x and +10 in y from
    // the press. The pan command must be the negated, dpr-scaled delta:
    // dx = -(30*2) = -60, dy = -(10*2) = -20 — exactly what SliceViewer applies.
    Object.defineProperty(globalThis, "devicePixelRatio", { value: 2, configurable: true });
    const { applied } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    // One move past the slop: +30 in x, +10 in y.
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 130, clientY: 110 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 130, clientY: 110 });

    const pans = applied.filter((c) => c.type === "pan");
    expect(pans).toHaveLength(1);
    expect(pans[0]).toMatchObject({ type: "pan", dx: -60, dy: -20 });
  });

  it("a plain drag consumes incremental deltas across multiple moves", () => {
    // Two moves of +20 CSS px each in x (dpr=1) → two pans of dx=-20 each, not a
    // single cumulative -40: the gesture must pan by travel-since-last-event.
    const { applied } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 120, clientY: 100 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 140, clientY: 100 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 140, clientY: 100 });

    const pans = applied.filter((c) => c.type === "pan");
    expect(pans).toHaveLength(2);
    expect(pans[0].dx).toBe(-20);
    expect(pans[1].dx).toBe(-20);
    // No vertical travel → zero vertical pan on both.
    expect(Math.abs(pans[0].dy as number)).toBe(0);
    expect(Math.abs(pans[1].dy as number)).toBe(0);
  });

  it("a plain drag asks the parent to repaint (marks the render loop dirty)", () => {
    // A pan that didn't repaint would slide the pins over a frozen image. The
    // overlay must notify the parent (which marks the render loop dirty) on pan.
    const { getViewportChanged } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 160, clientY: 140 });

    expect(getViewportChanged()).toBeGreaterThanOrEqual(1);
  });

  it("a Shift+drag moves the pin and applies NO pan (move, not pan)", () => {
    // The complement: with Shift held, the same travel must move the pin (one
    // move_annotation) and never pan the view.
    const { applied, sent } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 500, clientY: 400 });

    expect(sent.filter((c) => c.type === "move_annotation")).toHaveLength(1);
    expect(applied.some((c) => c.type === "pan")).toBe(false);
  });

  it("a plain click (no travel) toggles the thread and applies no pan, no move", () => {
    // The third leg: a stationary plain press is a click — it toggles the thread
    // and must emit/apply neither a pan nor a move.
    const { applied, sent } = renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })],
    });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });

    // Thread opened.
    expect(screen.getByTestId("annot-thread-pin-a")).toBeTruthy();
    expect(applied.some((c) => c.type === "pan")).toBe(false);
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("a stationary Shift-press does nothing (no move, no pan, no thread toggle)", () => {
    // Per #778: a Shift-press that never crosses the slop is inert — it neither
    // moves (it didn't drag) nor toggles the thread (Shift is the move modifier,
    // so its trailing click is swallowed).
    const { applied, sent } = renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })],
    });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { shiftKey: true, clientX: 200, clientY: 200 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.some((c) => c.type === "pan")).toBe(false);
    // The thread did NOT open — the Shift-press's trailing click was swallowed.
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
  });
});

describe("AnnotationOverlay — edit a comment (edit_comment)", () => {
  function openThreadWithComment(text = "original", author = String(MY_ID)) {
    const result = renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author, text }] })],
    });
    const marker = screen.getByTestId("annot-pin-pin-a");
    // Open the thread (pure click).
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });
    return result;
  }

  it("editing an own comment emits one edit_comment with trimmed text and the right ids", () => {
    const { sent, getChanged } = openThreadWithComment("original");

    fireEvent.click(screen.getByTestId("comment-edit-c1"));
    const input = screen.getByTestId("comment-edit-input-c1") as HTMLInputElement;
    // Seeded with the current text.
    expect(input.value).toBe("original");

    fireEvent.change(input, { target: { value: "  updated text  " } });
    // A plain click on the save control commits (mirrors the harness).
    fireEvent.click(screen.getByTestId("comment-edit-save-c1"));

    const edits = sent.filter((c) => c.type === "edit_comment");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      type: "edit_comment",
      dataset_id: "wds-1",
      annotation_id: "pin-a",
      id: "c1",
      text: "updated text",
    });
    expect(getChanged()).toBe(1);
  });

  it("Enter saves the edit", () => {
    const { sent } = openThreadWithComment("original");
    fireEvent.click(screen.getByTestId("comment-edit-c1"));
    const input = screen.getByTestId("comment-edit-input-c1");
    fireEvent.change(input, { target: { value: "via enter" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const edits = sent.filter((c) => c.type === "edit_comment");
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe("via enter");
  });

  it("Escape cancels the edit without emitting", () => {
    const { sent } = openThreadWithComment("original");
    fireEvent.click(screen.getByTestId("comment-edit-c1"));
    const input = screen.getByTestId("comment-edit-input-c1");
    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(sent.some((c) => c.type === "edit_comment")).toBe(false);
    // Field is gone; the original text is shown again.
    expect(screen.queryByTestId("comment-edit-input-c1")).toBeNull();
    expect(screen.getByText("original")).toBeTruthy();
  });

  it("blurring the edit field (focus leaving the row) cancels without emitting", () => {
    const { sent } = openThreadWithComment("original");
    fireEvent.click(screen.getByTestId("comment-edit-c1"));
    const input = screen.getByTestId("comment-edit-input-c1");
    fireEvent.change(input, { target: { value: "abandoned" } });
    // Blur to nowhere (relatedTarget null) → cancels.
    fireEvent.blur(input);

    expect(sent.some((c) => c.type === "edit_comment")).toBe(false);
    expect(screen.queryByTestId("comment-edit-input-c1")).toBeNull();
    expect(screen.getByText("original")).toBeTruthy();
  });

  it("blur toward the save control does NOT cancel — the save still commits", () => {
    const { sent } = openThreadWithComment("original");
    fireEvent.click(screen.getByTestId("comment-edit-c1"));
    const input = screen.getByTestId("comment-edit-input-c1");
    const saveBtn = screen.getByTestId("comment-edit-save-c1");
    fireEvent.change(input, { target: { value: "kept" } });
    // Simulate focus moving from the input to the save button (relatedTarget),
    // as a real click sequence would, then the click commits.
    fireEvent.blur(input, { relatedTarget: saveBtn });
    fireEvent.click(saveBtn);

    const edits = sent.filter((c) => c.type === "edit_comment");
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toBe("kept");
  });

  it("an empty/whitespace edit emits nothing", () => {
    const { sent } = openThreadWithComment("original");
    fireEvent.click(screen.getByTestId("comment-edit-c1"));
    const input = screen.getByTestId("comment-edit-input-c1");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sent.some((c) => c.type === "edit_comment")).toBe(false);
  });

  it("a non-author comment shows no edit affordance", () => {
    openThreadWithComment("from a peer", "999");
    expect(screen.getByText("from a peer")).toBeTruthy();
    expect(screen.queryByTestId("comment-edit-c1")).toBeNull();
  });
});

describe("AnnotationOverlay — delete a pin (remove_annotation, confirmed)", () => {
  /** Render with one pin and open its thread via a pure click, returning the
   * harness handles. Mirrors the edit suite's opener. */
  function openOwnThread(overrides: Partial<Annotation> = {}) {
    const result = renderOverlay({ pins: [ownPin(overrides)] });
    const marker = screen.getByTestId("annot-pin-pin-a");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });
    return result;
  }

  it("an open own-pin thread shows a Delete trigger", () => {
    openOwnThread();
    expect(screen.getByTestId("pin-delete-pin-a")).toBeTruthy();
    // Before arming, neither confirm control is present.
    expect(screen.queryByTestId("pin-delete-confirm-pin-a")).toBeNull();
    expect(screen.queryByTestId("pin-delete-cancel-pin-a")).toBeNull();
  });

  it("activating Delete reveals a confirm but emits nothing (no one-shot delete)", () => {
    const { sent, getChanged } = openOwnThread({
      comments: [
        { id: "c1", author: String(MY_ID), text: "one" },
        { id: "c2", author: "999", text: "two" },
        { id: "c3", author: String(MY_ID), text: "three" },
      ],
    });

    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));

    // The confirm appears…
    expect(screen.getByTestId("pin-delete-confirm-pin-a")).toBeTruthy();
    expect(screen.getByTestId("pin-delete-cancel-pin-a")).toBeTruthy();
    // …but arming the confirm has emitted nothing — deletion is deliberate.
    expect(sent.some((c) => c.type === "remove_annotation")).toBe(false);
    expect(getChanged()).toBe(0);
  });

  it("the confirm control's accessible text includes the pin's comment count", () => {
    openOwnThread({
      comments: [
        { id: "c1", author: String(MY_ID), text: "one" },
        { id: "c2", author: "999", text: "two" },
        { id: "c3", author: String(MY_ID), text: "three" },
      ],
    });
    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));

    const confirm = screen.getByTestId("pin-delete-confirm-pin-a");
    // The integer pin.comments.length (3) must be visible to the user, via the
    // control's text content or its aria-label.
    const accessible = `${confirm.textContent ?? ""} ${confirm.getAttribute("aria-label") ?? ""}`;
    expect(accessible).toContain("3");
  });

  it("the confirm count reflects a single comment too", () => {
    openOwnThread({ comments: [{ id: "c1", author: String(MY_ID), text: "solo" }] });
    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));

    const confirm = screen.getByTestId("pin-delete-confirm-pin-a");
    const accessible = `${confirm.textContent ?? ""} ${confirm.getAttribute("aria-label") ?? ""}`;
    expect(accessible).toContain("1");
  });

  it("Confirm emits exactly one remove_annotation for that pin", () => {
    const { sent, getChanged } = openOwnThread({
      comments: [{ id: "c1", author: String(MY_ID), text: "one" }],
    });

    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));
    fireEvent.click(screen.getByTestId("pin-delete-confirm-pin-a"));

    const removes = sent.filter((c) => c.type === "remove_annotation");
    expect(removes).toHaveLength(1);
    expect(removes[0]).toEqual({
      type: "remove_annotation",
      dataset_id: "wds-1",
      id: "pin-a",
    });
    expect(getChanged()).toBe(1);
  });

  it("Cancel emits nothing and dismisses the confirm, leaving the pin intact", () => {
    const { sent, getChanged } = openOwnThread({
      comments: [{ id: "c1", author: String(MY_ID), text: "keep me" }],
    });

    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));
    fireEvent.click(screen.getByTestId("pin-delete-cancel-pin-a"));

    // Nothing emitted; confirm gone; the Delete trigger and thread remain.
    expect(sent.some((c) => c.type === "remove_annotation")).toBe(false);
    expect(getChanged()).toBe(0);
    expect(screen.queryByTestId("pin-delete-confirm-pin-a")).toBeNull();
    expect(screen.getByTestId("pin-delete-pin-a")).toBeTruthy();
    expect(screen.getByText("keep me")).toBeTruthy();
  });

  it("re-arming after Cancel still leads to a working Confirm", () => {
    const { sent } = openOwnThread();
    // Arm, cancel, arm again, confirm — the second pass must still emit once.
    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));
    fireEvent.click(screen.getByTestId("pin-delete-cancel-pin-a"));
    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));
    fireEvent.click(screen.getByTestId("pin-delete-confirm-pin-a"));

    expect(sent.filter((c) => c.type === "remove_annotation")).toHaveLength(1);
  });

  it("a non-author pin shows no delete affordance in its open thread", () => {
    // Open a peer's pin thread: the dot testid is widened to every pin, so it
    // opens, but no pin-delete-* control should render for a non-author.
    renderOverlay({ pins: [ownPin({ id: "pin-b", author: "999", comments: [] })] });
    const marker = screen.getByTestId("annot-pin-pin-b");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });

    // Thread is open (its add-comment placeholder is present) …
    expect(screen.getByPlaceholderText("Add a comment…")).toBeTruthy();
    // … but there's no delete trigger or confirm for a pin that isn't mine.
    expect(screen.queryByTestId("pin-delete-pin-b")).toBeNull();
    expect(screen.queryByTestId("pin-delete-confirm-pin-b")).toBeNull();
    expect(screen.queryByTestId("pin-delete-cancel-pin-b")).toBeNull();
  });

  it("closing the thread drops a pending confirm (re-opening starts un-armed)", () => {
    openOwnThread();
    const marker = screen.getByTestId("annot-pin-pin-a");

    // Arm the confirm, then close the thread by clicking the dot again.
    fireEvent.click(screen.getByTestId("pin-delete-pin-a"));
    expect(screen.getByTestId("pin-delete-confirm-pin-a")).toBeTruthy();
    fireEvent.click(marker); // toggles the thread closed
    expect(screen.queryByTestId("pin-delete-confirm-pin-a")).toBeNull();

    // Re-open: back to the plain Delete trigger, not the confirm.
    fireEvent.click(marker);
    expect(screen.getByTestId("pin-delete-pin-a")).toBeTruthy();
    expect(screen.queryByTestId("pin-delete-confirm-pin-a")).toBeNull();
  });
});

describe("AnnotationOverlay — open thread stacks above other pins (issue #772)", () => {
  /** Read a pin wrapper's inline numeric z-index (NaN if it carries none), so
   * the assertions compare the actual stacking the browser would apply. */
  function wrapperZ(pinId: string): number {
    const el = screen.getByTestId(`annot-pin-wrapper-${pinId}`);
    return Number.parseInt((el as HTMLElement).style.zIndex, 10);
  }

  /** Open a pin's thread with a pure click (down+up same point, then click), the
   * same gesture the other suites use so drag-suppression never interferes. */
  function openThread(pinId: string) {
    const marker = screen.getByTestId(`annot-pin-${pinId}`);
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });
  }

  /** Two pins: "pin-a" first in the array, "pin-b" later (so by DOM order alone
   * pin-b would paint on top — the exact bug). Both authored by me. */
  function twoPins() {
    return renderOverlay({
      pins: [
        ownPin({ id: "pin-a", position: [10, 20] }),
        ownPin({ id: "pin-b", position: [12, 22] }),
      ],
    });
  }

  it("with pin A's thread open and B's closed, A's wrapper z-index > B's", () => {
    twoPins();
    openThread("pin-a");

    // The open pin (A) is lifted strictly above the closed pin (B), so A's
    // popover paints over B's dot regardless of DOM order.
    expect(wrapperZ("pin-a")).toBeGreaterThan(wrapperZ("pin-b"));
  });

  it("the open pin's thread popover is present while open", () => {
    twoPins();
    openThread("pin-a");
    expect(screen.getByTestId("annot-thread-pin-a")).toBeTruthy();
    // The closed pin has no popover.
    expect(screen.queryByTestId("annot-thread-pin-b")).toBeNull();
  });

  it("with no thread open, no pin is elevated above the others (equal base)", () => {
    twoPins();
    // Nothing opened: both wrappers sit at the same FINITE base level — pins render
    // normally, none jockeys above another. (Finiteness guards against a regression
    // that drops the z-index entirely, which would make both NaN and trivially "equal".)
    expect(Number.isFinite(wrapperZ("pin-a"))).toBe(true);
    expect(wrapperZ("pin-a")).toBe(wrapperZ("pin-b"));
    // And neither popover exists.
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
    expect(screen.queryByTestId("annot-thread-pin-b")).toBeNull();
  });

  it("opening B after A elevates B and de-elevates A (only the open thread lifts)", () => {
    twoPins();

    openThread("pin-a");
    expect(wrapperZ("pin-a")).toBeGreaterThan(wrapperZ("pin-b"));

    // Switch: opening B closes A (one thread at a time) and moves the lift to B.
    openThread("pin-b");
    expect(wrapperZ("pin-b")).toBeGreaterThan(wrapperZ("pin-a"));
    // A is back at base and its popover is gone; B now owns the open popover.
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
    expect(screen.getByTestId("annot-thread-pin-b")).toBeTruthy();
  });

  it("closing the open thread restores equal stacking (no lingering lift)", () => {
    twoPins();
    openThread("pin-a");
    expect(wrapperZ("pin-a")).toBeGreaterThan(wrapperZ("pin-b"));

    // Click the same dot again to close: both wrappers return to the same base.
    openThread("pin-a");
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
    expect(wrapperZ("pin-a")).toBe(wrapperZ("pin-b"));
  });

  it("the open thread still carries its Delete + comment controls (no regression)", () => {
    twoPins();
    openThread("pin-a");

    // The lifted thread is the real, interactive popover: its Delete trigger and
    // the add-comment box are both present inside the elevated wrapper.
    const thread = screen.getByTestId("annot-thread-pin-a");
    expect(screen.getByTestId("pin-delete-pin-a")).toBeTruthy();
    expect(thread.querySelector('input[placeholder="Add a comment…"]')).toBeTruthy();
  });
});
