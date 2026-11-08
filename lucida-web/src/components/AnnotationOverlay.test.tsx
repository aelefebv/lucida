// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay } from "./AnnotationOverlay.tsx";
import type { Annotation } from "./annotationDocument.ts";
import { deriveHandle } from "./annotationParticipants.ts";

/**
 * Stand-in for the WASM scene covering only the 2D overlay's surface.
 * apply_command mutates pin state so a re-read reflects an optimistic change.
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
      // A reshape also carries `end`; mirror it so a re-read sees both corners.
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

const MY_ID = "7";

function renderOverlay(opts: {
  pins: Annotation[];
  myId?: string;
  /** The view's Z/T/C. Defaults to on-context for the standard pins (z=3). */
  viewContext?: { z: number; t: number; channels: number[] };
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
      viewContext={opts.viewContext ?? { z: 3, t: 0, channels: [0] }}
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
  /** Re-render with a new view context, to navigate the view. */
  const setViewContext = (viewContext: { z: number; t: number; channels: number[] }) => {
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
    // A plain drag pans, so a move carries Shift from the pointerdown on.
    const { sent, getChanged } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    // world = screenPx - half, so release at client (500, 400) is world (100, 100).
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

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 400, clientY: 400 });
    // The browser still fires a click after a drag; the overlay must swallow it.
    fireEvent.click(marker, { clientX: 400, clientY: 400 });

    expect(screen.queryByText("hi")).toBeNull();
  });

  it("a drag with no trailing click does not poison the next click (thread still opens)", () => {
    renderOverlay({ pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    // A drag whose trailing click never arrives leaves the suppression flag set.
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 400, clientY: 400 });
    // (no click here)

    // The next pointerdown clears the stale flag, so a clean click opens.
    fireEvent.pointerDown(marker, { pointerId: 2, button: 0, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(marker, { pointerId: 2, clientX: 400, clientY: 400 });
    fireEvent.click(marker, { clientX: 400, clientY: 400 });

    expect(screen.getByText("hi")).toBeTruthy();
  });

  it("a non-author pin carries the dot testid but a Shift+drag emits no move", () => {
    const { sent } = renderOverlay({
      pins: [ownPin({ id: "pin-b", author: "999" })],
    });
    // Every pin carries the dot testid so any pin's thread can be opened.
    expect(screen.getByTestId("annot-pin-pin-b")).toBeTruthy();

    // Move is author-only: a peer's dot has no move handlers.
    const marker = screen.getByTestId("annot-pin-pin-b");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 400, clientY: 400 });
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("shift-click (no travel) neither moves nor removes a pin", () => {
    const { sent, getChanged } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");
    // A stationary Shift-press starts a would-be move, so it emits neither a
    // move nor a remove.
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
    // A plain drag on an own marker pans like dragging the canvas. Pan is a
    // local-only viewport command, so it lands in `applied`, never in `sent`.
    const { applied, sent } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 240, clientY: 220 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300, clientY: 260 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 300, clientY: 260 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.some((c) => c.type === "move_annotation")).toBe(false);
    // At least one viewport pan was applied to the scene…
    const pans = applied.filter((c) => c.type === "pan");
    expect(pans.length).toBeGreaterThanOrEqual(1);
    // …and a pan is viewport state, never broadcast.
    expect(sent.some((c) => c.type === "pan")).toBe(false);
  });

  it("the pan forwarded is dpr-aware and negated (the SliceViewer pan)", () => {
    // dpr=2 and travel (+30, +10) CSS px give the negated, scaled delta
    // (-60, -20), matching SliceViewer.
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
    // Pans by travel since the last event: two pans of -20, not one of -40.
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
    // A pan that didn't repaint would slide the pins over a frozen image.
    const { getViewportChanged } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(marker, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 160, clientY: 140 });

    expect(getViewportChanged()).toBeGreaterThanOrEqual(1);
  });

  it("a Shift+drag moves the pin and applies NO pan (move, not pan)", () => {
    const { applied, sent } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 500, clientY: 400 });

    expect(sent.filter((c) => c.type === "move_annotation")).toHaveLength(1);
    expect(applied.some((c) => c.type === "pan")).toBe(false);
  });

  it("a plain click (no travel) toggles the thread and applies no pan, no move", () => {
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
    // Shift is the move modifier, so its trailing click is swallowed.
    const { applied, sent } = renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })],
    });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { shiftKey: true, clientX: 200, clientY: 200 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.some((c) => c.type === "pan")).toBe(false);
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
  /** Render one pin and open its thread with a pure click. */
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
    // The count may appear in the text or the aria-label.
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
  /** A pin wrapper's inline z-index, or NaN if it carries none. */
  function wrapperZ(pinId: string): number {
    const el = screen.getByTestId(`annot-pin-wrapper-${pinId}`);
    return Number.parseInt((el as HTMLElement).style.zIndex, 10);
  }

  /** Open a pin's thread with a pure click so drag suppression never interferes. */
  function openThread(pinId: string) {
    const marker = screen.getByTestId(`annot-pin-${pinId}`);
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });
  }

  /** Two own pins. By DOM order alone pin-b would paint on top of pin-a. */
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
    // Same finite base. Checking finiteness stops two NaNs from passing as equal.
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

    const thread = screen.getByTestId("annot-thread-pin-a");
    expect(screen.getByTestId("pin-delete-pin-a")).toBeTruthy();
    expect(thread.querySelector('input[placeholder="Add a comment…"]')).toBeTruthy();
  });
});

