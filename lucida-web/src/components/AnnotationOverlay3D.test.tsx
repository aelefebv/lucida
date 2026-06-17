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
      if (cmd.type === "move_annotation") {
        pins = pins.map((p) =>
          p.id === cmd.id
            ? { ...p, position: cmd.position as [number, number], z: cmd.z as number }
            : p,
        );
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

const MY_ID = 7;

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
  myId?: number;
  pick?: (x: number, y: number) => number[];
}) {
  const { scene, applied } = makeScene(opts.pins, opts.pick);
  const sent: Array<Record<string, unknown>> = [];
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = scene;
  let changed = 0;
  const { canvas, capturedPointers, forwardedDowns } = makeCanvas();
  render(
    <AnnotationOverlay3D
      datasetId="wds-1"
      wasmSceneRef={sceneRef}
      canvas={canvas}
      version={0}
      myId={opts.myId ?? MY_ID}
      sendCommand={(json) => sent.push(JSON.parse(json) as Record<string, unknown>)}
      onDocumentChanged={() => {
        changed += 1;
      }}
    />,
  );
  return { applied, sent, getChanged: () => changed, capturedPointers, forwardedDowns };
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

  it("a plain press on an own marker is handed to the canvas (orbit) and never moves", () => {
    // The marker must not move the pin on a plain drag — it forwards the gesture
    // to the canvas (replaying the pointerdown + transferring capture) so the
    // camera orbits as usual.
    const { sent, applied, capturedPointers, forwardedDowns } = renderOverlay({ pins: [ownPin()] });
    const marker = screen.getByTestId("annot-pin-pin-a");

    fireEvent.pointerDown(marker, { pointerId: 9, button: 0, clientX: 200, clientY: 200 });

    // No move (the pin is never moved by a plain gesture)…
    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
    expect(applied.some((c) => c.type === "move_annotation")).toBe(false);
    // …capture was transferred to the canvas so it owns the rest of the drag…
    expect(capturedPointers).toContain(9);
    // …and the pointerdown was replayed on the canvas so it starts its orbit.
    expect(forwardedDowns.some((e) => e.pointerId === 9 && !e.shiftKey)).toBe(true);
  });

  it("a peer's marker is inert — a Shift+drag emits no move", () => {
    const { sent } = renderOverlay({ pins: [ownPin({ id: "pin-b", author: "999" })] });
    const marker = screen.getByTestId("annot-pin-pin-b");

    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, shiftKey: true, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(marker, { pointerId: 1, shiftKey: true, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(marker, { pointerId: 1, shiftKey: true, clientX: 320, clientY: 280 });

    expect(sent.some((c) => c.type === "move_annotation")).toBe(false);
  });
});
