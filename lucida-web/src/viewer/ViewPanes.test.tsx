// @vitest-environment happy-dom
/**
 * Each view has a pane over its rectangle. A press or a wheel in a view makes
 * it active first; hovering never does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ViewPane } from "../sceneStore.ts";
import { ViewPanes } from "./ViewPanes.tsx";
import { isViewPane } from "./viewPane.ts";
import { withheldMessage } from "./withheld.ts";

afterEach(cleanup);

const LEFT: ViewPane = { id: 0, rect: [0, 0, 0.5, 1], cameraMode: "slice", active: true, withheld: [] };
const RIGHT: ViewPane = { id: 3, rect: [0.5, 0, 0.5, 1], cameraMode: "arcball", active: false, withheld: [] };

function panes(views: ViewPane[]) {
  const activate = vi.fn();
  const rendered = render(
    <ViewPanes views={views} activate={activate}>
      {(pane, surface) => <span data-testid={`content-${pane.id}`} data-view={surface.view} />}
    </ViewPanes>,
  );
  const pane = (id: number) => rendered.container.querySelector(`[data-view-pane="${id}"]`) as HTMLElement;
  return { activate, pane, rendered };
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

describe("why a view leaves a dataset out", () => {
  const views = [LEFT, RIGHT];
  const slice = (start: number, t = 0) => ({ kind: "slice" as const, plane: "xy" as const, cut: { start, end: start + 1 }, t });

  it("names the view that holds it, where, and what comes later", () => {
    expect(withheldMessage({ dataset_id: "a", holder: 0, held: slice(37), wanted: slice(5) }, views, "Sample A"))
      .toBe("Sample A is shown in view 1 at Z 37, T 0; one dataset at two cuts comes later.");
    expect(withheldMessage({ dataset_id: "a", holder: 0, held: slice(37), wanted: slice(37, 2) }, views, "Sample A"))
      .toBe("Sample A is shown in view 1 at Z 37, T 0; one dataset at two timepoints comes later.");
    expect(withheldMessage({ dataset_id: "a", holder: 3, held: { kind: "volume", t: 1 }, wanted: slice(0) }, views, "Sample A"))
      .toBe("Sample A is shown in view 2 in 3D at T 1; one dataset in 2D and 3D at once comes later.");
  });
});
