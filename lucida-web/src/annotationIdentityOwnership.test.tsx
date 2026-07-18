// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { AnnotationOverlay } from "./components/AnnotationOverlay.tsx";
import type { Annotation } from "./components/annotationDocument.ts";
import {
  annotationAuthorId,
  __resetAnnotationIdentityForTesting,
} from "./annotationIdentity.ts";

const viewport = { apply: () => true, endGesture: () => {} };

// Minimal WasmScene stub: the overlay only reads annotations() (per dataset)
// plus zoom()/center() each RAF frame for projection. Everything else the
// component touches is null-guarded.
function stubScene(annotations: Annotation[]): WasmScene {
  return {
    annotations: () => JSON.stringify(annotations),
    zoom: () => 1,
    center: () => [0, 0] as [number, number],
  } as unknown as WasmScene;
}

beforeEach(() => {
  localStorage.clear();
  __resetAnnotationIdentityForTesting();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  __resetAnnotationIdentityForTesting();
});

describe("ownership with a string identity (annotationAuthorId)", () => {
  it("a pin authored by this browser's identity is mine; another id's is not", async () => {
    const me = annotationAuthorId();
    const other = `${me}-someone-else`;
    expect(other).not.toBe(me);

    const annotations: Annotation[] = [
      { id: "mine", position: [0, 0], author: me, kind: "point" },
      { id: "theirs", position: [10, 10], author: other, kind: "point" },
    ];

    const sceneRef = createRef<WasmScene | null>();
    (sceneRef as { current: WasmScene | null }).current = stubScene(annotations);
    const canvas = document.createElement("canvas");

    const { findByTestId } = render(
      <AnnotationOverlay
        datasetId="ds-1"
        wasmSceneRef={sceneRef}
        canvas={canvas}
        version={1}
        viewContext={{ z: 0, t: 0, c: 0 }}
        myId={me}
        sendCommand={() => {}}
        onDocumentChanged={() => {}}
        viewport={viewport}
      />,
    );

    // The own pin advertises the author-only affordance in its title; the peer
    // pin shows the other author's id and no "by you".
    const minePin = await findByTestId("annot-pin-mine");
    const theirsPin = await findByTestId("annot-pin-theirs");

    await waitFor(() => {
      expect(minePin.getAttribute("title")).toContain("Pin by you");
    });
    expect(theirsPin.getAttribute("title")).toContain(`Pin by ${other}`);
    expect(theirsPin.getAttribute("title")).not.toContain("Pin by you");
  });

  it("rejoin: a pin authored under a persisted id is still mine after a reconnect", async () => {
    // A prior session persisted this browser's id and authored a pin with it.
    const persisted = "persisted-author-xyz";
    localStorage.setItem("lucida.annotation.author", persisted);

    // "Rejoin": a fresh resolve (cold cache) reads the persisted id back.
    __resetAnnotationIdentityForTesting();
    const me = annotationAuthorId();
    expect(me).toBe(persisted);

    const annotations: Annotation[] = [
      { id: "old", position: [0, 0], author: persisted, kind: "point" },
    ];
    const sceneRef = createRef<WasmScene | null>();
    (sceneRef as { current: WasmScene | null }).current = stubScene(annotations);
    const canvas = document.createElement("canvas");

    const { findByTestId } = render(
      <AnnotationOverlay
        datasetId="ds-1"
        wasmSceneRef={sceneRef}
        canvas={canvas}
        version={1}
        viewContext={{ z: 0, t: 0, c: 0 }}
        myId={me}
        sendCommand={() => {}}
        onDocumentChanged={() => {}}
        viewport={viewport}
      />,
    );

    const pin = await findByTestId("annot-pin-old");
    await waitFor(() => {
      expect(pin.getAttribute("title")).toContain("Pin by you");
    });
  });
});