describe("AnnotationOverlay — resize a box from its handles (move_annotation reshape)", () => {
  /** An own box pin. Under the harness camera a release at client (cx,cy) lands
   * at world (cx - 400, cy - 300). */
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

  // Mirrors the component's unexported HANDLE_HOVER_LINGER_MS.
  const LINGER_MS = 300;

  /** Reveal an own box's resize handles by hovering its shape. */
  function hoverBox(id = "box-1") {
    fireEvent.pointerEnter(screen.getByTestId(`annot-shape-${id}`));
  }

  it("an own box reveals all eight resize handles (corners + edges) on hover", () => {
    renderOverlay({ pins: [boxPin()] });
    // Before any hover none of the eight exist.
    for (const h of ALL_HANDLES) {
      expect(screen.queryByTestId(`annot-resize-box-1-${h}`)).toBeNull();
    }
    // Hovering the box's shape reveals all eight.
    hoverBox();
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
    hoverBox();
    const se = screen.getByTestId("annot-resize-box-1-se");

    // Release at client (500,400) = world (100,100). SE moves `end` only.
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
    expect(moves[0].position).toEqual([10, 20]); // anchor unchanged
    expect(moves[0].end).toEqual([100, 100]); // opposite corner moved to release
    expect(getChanged()).toBe(1);
  });

  it("dragging the NW corner emits a reshape with position changed, end held", () => {
    const { sent } = renderOverlay({ pins: [boxPin()] });
    hoverBox();
    const nw = screen.getByTestId("annot-resize-box-1-nw");

    // Release at client (350,250) = world (-50,-50). NW moves `position` only.
    fireEvent.pointerDown(nw, { pointerId: 1, button: 0, clientX: 410, clientY: 320 });
    fireEvent.pointerMove(nw, { pointerId: 1, clientX: 380, clientY: 290 });
    fireEvent.pointerUp(nw, { pointerId: 1, clientX: 350, clientY: 250 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([-50, -50]); // anchor moved to release
    expect(moves[0].end).toEqual([60, 80]); // opposite corner held
  });

  it("a corner reshape carries numeric position AND end arrays (both vertices)", () => {
    // A reshape is identified on the wire by a numeric `end` array.
    const { sent } = renderOverlay({ pins: [boxPin()] });
    hoverBox();
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
    hoverBox();
    const e = screen.getByTestId("annot-resize-box-1-e");

    // Release at client (500,500) = world (100,200). E owns end.x only.
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
    hoverBox();
    const n = screen.getByTestId("annot-resize-box-1-n");

    // Release at client (450,350) = world (50,50). N owns position.y only.
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
    hoverBox();
    const se = screen.getByTestId("annot-resize-box-1-se");
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 302, clientY: 301 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 302, clientY: 301 });
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });

  it("a reshape is applied locally AND broadcast (goes through applyDocumentCommand)", () => {
    const { applied, sent } = renderOverlay({ pins: [boxPin()] });
    hoverBox();
    const se = screen.getByTestId("annot-resize-box-1-se");
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 260, clientY: 380 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 500, clientY: 400 });

    expect(applied.filter((c) => c.type === "move_annotation")).toHaveLength(1);
    expect(sent.filter((c) => c.type === "move_annotation")).toHaveLength(1);
    expect(applied[0].end).toEqual([100, 100]);
  });

  it("dragging one handle does not move the other corner (held side stays put)", () => {
    // The recompute builds off the press-time base, so the intermediate path
    // can't make the anchor drift.
    const { sent } = renderOverlay({ pins: [boxPin()] });
    hoverBox();
    const se = screen.getByTestId("annot-resize-box-1-se");
    fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 260, clientY: 380 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 700, clientY: 590 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 450, clientY: 450 });
    fireEvent.pointerUp(se, { pointerId: 1, clientX: 500, clientY: 400 });

    const move = sent.find((c) => c.type === "move_annotation")!;
    expect(move.position).toEqual([10, 20]); // anchor never drifted
    expect(move.end).toEqual([100, 100]); // end is the final release point
  });

  it("regression: a plain click on an own box's dot still opens its thread (handles revealed on hover)", () => {
    // The anchor dot stays the thread target with the handles revealed.
    renderOverlay({
      pins: [boxPin({ comments: [{ id: "c1", author: String(MY_ID), text: "in the box" }] })],
    });
    hoverBox();
    expect(screen.getByTestId("annot-resize-box-1-nw")).toBeTruthy();
    const dot = screen.getByTestId("annot-pin-box-1");
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(dot, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(dot, { clientX: 200, clientY: 200 });
    expect(screen.getByText("in the box")).toBeTruthy();
  });

  it("regression: a plain drag on an own box's dot still pans (not a reshape)", () => {
    const { applied, sent } = renderOverlay({ pins: [boxPin()] });
    const dot = screen.getByTestId("annot-pin-box-1");
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(dot, { pointerId: 1, clientX: 280, clientY: 240 });
    fireEvent.pointerUp(dot, { pointerId: 1, clientX: 280, clientY: 240 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.filter((c) => c.type === "pan").length).toBeGreaterThanOrEqual(1);
  });

  it("regression: a box still renders its outline (polygon) alongside the handles", () => {
    const { sent } = renderOverlay({ pins: [boxPin()] });
    expect(document.querySelector("polygon")).toBeTruthy();
    expect(screen.getByTestId("annot-pin-box-1")).toBeTruthy();
    // Shift+drag on the dot is a rigid whole-box translate: no `end`.
    const dot = screen.getByTestId("annot-pin-box-1");
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(dot, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(dot, { pointerId: 1, shiftKey: true, clientX: 500, clientY: 400 });

    const moves = sent.filter((c) => c.type === "move_annotation");
    expect(moves).toHaveLength(1);
    expect(moves[0].position).toEqual([100, 100]); // whole-box move to release
    expect(moves[0].end).toBeUndefined(); // rigid move carries NO end (not a reshape)
  });

  it("regression: a resize that releases OFF the box hides the handles after the linger (#789)", () => {
    // A captured handle drag fires no enter/leave on the box, so handle-up
    // re-arms the hide; otherwise an off-box release leaves the handles stuck.
    // Only the linger timers are faked so RAF is untouched.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      renderOverlay({ pins: [boxPin()] });
      hoverBox();
      const se = screen.getByTestId("annot-resize-box-1-se");
      expect(se).toBeTruthy();

      // Drag outward and release at client (700,590), far off the box at
      // screen (410,320)-(460,380).
      fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 460, clientY: 380 });
      fireEvent.pointerMove(se, { pointerId: 1, clientX: 600, clientY: 500 });
      // Mid-drag, past the linger: the in-flight guard must keep the handle alive.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByTestId("annot-resize-box-1-se")).toBeTruthy();
      fireEvent.pointerUp(se, { pointerId: 1, clientX: 700, clientY: 590 });

      // The handles linger right after release...
      expect(screen.getByTestId("annot-resize-box-1-se")).toBeTruthy();
      // ...and are gone once the linger elapses.
      act(() => {
        vi.advanceTimersByTime(LINGER_MS + 1);
      });
      for (const h of ALL_HANDLES) {
        expect(screen.queryByTestId(`annot-resize-box-1-${h}`)).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("regression: a resize that releases back ON the box keeps the handles revealed (#789)", () => {
    // The re-armed hide must not fire under a cursor still over the box. A real
    // on-box release fires pointerenter as capture is released, which cancels
    // the pending hide.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      renderOverlay({ pins: [boxPin()] });
      hoverBox();
      const se = screen.getByTestId("annot-resize-box-1-se");

      // A small resize that stays near the box and releases ON it.
      fireEvent.pointerDown(se, { pointerId: 1, button: 0, clientX: 460, clientY: 380 });
      fireEvent.pointerMove(se, { pointerId: 1, clientX: 470, clientY: 385 });
      fireEvent.pointerUp(se, { pointerId: 1, clientX: 470, clientY: 385 });
      fireEvent.pointerEnter(screen.getByTestId("annot-resize-box-1-se"));

      act(() => {
        vi.advanceTimersByTime(LINGER_MS + 1);
      });
      for (const h of ALL_HANDLES) {
        expect(screen.getByTestId(`annot-resize-box-1-${h}`)).toBeTruthy();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AnnotationOverlay — off-context vs the view's Z/T/C (issue #779)", () => {
  // Placed at (12, 3, 2), so off-context against the default view (3, 0, 0).
  function elsewherePin(overrides: Partial<Annotation> = {}): Annotation {
    return ownPin({ id: "pin-here", z: 12, t: 3, c: 2, ...overrides });
  }

  it("a pin whose z/t/c all match the view is on-context (no off-context marker)", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 1 })],
      viewContext: { z: 5, t: 2, channels: [1] },
    });
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
  });

  it("a pin on a different slice (z) renders off-context with helptext naming its z/t/c", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 12, t: 3, c: 2 })],
      // Same t/c, different z → off-context purely on z.
      viewContext: { z: 4, t: 3, channels: [2] },
    });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    // The label names the pin's own z/t/c.
    expect(marker.textContent).toBe("Z 13 · T 4 · Channel 3");
    // The dot still renders alongside the off-context marker.
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
  });

  it("a pin on a different timepoint (t) renders off-context", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 9, c: 1 })],
      // Same z/c, different t.
      viewContext: { z: 5, t: 0, channels: [1] },
    });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    expect(marker.textContent).toBe("Z 6 · T 10 · Channel 2");
  });

  it("a pin on a different channel (c) renders off-context", () => {
    renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 7 })],
      // Same z/t, different c.
      viewContext: { z: 5, t: 2, channels: [0] },
    });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    expect(marker.textContent).toBe("Z 6 · T 3 · Channel 8");
  });

  it("navigating the view to the pin's Z/T/C returns it to on-context", () => {
    const { setViewContext } = renderOverlay({
      pins: [elsewherePin()],
      viewContext: { z: 3, t: 0, channels: [0] },
    });
    expect(screen.getByTestId("annot-offcontext-pin-here")).toBeTruthy();

    setViewContext({ z: 12, t: 3, channels: [2] });
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();
    expect(screen.getByTestId("annot-pin-pin-here")).toBeTruthy();
  });

  it("navigating AWAY from a matching pin makes it off-context", () => {
    const { setViewContext } = renderOverlay({
      pins: [ownPin({ id: "pin-here", z: 5, t: 2, c: 1 })],
      viewContext: { z: 5, t: 2, channels: [1] },
    });
    expect(screen.queryByTestId("annot-offcontext-pin-here")).toBeNull();

    setViewContext({ z: 6, t: 2, channels: [1] });
    const marker = screen.getByTestId("annot-offcontext-pin-here");
    expect(marker.textContent).toBe("Z 6 · T 3 · Channel 2");
  });

  it("regression: an off-context pin's marker still renders and opens its thread on click", () => {
    // Off-context is a look, not a lockout.
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
    const dot = screen.getByTestId("annot-pin-pin-here");
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(dot, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(dot, { clientX: 200, clientY: 200 });
    expect(screen.getByText("still works")).toBeTruthy();
  });

  it("a pre-slice-14 pin (no t/c) is on-context when the view is at its z and t=c=0", () => {
    // Absent t/c read as 0.
    renderOverlay({
      pins: [{ id: "old", position: [10, 20], z: 8, author: String(MY_ID), kind: "point" }],
      viewContext: { z: 8, t: 0, channels: [0] },
    });
    expect(screen.queryByTestId("annot-offcontext-old")).toBeNull();
  });

  it("only the off-context pin among several carries the marker", () => {
    renderOverlay({
      pins: [
        ownPin({ id: "pin-on", z: 3, t: 0, c: 0 }),
        ownPin({ id: "pin-off", z: 9, t: 0, c: 0 }),
      ],
      viewContext: { z: 3, t: 0, channels: [0] },
    });
    expect(screen.queryByTestId("annot-offcontext-pin-on")).toBeNull();
    expect(screen.getByTestId("annot-offcontext-pin-off")).toBeTruthy();
  });
});

