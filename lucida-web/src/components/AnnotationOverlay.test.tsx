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
      // Reflect the commands this slice emits so a re-read shows the result. A
      // move_annotation carries `position`/`z` always, and `end` too when it's a
      // reshape (a corner/edge resize) — mirror both so a re-read sees the moved
      // anchor AND the resized opposite corner.
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

// The annotation-author identity is now a stable string (issue #777), not the
// per-connection numeric client id. Authoring helpers use `String(MY_ID)`, so a
// string literal here flows through every `author`/ownership comparison
// unchanged while matching the overlay's `myId: string` prop type.
const MY_ID = "7";

function renderOverlay(opts: {
  pins: Annotation[];
  myId?: string;
  /** The view's Z/T/C. Defaults to the on-context view for the standard test
   * pins (z=3, t/c absent → 0), so existing suites see today's look; the
   * off-context suite overrides it (or the pins) to force a mismatch. */
  viewContext?: { z: number; t: number; c: number };
}) {
  const { scene, applied } = makeScene(opts.pins);
  const sent: Array<Record<string, unknown>> = [];
  const sceneRef = createRef<WasmScene | null>();
  // Prime the ref before render (RefObject.current is writable in tests).
  sceneRef.current = scene;
  let changed = 0;
  let viewportChanged = 0;
  const canvas = makeCanvas();
  const { rerender } = render(
    <AnnotationOverlay
      datasetId="wds-1"
      wasmSceneRef={sceneRef}
      canvas={canvas}
      version={0}
      viewContext={opts.viewContext ?? { z: 3, t: 0, c: 0 }}
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
  /** Re-render with a new view context (the rest of the props are fixed), so a
   * test can navigate the view and assert the off-context status updates — it's a
   * pure function of the view, so this is how "navigate to match" is exercised. */
  const setViewContext = (viewContext: { z: number; t: number; c: number }) => {
    rerender(
      <AnnotationOverlay
        datasetId="wds-1"
        wasmSceneRef={sceneRef}
        canvas={canvas}
        version={0}
        viewContext={viewContext}
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
  };
  return {
    applied,
    sent,
    getChanged: () => changed,
    getViewportChanged: () => viewportChanged,
    setViewContext,
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

describe("AnnotationOverlay — resize a box from its handles (move_annotation reshape)", () => {
  /** An own box pin with opposite corners `position` (anchor) and `end`. With
   * the harness camera (zoom=1, center=(0,0), 800x600, dpr=1) world = screenPx −
   * half (halfW=400, halfH=300), so a release at client (cx,cy) lands at world
   * (cx−400, cy−300) — used to compute the exact expected reshape below. */
  function boxPin(overrides: Partial<Annotation> = {}): Annotation {
    return ownPin({
      id: "box-1",
      kind: "box",
      position: [10, 20],
      end: [60, 80],
      ...overrides,
    });
  }

  const ALL_HANDLES = ["nw", "ne", "se", "sw", "n", "e", "s", "w"] as const;

  it("an own box renders all eight resize handles (corners + edges)", () => {
    renderOverlay({ pins: [boxPin()] });
    for (const h of ALL_HANDLES) {
      expect(screen.getByTestId(`annot-resize-box-1-${h}`)).toBeTruthy();
    }
  });

  it("a non-author box renders no resize handles", () => {
    renderOverlay({ pins: [boxPin({ id: "box-peer", author: "999" })] });
    for (const h of ALL_HANDLES) {
      expect(screen.queryByTestId(`annot-resize-box-peer-${h}`)).toBeNull();
    }
    // The box itself still renders (its dot is present for everyone).
    expect(screen.getByTestId("annot-pin-box-peer")).toBeTruthy();
  });

  it("an own point renders no resize handles", () => {
    // A point (the default kind) is not resizable — no handles for any direction.
    renderOverlay({ pins: [ownPin({ id: "pt-1" })] });
    for (const h of ALL_HANDLES) {
      expect(screen.queryByTestId(`annot-resize-pt-1-${h}`)).toBeNull();
    }
  });

  it("an own line renders no resize handles (boxes only this slice)", () => {
    renderOverlay({ pins: [ownPin({ id: "ln-1", kind: "line", end: [40, 50] })] });
    for (const h of ALL_HANDLES) {
      expect(screen.queryByTestId(`annot-resize-ln-1-${h}`)).toBeNull();
    }
  });

  it("dragging the SE corner emits one reshape: end changes, position unchanged", () => {
    const { sent, getChanged } = renderOverlay({ pins: [boxPin()] });
    const se = screen.getByTestId("annot-resize-box-1-se");

    // Press on the SE handle, travel past the 4px slop, release at client
    // (500,400) → world (100,100). SE moves the opposite corner (end); the
    // anchor (position) is held.
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 260, clientY: 380 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 500, clientY: 400 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      type: "move_annotation",
      dataset_id: "wds-1",
      id: "box-1",
      z: 3,
    });
    // A reshape carries BOTH a numeric position and a numeric end.
    expect(moves[0].position).toEqual([10, 20]); // anchor unchanged
    expect(moves[0].end).toEqual([100, 100]); // opposite corner moved to release
    expect(getChanged()).toBe(1);
  });

  it("dragging the NW corner emits a reshape with position changed, end held", () => {
    const { sent } = renderOverlay({ pins: [boxPin()] });
    const nw = screen.getByTestId("annot-resize-box-1-nw");

    // Release at client (350,250) → world (-50,-50). NW moves the anchor
    // (position); the opposite corner (end) is held.
    fireEvent.pointerDown(nw, { pointerId: 1, button: 0, clientX: 410, clientY: 320 });
    fireEvent.pointerMove(nw, { pointerId: 1, clientX: 380, clientY: 290 });
    fireEvent.pointerUp(nw, { pointerId: 1, clientX: 350, clientY: 250 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([-50, -50]); // anchor moved to release
    expect(moves[0].end).toEqual([60, 80]); // opposite corner held
  });

  it("a corner reshape carries numeric position AND end arrays (both vertices)", () => {
    // Guards the wire shape the contract names: a reshape is identified by a
    // numeric `end` array alongside a numeric `position` array.
    const { sent } = renderOverlay({ pins: [boxPin()] });
    const se = screen.getByTestId("annot-resize-box-1-se");
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 260, clientY: 380 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 450, clientY: 450 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 520, clientY: 520 });

    const move = sent.find((c) => c.type === "move_annotation")!;
    const pos = move.position as unknown[];
    const end = move.end as unknown[];
    expect(Array.isArray(pos) && pos.length === 2).toBe(true);
    expect(Array.isArray(end) && end.length === 2).toBe(true);
    expect(typeof pos[0]).toBe("number");
    expect(typeof end[0]).toBe("number");
  });

  it("dragging the E edge moves only the end.x coordinate (one coordinate)", () => {
    const { sent } = renderOverlay({ pins: [boxPin()] });
    const e = screen.getByTestId("annot-resize-box-1-e");

    // Release at client (500,500) → world (100,200). The E edge owns end.x only,
    // so end.x → 100 while end.y (80) and the whole anchor (10,20) are held.
    fireEvent.pointerDown(e, { pointerId: 1, button: 0, clientX: 460, clientY: 350 });
    fireEvent.pointerMove(e, { pointerId: 1, clientX: 480, clientY: 420 });
    fireEvent.pointerUp(e, { pointerId: 1, clientX: 500, clientY: 500 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([10, 20]); // anchor fully held
    expect(moves[0].end).toEqual([100, 80]); // only end.x moved; end.y held
  });

  it("dragging the N edge moves only the position.y coordinate", () => {
    const { sent } = renderOverlay({ pins: [boxPin()] });
    const n = screen.getByTestId("annot-resize-box-1-n");

    // Release at client (450,350) → world (50,50). The N edge owns position.y
    // only, so position.y → 50 while position.x (10) and end (60,80) are held.
    fireEvent.pointerDown(n, { pointerId: 1, button: 0, clientX: 435, clientY: 320 });
    fireEvent.pointerMove(n, { pointerId: 1, clientX: 440, clientY: 335 });
    fireEvent.pointerUp(n, { pointerId: 1, clientX: 450, clientY: 350 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([10, 50]); // only position.y moved
    expect(moves[0].end).toEqual([60, 80]); // opposite corner fully held
  });

  it("a handle press without travel (within slop) emits no reshape", () => {
    const { sent } = renderOverlay({ pins: [boxPin()] });
    const se = screen.getByTestId("annot-resize-box-1-se");
    // Stay within the 4px click slop → not a drag → no reshape.
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 302, clientY: 301 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 302, clientY: 301 });
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("a reshape is applied locally AND broadcast (goes through applyDocumentCommand)", () => {
    const { applied, sent } = renderOverlay({ pins: [boxPin()] });
    const se = screen.getByTestId("annot-resize-box-1-se");
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 260, clientY: 380 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 500, clientY: 400 });

    // applyDocumentCommand applies to the scene (optimistic) AND sends to peers.
    expect(applied.filter((c) => c.type === "move_annotation")).toHaveLength(1);
    expect(sent.filter((c) => c.type === "move_annotation")).toHaveLength(1);
    expect(applied[0].end).toEqual([100, 100]);
  });

  it("dragging one handle does not move the other corner (held side stays put)", () => {
    // Two moves before release: the recompute must always build off the fixed
    // press-time base, so the SE drag's final end is the release point and the
    // anchor never drifts regardless of the intermediate path.
    const { sent } = renderOverlay({ pins: [boxPin()] });
    const se = screen.getByTestId("annot-resize-box-1-se");
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 260, clientY: 380 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 700, clientY: 590 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 450, clientY: 450 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 500, clientY: 400 });

    const move = sent.find((c) => c.type === "move_annotation")!;
    expect(move.position).toEqual([10, 20]); // anchor never drifted
    expect(move.end).toEqual([100, 100]); // end is the final release point
  });

  it("regression: a plain click on an own box's dot still opens its thread (handles present)", () => {
    // The anchor dot remains the thread target even though resize handles now
    // share the box. A pure click on the dot toggles the thread open.
    renderOverlay({
      pins: [boxPin({ comments: [{ id: "c1", author: String(MY_ID), text: "in the box" }] })],
    });
    // Handles exist for this own box…
    expect(screen.getByTestId("annot-resize-box-1-nw")).toBeTruthy();
    // …and a plain click on the dot still opens the thread.
    const dot = screen.getByTestId("annot-pin-box-1");
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(dot, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(dot, { clientX: 200, clientY: 200 });
    expect(screen.getByText("in the box")).toBeTruthy();
  });

  it("regression: a plain drag on an own box's dot still pans (not a reshape)", () => {
    // A plain (non-Shift) drag from the box's dot pans the view exactly like a
    // point pin — it must not reshape the box or move it.
    const { applied, sent } = renderOverlay({ pins: [boxPin()] });
    const dot = screen.getByTestId("annot-pin-box-1");
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(dot, { pointerId: 1, clientX: 280, clientY: 240 });
    fireEvent.pointerUp(dot, { pointerId: 1, clientX: 280, clientY: 240 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.filter((c) => c.type === "pan").length).toBeGreaterThanOrEqual(1);
  });

  it("regression: a box still renders its outline (polygon) alongside the handles", () => {
    // The resize affordance must not displace the box's existing rendering.
    const { sent } = renderOverlay({ pins: [boxPin()] });
    // The box outline (a polygon) and its dot both still exist…
    expect(document.querySelector("polygon")).toBeTruthy();
    expect(screen.getByTestId("annot-pin-box-1")).toBeTruthy();
    // …and the anchor dot's Shift+drag still moves the WHOLE box (a rigid move:
    // no `end` in the emitted command — the #776 path, not a reshape).
    const dot = screen.getByTestId("annot-pin-box-1");
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(dot, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(dot, { pointerId: 1, shiftKey: true, clientX: 500, clientY: 400 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([100, 100]); // whole-box move to release
    expect(moves[0].end).toBeUndefined(); // rigid move carries NO end (not a reshape)
  });
});

describe("AnnotationOverlay — off-context vs the view's Z/T/C (issue #779)", () => {
  // A pin placed on slice 12, timepoint 3, channel 2. The standard view context
  // here is { z: 3, t: 0, c: 0 } (the renderOverlay default), so this pin is
  // off-context by default unless the view is navigated to (12, 3, 2).
  function elsewherePin(overrides: Partial<Annotation> = {}): Annotation {
    return ownPin({ id: "pin-here", z: 12, t: 3, c: 2, ...overrides });
  }

  it("a pin whose z/t/c all match the view is on-context (no off-context marker)", () => {
    // The pin lives exactly where we're looking → today's look, no marker.
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 1 })],
      viewContext: { z: 5, t: 2, c: 1 },
    });
    // The marker itself renders…
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
    // …but it carries NO off-context marker (this is the on-context contract).
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
  });

  it("a pin on a different slice (z) renders off-context with helptext naming its z/t/c", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 12, t: 3, c: 2 })],
      // Same t/c, different z → off-context purely on z.
      viewContext: { z: 4, t: 3, c: 2 },
    });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    // The helptext names the PIN's own z/t/c in the exact contract form.
    expect(marker.textContent).toBe("slice 12 · t=3 · ch=2");
    // The dot still renders alongside the off-context marker.
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
  });

  it("a pin on a different timepoint (t) renders off-context", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 9, c: 1 })],
      // Same z/c, different t.
      viewContext: { z: 5, t: 0, c: 1 },
    });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    expect(marker.textContent).toBe("slice 5 · t=9 · ch=1");
  });

  it("a pin on a different channel (c) renders off-context", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 7 })],
      // Same z/t, different c.
      viewContext: { z: 5, t: 2, c: 0 },
    });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    expect(marker.textContent).toBe("slice 5 · t=2 · ch=7");
  });

  it("navigating the view to the pin's Z/T/C returns it to on-context", () => {
    // Start off-context, then navigate the view to the pin's exact slice → the
    // off-context marker disappears (it's a pure function of the view).
    const { setViewContext } = renderOverlay({
      pins: [elsewherePin()],
      viewContext: { z: 3, t: 0, c: 0 },
    });
    expect(screen.getByTestId("annot-offcontext-pin-here")).toBeTruthy();

    // Navigate to (12, 3, 2) — exactly where the pin lives.
    setViewContext({ z: 12, t: 3, c: 2 });
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
    // The marker is still present (only its off-context decoration went away).
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
  });

  it("navigating AWAY from a matching pin makes it off-context", () => {
    // The reverse: on-context, then move the view off the pin's slice.
    const { setViewContext } = renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 1 })],
      viewContext: { z: 5, t: 2, c: 1 },
    });
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();

    // Step to the next slice → now off-context, helptext names the pin's slice.
    setViewContext({ z: 6, t: 2, c: 1 });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    expect(marker.textContent).toBe("slice 5 · t=2 · ch=1");
  });

  it("regression: an off-context pin's marker still renders and opens its thread on click", () => {
    // Off-context is a look, not a lockout — the pin is still fully interactive.
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
    // It IS off-context…
    expect(screen.getByTestId("annot-offcontext-pin-here")).toBeTruthy();
    // …and a plain click on its dot still opens the thread.
    const dot = screen.getByTestId("annot-pin-pin-here");
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(dot, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(dot, { clientX: 200, clientY: 200 });
    expect(screen.getByText("still works")).toBeTruthy();
  });

  it("a pre-slice-14 pin (no t/c) is on-context when the view is at its z and t=c=0", () => {
    // An older pin carries no t/c → they read as 0. So at the view (z, 0, 0) it
    // is on-context — older pins don't all spuriously show as off-context.
    renderOverlay({
      pins: [{ id: "old", position: [10, 20], z: 8, author: String(MY_ID), kind: "point" }],
      viewContext: { z: 8, t: 0, c: 0 },
    });
    expect(screen.queryByTestId("annot-offcontext-old")).toBeNull();
  });

  it("only the off-context pin among several carries the marker", () => {
    // Mixed set: one on-context, one off — exactly one off-context marker.
    renderOverlay({
      pins: [
        ownPin({ id: "pin-on", z: 3, t: 0, c: 0 }),
        ownPin({ id: "pin-off", z: 9, t: 0, c: 0 }),
      ],
      viewContext: { z: 3, t: 0, c: 0 },
    });
    expect(screen.queryByTestId("annot-offcontext-pin-on")).toBeNull();
    expect(screen.getByTestId("annot-offcontext-pin-off")).toBeTruthy();
  });
});

