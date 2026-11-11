// @vitest-environment happy-dom
/**
 * Each view has a pane over its rectangle. A press or a wheel in a view makes
 * it active first; hovering never does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ViewPane } from "../sceneStore.ts";
import { ViewPanes } from "./ViewPanes.tsx";
import { DATASET_DRAG_TYPE, isViewPane } from "./viewPane.ts";
import { coverageMessage } from "./coverage.ts";

afterEach(cleanup);

const LEFT: ViewPane = {
  id: 0, shows: "all", draws: ["a"], rect: [0, 0, 0.5, 1], cameraMode: "slice", active: true, setAside: [],
};
const RIGHT: ViewPane = {
  id: 3, shows: [], draws: [], rect: [0.5, 0, 0.5, 1], cameraMode: "arcball", active: false, setAside: [],
};

function panes(views: ViewPane[], maximized: number | null = null) {
  const actions = { activate: vi.fn(), maximize: vi.fn(), move: vi.fn() };
  const { activate } = actions;
  const rendered = render(
    <ViewPanes views={views} maximized={maximized} actions={actions}>
      {(pane, surface) => <span data-testid={`content-${pane.id}`} data-view={surface.view} />}
    </ViewPanes>,
  );
  const pane = (id: number) => rendered.container.querySelector(`[data-view-pane="${id}"]`) as HTMLElement;
  return { actions, activate, pane, rendered };
}

describe("a view's pane", () => {
  it("sits over its rectangle and holds what the view draws over it", () => {
    const { pane, rendered } = panes([LEFT, RIGHT]);
    expect(pane(3).style.left).toBe("50%");
    expect(pane(3).style.width).toBe("50%");
    expect(rendered.getByTestId("content-3").dataset.view).toBe("3");
    expect(isViewPane(pane(3))).toBe(true);
    expect(isViewPane(rendered.getByTestId("content-3"))).toBe(false);
  });

  it("makes its view active on a press or a wheel, and never on a hover", () => {
    const { activate, pane } = panes([LEFT, RIGHT]);
    fireEvent.pointerMove(pane(3));
    expect(activate).not.toHaveBeenCalled();
    fireEvent.pointerDown(pane(3));
    expect(activate).toHaveBeenCalledWith(3);
    fireEvent.wheel(pane(3));
    expect(activate).toHaveBeenCalledTimes(2);
    // The active view is already the one commands steer.
    fireEvent.pointerDown(pane(0));
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("outlines the active view only when there are several", () => {
    expect(panes([LEFT, RIGHT]).pane(0).dataset.active).toBe("");
    cleanup();
    expect(panes([{ ...LEFT, rect: [0, 0, 1, 1] }]).pane(0).dataset.active).toBeUndefined();
  });
});

describe("with several views", () => {
  it("shows one alone on a double click, and all again on the next", () => {
    const { actions, pane } = panes([LEFT, RIGHT]);
    fireEvent.doubleClick(pane(3));
    expect(actions.maximize).toHaveBeenCalledWith(3);
    cleanup();
    const alone = panes([{ ...RIGHT, rect: [0, 0, 1, 1] }], 3);
    fireEvent.doubleClick(alone.pane(3));
    expect(alone.actions.maximize).toHaveBeenCalledWith(null);
  });

  it("leaves a finger's double tap to the view", () => {
    const { actions, pane } = panes([LEFT, RIGHT]);
    fireEvent.pointerDown(pane(3), { pointerType: "touch" });
    fireEvent.doubleClick(pane(3));
    expect(actions.maximize).not.toHaveBeenCalled();
  });

  it("moves a layer dropped on a view there, and asks an empty view for one", () => {
    const { actions, pane, rendered } = panes([LEFT, RIGHT]);
    const dataTransfer = { types: [DATASET_DRAG_TYPE], getData: () => "b", dropEffect: "" };
    fireEvent.dragOver(pane(3), { dataTransfer });
    expect(pane(3).dataset.dropTarget).toBe("");
    fireEvent.drop(pane(3), { dataTransfer });
    expect(actions.move).toHaveBeenCalledWith(3, "b");
    expect(rendered.getByText("Drag a layer here").parentElement).toBe(pane(3));
    expect(pane(0).textContent).not.toContain("Drag a layer here");
  });
});

describe("a view that covers less", () => {
  it("says how much of what it needs the shared memory left out", () => {
    expect(coverageMessage(1200, 340)).toBe(
      "This view shows less detail: 340 of the 1,200 chunks it needs don't fit in the memory the views share.",
    );
  });
});