describe("AnnotationOverlay — reflects re-anchored positions after a layout switch (issue #780)", () => {
  // Core re-anchors pins on SetActiveLayout; the overlay only re-reads, keyed on
  // `version`. These show the new positions appear once `version` bumps and not
  // before, so the bump is load-bearing.

  /** A scene whose `annotations()` output can be swapped, standing in for core
   * re-anchoring the pins. */
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
      viewContext: { z: 0, t: 0, channels: [0] },
      myId: MY_ID,
      sendCommand: () => {},
      onDocumentChanged: () => {},
    });
    const { rerender } = render(<AnnotationOverlay {...props(0)} />);

    runFrame();
    expect(dotTransform("p")).toBe("translate(410px, 320px)");

    // Core re-anchored the pin to (10,70). Without a version bump the overlay
    // still shows the old position.
    setPins([{ ...before[0], position: [10, 70] }]);
    rerender(<AnnotationOverlay {...props(0)} />); // same version
    runFrame();
    expect(dotTransform("p")).toBe("translate(410px, 320px)");

    // Bumping version, as App.onLayoutChange and the bridge do, re-reads.
    rerender(<AnnotationOverlay {...props(1)} />);
    runFrame();
    expect(dotTransform("p")).toBe("translate(410px, 370px)");
  });

  it("reflects a pin on a non-moving group as unchanged after a version bump", () => {
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
      viewContext: { z: 0, t: 0, channels: [0] },
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

describe("AnnotationOverlay — passive pin-select stays gentle; Go to author's view (slice 2)", () => {
  // A passive pin-select must never apply this captured view; only the explicit
  // "Go to author's view" restores it.
  const VIEW = {
    v: 1,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [999, 999], zoom: 16, viewport: [800, 600] },
    view: { z_range: { start: 7, end: 8 }, t: 2, c: 1 },
    display: { contrast_min: 0, contrast_max: 1234, gamma: 2.2 },
    dataset_order: [],
    dataset_settings: {},
  } as const;

  function pinWithView(): Annotation {
    return {
      id: "pin-v",
      position: [10, 20],
      z: 3,
      author: String(MY_ID),
      kind: "point",
      comments: [],
      view: JSON.parse(JSON.stringify(VIEW)),
    };
  }

  function renderWithGoTo(pin: Annotation) {
    const { scene, applied } = makeScene([pin]);
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = scene;
    const goToCalls: string[] = [];
    const canvas = makeCanvas();
    render(
      <AnnotationOverlay
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

  it("a plain click on a pin opens its thread but does NOT restore the author's camera/contrast/z (gentle)", () => {
    const { applied } = renderWithGoTo(pinWithView());

    fireEvent.click(screen.getByTestId("annot-pin-pin-v"));
    expect(screen.getByTestId("annot-thread-pin-v")).toBeTruthy();

    // No restore commands from a passive click.
    const types = applied.map((c) => c.type);
    expect(types).not.toContain("set_contrast");
    expect(types).not.toContain("set_gamma");
    expect(types).not.toContain("set_z_range");
    expect(types).not.toContain("set_mode_slice");
    expect(types).not.toContain("set_mode_arcball");
    expect(types).not.toContain("set_center"); // not even a recenter on passive select
  });

  it("exposes the 'Go to author's view' affordance in the thread and fires it on click", () => {
    const { goToCalls } = renderWithGoTo(pinWithView());

    fireEvent.click(screen.getByTestId("annot-pin-pin-v"));
    const goBtn = screen.getByTestId("pin-goto-author-view-pin-v");
    expect(goBtn).toBeTruthy();
    fireEvent.click(goBtn);
    expect(goToCalls).toEqual(["pin-v"]);
  });

  it("a view-less pin's thread shows NO 'Go to author's view' affordance (backward-compat)", () => {
    const noView: Annotation = {
      id: "pin-old",
      position: [10, 20],
      z: 3,
      author: String(MY_ID),
      kind: "point",
      comments: [],
    };
    renderWithGoTo(noView);
    fireEvent.click(screen.getByTestId("annot-pin-pin-old"));
    expect(screen.queryByTestId("pin-goto-author-view-pin-old")).toBeNull();
  });
});

describe("AnnotationOverlay — comment-count badge on the marker", () => {
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
    expect(screen.getByRole("button", { name: "Pin by you, 2 comments" })).toBeTruthy();
    expect(document.querySelector(".lc-annotation-count")?.textContent).toBe("2");
  });

  it("a pin with an empty thread carries no badge", () => {
    renderOverlay({ pins: [ownPin({ comments: [] })] });
    expect(screen.getByRole("button", { name: "Pin by you" })).toBeTruthy();
    expect(document.querySelector(".lc-annotation-count")).toBeNull();
  });

  it("clicking the badge opens the pin's thread (same toggle as the dot)", () => {
    renderOverlay({
      pins: [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi from 2d" }] })],
    });
    fireEvent.click(document.querySelector(".lc-annotation-count")!);
    expect(screen.getByText("hi from 2d")).toBeTruthy();
  });
});

describe("AnnotationOverlay — the marker from the keyboard", () => {
  it("is reached with Tab and opens its thread with Enter", async () => {
    const user = userEvent.setup();
    renderOverlay({
      pins: [
        ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "from the keyboard" }] }),
        ownPin({ id: "pin-b", author: "peer" }),
      ],
    });
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pin by you, 1 comment" }));
    await user.keyboard("{Enter}");
    expect(screen.getByText("from the keyboard")).toBeTruthy();
  });

  it("names a peer's pin by the peer's handle", () => {
    renderOverlay({ pins: [ownPin({ author: "peer" })] });
    expect(screen.getByRole("button", { name: `Pin by ${deriveHandle("peer")}` })).toBeTruthy();
  });
});
