// @vitest-environment happy-dom
/**
 * A card drawn through `AboveControls` covers the floating controls without
 * lifting the layers, whose views' panes would then take the controls'
 * presses.
 */
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AboveControls, CanvasStage } from "./CanvasStage.tsx";
import { frameClock } from "../frameClock.ts";

afterEach(cleanup);

function stage() {
  return render(
    <CanvasStage
      canvasRef={createRef()}
      canvasKey={0}
      pixelated={false}
      label="View"
      slots={{ "bottom-center": <button type="button">Control</button> }}
    >
      <div className="pane" />
      <AboveControls>
        <div role="tooltip">Readout</div>
      </AboveControls>
    </CanvasStage>,
  );
}

describe("AboveControls", () => {
  it("draws its children over the slots, outside the layers", () => {
    const { container } = stage();
    const layers = container.querySelector(".lc-canvas-stage-layers")!;
    const slots = container.querySelector(".lc-canvas-stage-slots")!;
    const card = screen.getByRole("tooltip");
    expect(card.closest(".lc-canvas-stage-above")).not.toBeNull();
    // A tooltip in the layers lifts them, panes and all, over the controls.
    expect(layers.querySelector('[role="tooltip"]')).toBeNull();
    expect(layers.querySelector(".pane")).not.toBeNull();
    expect(slots.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws in place outside a stage", () => {
    const { container } = render(
      <div className="host">
        <AboveControls>
          <span>Card</span>
        </AboveControls>
      </div>,
    );
    expect(container.querySelector(".host")?.textContent).toBe("Card");
  });
});

describe("CanvasStage's size", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows a ratio that changes with no event to say so, either way", () => {
    // Neither the device-pixel box nor a resolution query fires, as under
    // device emulation; only the ratio itself changes.
    class SilentObserver {
      observe() {}
      disconnect() {}
    }
    const silentQuery = { addEventListener() {}, removeEventListener() {} };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("ResizeObserver", SilentObserver);
    vi.stubGlobal("matchMedia", () => silentQuery);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("devicePixelRatio", 2);
    const onResize = vi.fn();
    render(<CanvasStage canvasRef={createRef()} canvasKey={0} pixelated={false} label="View" onResize={onResize} />);
    const frame = () =>
      act(() => {
        frameClock.wake();
        for (const run of frames.splice(0)) run(performance.now());
      });

    frame();
    expect(onResize).not.toHaveBeenCalled();
    vi.stubGlobal("devicePixelRatio", 1);
    frame();
    expect(onResize).toHaveBeenCalledTimes(1);
    frame();
    expect(onResize).toHaveBeenCalledTimes(1);
    vi.stubGlobal("devicePixelRatio", 2);
    frame();
    expect(onResize).toHaveBeenCalledTimes(2);
  });
});
