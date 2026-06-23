// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useAnnotationDeepLink } from "./useAnnotationDeepLink.ts";
import type { AnnotationDocScene } from "../savedView/annotationDeepLink.ts";
import type { Annotation } from "../components/AnnotationOverlay.tsx";

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

/** A scene whose annotated document can be swapped between renders to simulate
 *  the doc snapshot landing AFTER the scene appears. */
function makeScene(byDataset: Record<string, Annotation[]>): AnnotationDocScene {
  return {
    annotation_dataset_ids: () => JSON.stringify(Object.keys(byDataset)),
    annotations: (datasetId: string) =>
      JSON.stringify(byDataset[datasetId] ?? []),
  };
}

afterEach(() => cleanup());

describe("useAnnotationDeepLink — TIMING (slice 3, the #802 class)", () => {
  it("does NOT resolve before annotations are available, and DOES once the doc loads", () => {
    // The host runs the collapse (3rd arg) in the restore's tail; mirror that
    // here so the collapse-after-restore wiring is exercised end-to-end.
    const collapse = vi.fn();
    const restore = vi.fn(
      (_pin: Annotation, _datasetId: string, onRestored: () => void) => {
        onRestored();
      },
    );
    const notFound = vi.fn();

    // Start: scene present but the document is EMPTY (snapshot not yet applied),
    // mirroring the window between scene-bootstrap and doc-load.
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

    // BEFORE annotations are available: no restore (the pin isn't loaded yet).
    // This is the #802 guard — resolving here would focus an unloaded pin.
    expect(restore).not.toHaveBeenCalled();
    // The empty doc reports the pin as not-found (graceful, non-blocking).
    expect(notFound).toHaveBeenLastCalledWith(true);

    // NOW the workspace document snapshot lands carrying the pin, and the bridge
    // bumps the doc version. The hook re-checks and resolves.
    scene = makeScene({ "wds-1": [pin("p-other"), pin("p-target")] });
    rerender({ docVersion: 1 });

    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-target" }),
      "wds-1",
      expect.any(Function),
    );
    // Hash collapsed to live #view= form, like #b= — but only because the host
    // (restore mock) invoked the collapse in its tail, after the restore.
    expect(collapse).toHaveBeenCalledTimes(1);
    // The not-found notice is cleared on success.
    expect(notFound).toHaveBeenLastCalledWith(false);
  });

  it("defers the collapse to onRestore's tail — never collapses before the restore applies", () => {
    // STALE-URL guard (slice 3): the hook must NOT collapse `#a=`→`#view=`
    // itself. It hands the collapse to onRestore, which the host runs only AFTER
    // the (possibly frame-deferred) restore applies. Here onRestore captures the
    // collapse WITHOUT invoking it, simulating a deferred restore — so the hash
    // must remain uncollapsed until the host fires it.
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

    // The restore was requested, but since the host hasn't applied it yet, the
    // hook must NOT have collapsed the hash (that would snapshot a stale frame).
    expect(restore).toHaveBeenCalledTimes(1);
    expect(collapse).not.toHaveBeenCalled();

    // The host now applies the restore and fires the tail — collapse happens.
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

    // A peer adds a comment → another doc-version bump. Must NOT restore again.
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

    // The pin shows up two bumps later (e.g. a peer created it live).
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
