// @vitest-environment happy-dom

import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { useAnnotationOverlay } from "./useAnnotationOverlay.ts";
import type { Annotation } from "./annotationDocument.ts";

/** A scene stub whose pin set can be swapped between reads, keyed by dataset so
 * a dataset switch reads that dataset's own pins. */
function makeScene(byDataset: Record<string, Annotation[]>): {
  scene: WasmScene;
  setPins: (datasetId: string, pins: Annotation[]) => void;
} {
  const state = { ...byDataset };
  const scene = {
    annotations: (datasetId: string) => JSON.stringify(state[datasetId] ?? []),
  } as unknown as WasmScene;
  return {
    scene,
    setPins: (datasetId, pins) => {
      state[datasetId] = pins;
    },
  };
}

function pin(id: string): Annotation {
  return { id, position: [1, 2], author: "7", kind: "point" };
}

function renderOverlayState(opts: {
  scene: WasmScene;
  datasetIds?: string[];
  version?: number;
  visible?: boolean;
}) {
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = opts.scene;
  return renderHook(
    (props: { datasetIds: string[]; version: number; visible: boolean }) =>
      useAnnotationOverlay({ wasmSceneRef: sceneRef, ...props }),
    {
      initialProps: {
        datasetIds: opts.datasetIds ?? ["wds-1"],
        version: opts.version ?? 0,
        visible: opts.visible ?? true,
      },
    },
  );
}

/** Each mark as `dataset/pin`. */
function named(marks: { datasetId: string; pin: Annotation }[]): string[] {
  return marks.map(({ datasetId, pin }) => `${datasetId}/${pin.id}`);
}

describe("useAnnotationOverlay — authoritative read", () => {
  it("reads the dataset's pins on mount (and mirrors them into marksRef)", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a"), pin("pin-b")] });
    const { result } = renderOverlayState({ scene });
    expect(named(result.current.marks)).toEqual(["wds-1/pin-a", "wds-1/pin-b"]);
    expect(result.current.marksRef.current).toBe(result.current.marks);
  });

  it("reads every dataset's pins, in the order the view draws them, each with its dataset", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")], "wds-2": [pin("pin-z"), pin("pin-y")] });
    const { result } = renderOverlayState({ scene, datasetIds: ["wds-2", "wds-1"] });
    expect(named(result.current.marks)).toEqual(["wds-2/pin-z", "wds-2/pin-y", "wds-1/pin-a"]);
  });

  it("re-reads when the document version bumps", () => {
    const { scene, setPins } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    setPins("wds-1", [pin("pin-a"), pin("pin-c")]);
    // No re-read yet — the tick never re-reads; only a version bump does.
    expect(result.current.marks).toHaveLength(1);
    rerender({ datasetIds: ["wds-1"], version: 1, visible: true });
    expect(named(result.current.marks)).toEqual(["wds-1/pin-a", "wds-1/pin-c"]);
  });

  it("re-reads when the view's datasets change", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")], "wds-2": [pin("pin-z")] });
    const { result, rerender } = renderOverlayState({ scene });
    rerender({ datasetIds: ["wds-1", "wds-2"], version: 0, visible: true });
    expect(named(result.current.marks)).toEqual(["wds-1/pin-a", "wds-2/pin-z"]);
    rerender({ datasetIds: ["wds-2"], version: 0, visible: true });
    expect(named(result.current.marks)).toEqual(["wds-2/pin-z"]);
  });

  it("keeps the same marks when the list is rebuilt with the same datasets", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    const marks = result.current.marks;
    rerender({ datasetIds: ["wds-1"], version: 0, visible: true });
    expect(result.current.marks).toBe(marks);
  });

  it("an unready scene reads as an empty set (no throw)", () => {
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = null;
    const { result } = renderHook(() =>
      useAnnotationOverlay({ wasmSceneRef: sceneRef, datasetIds: ["wds-1"], version: 0, visible: true }),
    );
    expect(result.current.marks).toEqual([]);
  });
});

describe("useAnnotationOverlay — open-thread lifecycle", () => {
  it("keeps the open pin while it exists", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    act(() => result.current.setOpenPinId("pin-a"));
    rerender({ datasetIds: ["wds-1"], version: 1, visible: true });
    expect(result.current.openPinId).toBe("pin-a");
  });

  it("closes the thread when its pin vanishes from the set", () => {
    const { scene, setPins } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    act(() => result.current.setOpenPinId("pin-a"));
    setPins("wds-1", []);
    rerender({ datasetIds: ["wds-1"], version: 1, visible: true });
    expect(result.current.openPinId).toBeNull();
  });

  it("keeps the thread and selection when another dataset joins the view", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")], "wds-2": [pin("pin-z")] });
    const { result, rerender } = renderOverlayState({ scene });
    act(() => {
      result.current.setOpenPinId("pin-a");
      result.current.setSelectedId("pin-a");
    });
    rerender({ datasetIds: ["wds-1", "wds-2"], version: 0, visible: true });
    expect(result.current.openPinId).toBe("pin-a");
    expect(result.current.selectedId).toBe("pin-a");
  });

  it("closes the thread and selection when their dataset leaves the view", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")], "wds-2": [pin("pin-z")] });
    const { result, rerender } = renderOverlayState({ scene, datasetIds: ["wds-1", "wds-2"] });
    act(() => {
      result.current.setOpenPinId("pin-a");
      result.current.setSelectedId("pin-a");
    });
    rerender({ datasetIds: ["wds-2"], version: 0, visible: true });
    expect(result.current.openPinId).toBeNull();
    expect(result.current.selectedId).toBeNull();
  });

  it("hiding the overlay closes the thread but never mutates the pin set", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    act(() => result.current.setOpenPinId("pin-a"));
    rerender({ datasetIds: ["wds-1"], version: 0, visible: false });
    expect(result.current.openPinId).toBeNull();
    expect(named(result.current.marks)).toEqual(["wds-1/pin-a"]);
    // Re-showing re-renders the untouched set from a clean baseline.
    rerender({ datasetIds: ["wds-1"], version: 0, visible: true });
    expect(result.current.openPinId).toBeNull();
    expect(named(result.current.marks)).toEqual(["wds-1/pin-a"]);
  });
});
