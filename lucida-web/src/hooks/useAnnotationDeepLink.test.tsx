// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useAnnotationDeepLink } from "./useAnnotationDeepLink.ts";
import type { AnnotationDocScene } from "../savedView/annotationDeepLink.ts";
import type { Annotation } from "../components/annotationDocument.ts";

function pin(id: string): Annotation {
  return {
    id,
    position: [1, 2],
    z: 3,
    author: "someone",
    kind: "point",
    comments: [],
  };
}

/** A scene whose document can be swapped between renders, to simulate the
 *  snapshot landing after the scene appears. */
function makeScene(byDataset: Record<string, Annotation[]>): AnnotationDocScene {
  return {
    annotation_dataset_ids: () => JSON.stringify(Object.keys(byDataset)),
    annotations: (datasetId: string) =>
      JSON.stringify(byDataset[datasetId] ?? []),
  };
}

afterEach(() => cleanup());

describe("useAnnotationDeepLink — TIMING", () => {
  it("does NOT resolve before annotations are available, and DOES once the doc loads", () => {
    // Like the host, run the collapse in the restore's tail.
    const collapse = vi.fn();
    const restore = vi.fn(
      (_pin: Annotation, _datasetId: string, onRestored: () => void) => {
        onRestored();
      },
    );
    const notFound = vi.fn();

    // Scene present, document still empty: the window before the snapshot.
    let scene: AnnotationDocScene | null = makeScene({});

    const { rerender } = renderHook(
      ({ docVersion }: { docVersion: number }) =>
        useAnnotationDeepLink({
          getScene: () => scene,
          docVersion,
          getHash: () => "#a=p-target",
          onRestore: restore,
          onCollapseHash: collapse,
          onNotFound: notFound,
        }),
      { initialProps: { docVersion: 0 } },
    );

    // Resolving now would focus a pin that isn't loaded yet.
    expect(restore).not.toHaveBeenCalled();
    expect(notFound).toHaveBeenLastCalledWith(true);

    // The snapshot lands with the pin and the bridge bumps the doc version.
    scene = makeScene({ "wds-1": [pin("p-other"), pin("p-target")] });
    rerender({ docVersion: 1 });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-target" }),
      "wds-1",
      expect.any(Function),
    );
    expect(collapse).toHaveBeenCalledTimes(1);
    expect(notFound).toHaveBeenLastCalledWith(false);
  });

  it("defers the collapse to onRestore's tail — never collapses before the restore applies", () => {
    // onRestore holds the collapse without calling it, simulating a restore
    // deferred a frame. Collapsing early would write a stale camera to the URL.
    let deferredCollapse: (() => void) | null = null;
    const restore = vi.fn(
      (_pin: Annotation, _datasetId: string, onRestored: () => void) => {
        deferredCollapse = onRestored;
      },
    );
    const collapse = vi.fn();
    const scene = makeScene({ "wds-1": [pin("p-target")] });

    renderHook(() =>
      useAnnotationDeepLink({
        getScene: () => scene,
        docVersion: 1,
        getHash: () => "#a=p-target",
        onRestore: restore,
        onCollapseHash: collapse,
        onNotFound: () => {},
      }),
    );

    expect(restore).toHaveBeenCalledTimes(1);
    expect(collapse).not.toHaveBeenCalled();

    // The host applies the restore and fires the tail.
    expect(deferredCollapse).not.toBeNull();
    deferredCollapse!();
    expect(collapse).toHaveBeenCalledTimes(1);
  });

  it("fires the restore ONCE per link — a later doc bump (peer comment) does not re-yank", () => {
    const restore = vi.fn();
    const scene = makeScene({ "wds-1": [pin("p-target")] });

    const { rerender } = renderHook(
      ({ docVersion }: { docVersion: number }) =>
        useAnnotationDeepLink({
          getScene: () => scene,
          docVersion,
          getHash: () => "#a=p-target",
          onRestore: restore,
          onCollapseHash: () => {},
          onNotFound: () => {},
        }),
      { initialProps: { docVersion: 1 } },
    );

    expect(restore).toHaveBeenCalledTimes(1);

    // A peer's comments bump the doc version again.
    rerender({ docVersion: 2 });
    rerender({ docVersion: 3 });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("a pin that arrives in a LATER bump still resolves (not-found didn't wedge it)", () => {
    const restore = vi.fn();
    const notFound = vi.fn();
    let scene = makeScene({}); // empty at first

    const { rerender } = renderHook(
      ({ docVersion }: { docVersion: number }) =>
        useAnnotationDeepLink({
          getScene: () => scene,
          docVersion,
          getHash: () => "#a=p-late",
          onRestore: restore,
          onCollapseHash: () => {},
          onNotFound: notFound,
        }),
      { initialProps: { docVersion: 0 } },
    );

    expect(restore).not.toHaveBeenCalled();
    expect(notFound).toHaveBeenLastCalledWith(true);

    // A peer creates the pin live.
    scene = makeScene({ "wds-1": [pin("p-late")] });
    rerender({ docVersion: 1 });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(notFound).toHaveBeenLastCalledWith(false);
  });

  it("is inert when there is no #a= hash", () => {
    const restore = vi.fn();
    const notFound = vi.fn();
    const scene = makeScene({ "wds-1": [pin("p-x")] });

    renderHook(() =>
      useAnnotationDeepLink({
        getScene: () => scene,
        docVersion: 1,
        getHash: () => "#view=abc",
        onRestore: restore,
        onCollapseHash: () => {},
        onNotFound: notFound,
      }),
    );

    expect(restore).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("waits for the scene: no resolve while getScene() returns null", () => {
    const restore = vi.fn();
    const notFound = vi.fn();

    renderHook(() =>
      useAnnotationDeepLink({
        getScene: () => null,
        docVersion: 1,
        getHash: () => "#a=p-x",
        onRestore: restore,
        onCollapseHash: () => {},
        onNotFound: notFound,
      }),
    );

    expect(restore).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});
