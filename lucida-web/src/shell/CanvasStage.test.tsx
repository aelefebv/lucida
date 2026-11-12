// @vitest-environment happy-dom
/**
 * A card drawn through `AboveControls` covers the floating controls without
 * lifting the layers, whose views' panes would then take the controls'
 * presses.
 */
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AboveControls, CanvasStage } from "./CanvasStage.tsx";

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
