// @vitest-environment happy-dom

/**
 * Slice 19 (issue #792): the personal show/hide-all-annotations toggle.
 *
 * Two layers are covered here:
 *  1. The overlays' new `visible?: boolean` prop (default `true`) on BOTH the 2D
 *     `AnnotationOverlay` and the 3D `AnnotationOverlay3D`: when `false` the
 *     overlay renders NOTHING (no pins, no shapes, no thread popover), even for a
 *     pin that has comments; when `true` (or omitted) it renders exactly as
 *     before; and toggling `false` -> `true` re-renders the pins (hiding never
 *     mutates the annotation set).
 *  2. The App-level wiring contract: a `data-testid="annot-visibility-toggle"`
 *     button that flips a local `annotationsVisible` state passed as `visible` to
 *     the overlay. App itself stands up WASM/render/auth, so this reproduces the
 *     exact toggle pattern around a real overlay rather than mounting all of App.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay } from "./AnnotationOverlay.tsx";
import type { Annotation } from "./annotationDocument.ts";
import { AnnotationOverlay3D } from "./AnnotationOverlay3D.tsx";

const MY_ID = "7";

/** A minimal 2D scene stand-in: only the surface the 2D overlay reads. */
function make2DScene(initial: Annotation[]): WasmScene {
  const pins = JSON.parse(JSON.stringify(initial)) as Annotation[];
  return {
    annotations: (_datasetId: string) => JSON.stringify(pins),
    zoom: () => 1,
    center: () => new Float64Array([0, 0]),
    apply_command: () => {},
  } as unknown as WasmScene;
}

/** A minimal 3D scene stand-in: every vertex projects to a fixed on-screen
 * point so a marker would render when visible. */
function make3DScene(initial: Annotation[]): WasmScene {
  const pins = JSON.parse(JSON.stringify(initial)) as Annotation[];
  return {
    annotations: (_datasetId: string) => JSON.stringify(pins),
    project_annotation: () => new Float64Array([100, 100]),
    pick_annotation_voxel: () => new Float64Array([50, 60, 7]),
    apply_command: () => {},
  } as unknown as WasmScene;
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(canvas, "clientHeight", { value: 600, configurable: true });
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return canvas;
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
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe("AnnotationOverlay (2D) — visible prop (issue #792)", () => {
  function renderOverlay(pins: Annotation[], visible?: boolean) {
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = make2DScene(pins);
    const canvas = makeCanvas();
    const { rerender } = render(
      <AnnotationOverlay
        datasetId="wds-1"
        wasmSceneRef={sceneRef}
        canvas={canvas}
        version={0}
        viewContext={{ z: 3, t: 0, c: 0 }}
        myId={MY_ID}
        sendCommand={() => {}}
        onDocumentChanged={() => {}}
        visible={visible}
      />,
    );
    const setVisible = (next: boolean) =>
      rerender(
        <AnnotationOverlay
          datasetId="wds-1"
          wasmSceneRef={sceneRef}
          canvas={canvas}
          version={0}
          viewContext={{ z: 3, t: 0, c: 0 }}
          myId={MY_ID}
          sendCommand={() => {}}
          onDocumentChanged={() => {}}
          visible={next}
        />,
      );
    return { setVisible };
  }

  it("default (prop omitted): an own pin renders", () => {
    renderOverlay([ownPin()]);
    expect(screen.getByTestId("annot-pin-pin-a")).toBeTruthy();
  });

  it("visible={true}: an own pin renders", () => {
    renderOverlay([ownPin()], true);
    expect(screen.getByTestId("annot-pin-pin-a")).toBeTruthy();
  });

  it("visible={false}: no pin and no shape render", () => {
    renderOverlay(
      [
        ownPin({ id: "pt", kind: "point" }),
        ownPin({ id: "ln", kind: "line", end: [40, 50] }),
        ownPin({ id: "bx", kind: "box", end: [60, 80] }),
      ],
      false,
    );
    for (const id of ["pt", "ln", "bx"]) {
      expect(screen.queryByTestId(`annot-pin-${id}`)).toBeNull();
      expect(screen.queryByTestId(`annot-shape-${id}`)).toBeNull();
    }
  });

  it("visible={false}: a pin with comments shows no thread (and none can open)", () => {
    renderOverlay(
      [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })],
      false,
    );
    // The dot isn't even rendered, so there's nothing to click…
    expect(screen.queryByTestId("annot-pin-pin-a")).toBeNull();
    // …and certainly no open thread popover.
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
    expect(screen.queryByText("hi")).toBeNull();
  });

  it("hiding closes an already-open thread and re-showing starts clean", () => {
    const { setVisible } = renderOverlay(
      [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })],
      true,
    );
    // Open the thread with a pure click.
    const marker = screen.getByTestId("annot-pin-pin-a");
    fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(marker, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.click(marker, { clientX: 200, clientY: 200 });
    expect(screen.getByTestId("annot-thread-pin-a")).toBeTruthy();

    // Hide → nothing renders, including the thread.
    setVisible(false);
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
    expect(screen.queryByTestId("annot-pin-pin-a")).toBeNull();

    // Re-show → the pin is back, but the thread is NOT re-opened (clean baseline).
    setVisible(true);
    expect(screen.getByTestId("annot-pin-pin-a")).toBeTruthy();
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
  });

  it("toggling false -> true re-renders the pins (hiding never mutates the set)", () => {
    const { setVisible } = renderOverlay([ownPin(), ownPin({ id: "pin-b" })], false);
    // Hidden: neither pin renders.
    expect(screen.queryByTestId("annot-pin-pin-a")).toBeNull();
    expect(screen.queryByTestId("annot-pin-pin-b")).toBeNull();
    // Shown: both restored.
    setVisible(true);
    expect(screen.getByTestId("annot-pin-pin-a")).toBeTruthy();
    expect(screen.getByTestId("annot-pin-pin-b")).toBeTruthy();
  });
});

