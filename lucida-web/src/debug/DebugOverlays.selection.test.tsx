// @vitest-environment happy-dom

/**
 * The overlay layer and the published selection: the layer mounts for a set
 * the moment one is published, captions it, and unmounts when it is cleared,
 * with no dock anywhere in the test. The set reaches it through the
 * published slot alone.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { selectChunks } from "../trace/diagnose/chunkSelection.ts";
import { lateStallOpen } from "../trace/diagnose/fixtures.ts";
import { publishChunkSelection } from "../trace/linkedSelection.ts";
import { DebugOverlays } from "./DebugOverlays.tsx";

/** The layer over a viewer with no scene yet, so nothing projects and no cell is drawn. */
function mount() {
  return render(
    <DebugOverlays
      wasmSceneRef={{ current: null }}
      canvasRef={{ current: document.createElement("canvas") }}
      datasets={new Map()}
      renderLoopRef={{ current: null }}
      cpuCache={null}
      viewMode="2d"
    />,
  );
}

afterEach(() => {
  cleanup();
  publishChunkSelection(null);
  window.localStorage.removeItem("debug.overlays");
});

describe("the overlay layer and the published selection", () => {
  it("draws nothing with every toggle off and no set published", () => {
    const view = mount();

    expect(view.container.firstChild).toBeNull();
  });

  it("mounts for a published set, captions it, and goes when the set is cleared", () => {
    const view = mount();
    const selection = selectChunks(lateStallOpen(), { startMs: 1_100, endMs: 2_000 });

    act(() => {
      publishChunkSelection(selection);
    });

    const caption = screen.getByTestId("overlay-selection").textContent ?? "";
    expect(caption).toContain("brushed 1100..2000 ms of run late-stall");
    // No scene, so no cell is on screen, and the caption says so rather
    // than reading as an empty set.
    expect(caption).toContain("none of the 40 chunks");

    act(() => {
      publishChunkSelection(null);
    });

    expect(view.container.firstChild).toBeNull();
  });
});
