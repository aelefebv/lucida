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
  datasetId?: string;
  version?: number;
  visible?: boolean;
}) {
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = opts.scene;
  return renderHook(
    (props: { datasetId: string; version: number; visible: boolean }) =>
      useAnnotationOverlay({ wasmSceneRef: sceneRef, ...props }),
    {
      initialProps: {
        datasetId: opts.datasetId ?? "wds-1",
        version: opts.version ?? 0,
        visible: opts.visible ?? true,
      },
    },
  );
}

describe("useAnnotationOverlay — authoritative read", () => {
  it("reads the dataset's pin set on mount (and mirrors it into annotationsRef)", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a"), pin("pin-b")] });
    const { result } = renderOverlayState({ scene });
    expect(result.current.annotations.map((p) => p.id)).toEqual(["pin-a", "pin-b"]);
    expect(result.current.annotationsRef.current).toBe(result.current.annotations);
  });

  it("re-reads when the document version bumps", () => {
    const { scene, setPins } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    setPins("wds-1", [pin("pin-a"), pin("pin-c")]);
    // No re-read yet — the tick never re-reads; only a version bump does.
    expect(result.current.annotations).toHaveLength(1);
    rerender({ datasetId: "wds-1", version: 1, visible: true });
    expect(result.current.annotations.map((p) => p.id)).toEqual(["pin-a", "pin-c"]);
  });

  it("re-reads when the scoped dataset changes", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")], "wds-2": [pin("pin-z")] });
    const { result, rerender } = renderOverlayState({ scene });
    rerender({ datasetId: "wds-2", version: 0, visible: true });
    expect(result.current.annotations.map((p) => p.id)).toEqual(["pin-z"]);
  });

  it("an unready scene reads as an empty set (no throw)", () => {
    const sceneRef = createRef<WasmScene | null>();
    sceneRef.current = null;
    const { result } = renderHook(() =>
      useAnnotationOverlay({ wasmSceneRef: sceneRef, datasetId: "wds-1", version: 0, visible: true }),
    );
    expect(result.current.annotations).toEqual([]);
  });
});

describe("useAnnotationOverlay — open-thread lifecycle", () => {
  it("keeps the open pin while it exists", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    act(() => result.current.setOpenPinId("pin-a"));
    rerender({ datasetId: "wds-1", version: 1, visible: true });
    expect(result.current.openPinId).toBe("pin-a");
  });

  it("closes the thread when its pin vanishes from the set", () => {
    const { scene, setPins } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    act(() => result.current.setOpenPinId("pin-a"));
    setPins("wds-1", []);
    rerender({ datasetId: "wds-1", version: 1, visible: true });
    expect(result.current.openPinId).toBeNull();
  });

  it("closes the thread when the dataset switches (even if the id exists there too)", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")], "wds-2": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    act(() => result.current.setOpenPinId("pin-a"));
    rerender({ datasetId: "wds-2", version: 0, visible: true });
    expect(result.current.openPinId).toBeNull();
  });

  it("hiding the overlay closes the thread but never mutates the pin set", () => {
    const { scene } = makeScene({ "wds-1": [pin("pin-a")] });
    const { result, rerender } = renderOverlayState({ scene });
    act(() => result.current.setOpenPinId("pin-a"));
    rerender({ datasetId: "wds-1", version: 0, visible: false });
    expect(result.current.openPinId).toBeNull();
    expect(result.current.annotations.map((p) => p.id)).toEqual(["pin-a"]);
    // Re-showing re-renders the untouched set from a clean baseline.
    rerender({ datasetId: "wds-1", version: 0, visible: true });
    expect(result.current.openPinId).toBeNull();
    expect(result.current.annotations.map((p) => p.id)).toEqual(["pin-a"]);
  });
});