describe("AnnotationOverlay3D — visible prop (issue #792)", () => {
  function renderOverlay(pins: Annotation[], visible?: boolean) {
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = make3DScene(pins);
    const canvas = makeCanvas();
    const { rerender } = render(
      <AnnotationOverlay3D
        datasetId="wds-1"
        wasmSceneRef={sceneRef}
        canvas={canvas}
        version={0}
        viewContext={{ z: 3, t: 0, c: 0 }}
        myId={MY_ID}
        sendCommand={() => {}}
        onDocumentChanged={() => {}}
        visible={visible}
      />,
    );
    const setVisible = (next: boolean) =>
      rerender(
        <AnnotationOverlay3D
          datasetId="wds-1"
          wasmSceneRef={sceneRef}
          canvas={canvas}
          version={0}
          viewContext={{ z: 3, t: 0, c: 0 }}
          myId={MY_ID}
          sendCommand={() => {}}
          onDocumentChanged={() => {}}
          visible={next}
        />,
      );
    return { setVisible };
  }

  it("default (prop omitted): a pin marker renders", () => {
    renderOverlay([ownPin()]);
    expect(screen.getByTestId("annot-pin-pin-a")).toBeTruthy();
  });

  it("visible={false}: no pin marker renders", () => {
    renderOverlay([ownPin()], false);
    expect(screen.queryByTestId("annot-pin-pin-a")).toBeNull();
  });

  it("visible={false}: a pin with comments shows no thread", () => {
    renderOverlay(
      [ownPin({ comments: [{ id: "c1", author: String(MY_ID), text: "hi" }] })],
      false,
    );
    expect(screen.queryByTestId("annot-pin-pin-a")).toBeNull();
    expect(screen.queryByTestId("annot-thread-pin-a")).toBeNull();
  });

  it("toggling false -> true re-renders the marker", () => {
    const { setVisible } = renderOverlay([ownPin()], false);
    expect(screen.queryByTestId("annot-pin-pin-a")).toBeNull();
    setVisible(true);
    expect(screen.getByTestId("annot-pin-pin-a")).toBeTruthy();
  });
});

describe("toolbar toggle wiring (issue #792) — button flips overlay visibility", () => {
  /** Reproduces App.tsx's exact wiring: a local `annotationsVisible` state, the
   * `annot-visibility-toggle` button that flips it, and a 2D overlay fed
   * `visible={annotationsVisible}`. This pins the contract (button -> state ->
   * visible -> overlay) without standing up all of App's WASM/render/auth. */
  function Harness() {
    const [annotationsVisible, setAnnotationsVisible] = useState(true);
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = make2DScene([ownPin()]);
    const canvas = makeCanvas();
    return (
      <>
        <button
          data-testid="annot-visibility-toggle"
          onClick={() => setAnnotationsVisible((v) => !v)}
          aria-pressed={!annotationsVisible}
          aria-label={annotationsVisible ? "Hide annotations" : "Show annotations"}
        >
          {annotationsVisible ? "Hide Annotations" : "Show Annotations"}
        </button>
        <AnnotationOverlay
          datasetId="wds-1"
          wasmSceneRef={sceneRef}
          canvas={canvas}
          version={0}
          viewContext={{ z: 3, t: 0, c: 0 }}
          myId={MY_ID}
          sendCommand={() => {}}
          onDocumentChanged={() => {}}
          visible={annotationsVisible}
        />
      </>
    );
  }

  it("starts shown, hides on first click, restores on second", () => {
    render(<Harness />);
    const btn = screen.getByTestId("annot-visibility-toggle");

    // Default: shown.
    expect(screen.getByTestId("annot-pin-pin-a")).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBe("Hide annotations");

    // Click → hidden: the pin is gone and the label reflects the next action.
    fireEvent.click(btn);
    expect(screen.queryByTestId("annot-pin-pin-a")).toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("Show annotations");

    // Click again → restored.
    fireEvent.click(btn);
    expect(screen.getByTestId("annot-pin-pin-a")).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBe("Hide annotations");
  });
});
