// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { WasmScene } from "lucida-core";
import { ThreadPopover } from "./ThreadPopover.tsx";
import type { Annotation } from "./AnnotationOverlay.tsx";
import { SAVED_VIEW_VERSION, type SavedView } from "../savedView/types.ts";

const MY_ID = "7";

/** A trivial scene stub — ThreadPopover only calls apply_command for mutations,
 * and the "Go to author's view" path never mutates the document. */
function makeScene(): WasmScene {
  return {
    apply_command: () => {},
  } as unknown as WasmScene;
}

function capturedView(): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [10, 20], zoom: 4, viewport: [800, 600] },
    view: { z_range: { start: 3, end: 4 }, t: 1, c: 0 },
    display: { contrast_min: 0, contrast_max: 1000, gamma: 1.2 },
    dataset_order: [],
    dataset_settings: {},
  };
}

function renderThread(pin: Annotation, onGoToAuthorView?: (id: string) => void) {
  const sceneRef = createRef<WasmScene | null>();
  sceneRef.current = makeScene();
  render(
    <ThreadPopover
      pin={pin}
      datasetId="wds-1"
      myId={MY_ID}
      wasmSceneRef={sceneRef}
      sendCommand={() => {}}
      onDocumentChanged={() => {}}
      onClose={() => {}}
      onGoToAuthorView={onGoToAuthorView}
    />,
  );
}

beforeEach(() => {
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true });
});
afterEach(() => cleanup());

describe("ThreadPopover — Go to author's view affordance (slice 2)", () => {
  it("renders the affordance ONLY when the pin carries a captured view", () => {
    const withView: Annotation = {
      id: "pin-v",
      position: [10, 20],
      z: 3,
      author: "someone-else",
      kind: "point",
      comments: [],
      view: capturedView(),
    };
    renderThread(withView);
    expect(screen.getByTestId("pin-goto-author-view-pin-v")).toBeTruthy();
  });

  it("does NOT render the affordance for a view-less (older) pin", () => {
    const noView: Annotation = {
      id: "pin-old",
      position: [10, 20],
      z: 3,
      author: "someone-else",
      kind: "point",
      comments: [],
      // no `view`
    };
    renderThread(noView);
    expect(screen.queryByTestId("pin-goto-author-view-pin-old")).toBeNull();
  });

  it("fires onGoToAuthorView(pinId) when clicked", () => {
    const calls: string[] = [];
    const withView: Annotation = {
      id: "pin-v",
      position: [10, 20],
      z: 3,
      author: "someone-else",
      kind: "point",
      comments: [],
      view: capturedView(),
    };
    renderThread(withView, (id) => calls.push(id));
    fireEvent.click(screen.getByTestId("pin-goto-author-view-pin-v"));
    expect(calls).toEqual(["pin-v"]);
  });

  it("offers the affordance to ANY viewer (not just the pin's author)", () => {
    // A pin authored by someone else still gets the button — restoring the
    // author's view is a read action available to everyone.
    const calls: string[] = [];
    const othersPin: Annotation = {
      id: "pin-o",
      position: [1, 2],
      z: 0,
      author: "not-me",
      kind: "point",
      comments: [],
      view: capturedView(),
    };
    renderThread(othersPin, (id) => calls.push(id));
    const btn = screen.getByTestId("pin-goto-author-view-pin-o");
    fireEvent.click(btn);
    expect(calls).toEqual(["pin-o"]);
  });
});