describe("AnnotationOverlay — reflects re-anchored positions after a layout switch (issue #780)", () => {
  // The re-anchoring itself happens in core (DocumentState::apply on
  // SetActiveLayout); the overlay's job is only to RE-READ the authoritative pin
  // set when notified. It re-reads in an effect keyed on `version`, so a layout
  // switch must bump that version — for a peer the bridge already does, and for
  // the switcher App's onLayoutChange now does too. These tests pin that the
  // overlay shows the post-switch positions once `version` bumps, and does NOT
  // before (so the bump is genuinely load-bearing).

  /** A scene whose authoritative `annotations()` output we can swap out, to
   * stand in for core re-anchoring the pins on a layout switch. */
  function makeReanchoringScene(initial: Annotation[]): {
    scene: WasmScene;
    setPins: (next: Annotation[]) => void;
  } {
    let pins = initial;
    const scene = {
      annotations: (_datasetId: string) => JSON.stringify(pins),
      zoom: () => 1,
      center: () => new Float64Array([0, 0]),
      apply_command: () => {},
    } as unknown as WasmScene;
    return { scene, setPins: (next) => { pins = next; } };
  }

  // The overlay reprojects markers in a self-rescheduling RAF loop. To read the
  // dot transform deterministically, install a CAPTURING stub before render so we
  // hold every scheduled callback (including the one the mount effect schedules),
  // then invoke the latest on demand via runFrame() instead of letting the loop
  // run free. Restored after each test.
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
  /** Run the most recently scheduled RAF tick (the overlay reschedules at the end
   * of each tick, so the latest is the live one). */
  function runFrame() {
    const cb = scheduled[scheduled.length - 1];
    if (cb) cb(performance.now());
  }

  function dotTransform(id: string): string {
    return (screen.getByTestId(`annot-pin-wrapper-${id}`) as HTMLElement).style.transform;
  }

  it("re-reads the pin set and renders it at the re-anchored position once version bumps", () => {
    // zoom=1, center=(0,0), 800x600 → screen = world + half (400, 300).
    const before: Annotation[] = [
      { id: "p", position: [10, 20], z: 0, author: String(MY_ID), kind: "point", comments: [] },
    ];
    const { scene, setPins } = makeReanchoringScene(before);
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = scene;
    const canvas = makeCanvas();
    const props = (version: number) => ({
      datasetId: "wds-1",
      wasmSceneRef: sceneRef,
      canvas,
      version,
      viewContext: { z: 0, t: 0, c: 0 },
      myId: MY_ID,
      sendCommand: () => {},
      onDocumentChanged: () => {},
    });
    const { rerender } = render(<AnnotationOverlay {...props(0)} />);

    // Pre-switch: the dot sits at world (10,20) → screen (410, 320).
    runFrame();
    expect(dotTransform("p")).toBe("translate(410px, 320px)");

    // Core re-anchored the pin (e.g. its well moved by +[0,50]) → position now
    // (10,70). A locally-initiated switch that did NOT bump version would leave
    // the overlay stale: it still shows the old position.
    setPins([{ ...before[0], position: [10, 70] }]);
    rerender(<AnnotationOverlay {...props(0)} />); // same version
    runFrame();
    expect(dotTransform("p")).toBe("translate(410px, 320px)");

    // Bumping version (what App.onLayoutChange / the bridge now do) makes the
    // overlay re-read the authoritative set → the dot moves to the re-anchored
    // world (10,70) → screen (410, 370).
    rerender(<AnnotationOverlay {...props(1)} />);
    runFrame();
    expect(dotTransform("p")).toBe("translate(410px, 370px)");
  });

  it("reflects a pin on a non-moving well as unchanged after a version bump", () => {
    // A pin whose anchor well didn't move: core leaves its position alone, so the
    // overlay (after re-reading on the bump) shows it in exactly the same place.
    const pins: Annotation[] = [
      { id: "static", position: [100, 5], z: 0, author: String(MY_ID), kind: "point", comments: [] },
    ];
    const { scene } = makeReanchoringScene(pins);
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = scene;
    const canvas = makeCanvas();
    const props = (version: number) => ({
      datasetId: "wds-1",
      wasmSceneRef: sceneRef,
      canvas,
      version,
      viewContext: { z: 0, t: 0, c: 0 },
      myId: MY_ID,
      sendCommand: () => {},
      onDocumentChanged: () => {},
    });
    const { rerender } = render(<AnnotationOverlay {...props(0)} />);
    runFrame();
    const at = dotTransform("static"); // world (100,5) → screen (500, 305)
    expect(at).toBe("translate(500px, 305px)");
    rerender(<AnnotationOverlay {...props(1)} />);
    runFrame();
    expect(dotTransform("static")).toBe(at);
  });
});
