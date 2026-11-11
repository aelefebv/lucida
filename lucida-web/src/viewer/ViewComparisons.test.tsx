// @vitest-environment happy-dom
/**
 * A comparison's controls stand over the view that holds it, and a press in
 * them makes that view the one they steer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Comparison, ComparisonActions } from "../comparison.ts";
import type { ViewPane } from "../sceneStore.ts";
import { ViewComparisons } from "./ViewComparisons.tsx";

afterEach(cleanup);

const LEFT: ViewPane = {
  id: 0, shows: "all", draws: ["a", "b"], rect: [0, 0, 0.5, 1], cameraMode: "slice", active: true, withheld: [],
  setAside: [],
};
const RIGHT: ViewPane = {
  id: 3, shows: "all", draws: ["a", "b"], rect: [0.5, 0, 0.5, 1], cameraMode: "slice", active: false, withheld: [],
  setAside: ["c"],
};
const SWIPE: Comparison = { a: "a", b: "b", mode: "swipe", divider: 0.5, showing: "a" };

function comparisons(byView: Map<number, Comparison>) {
  const actions: ComparisonActions = {
    current: () => null,
    start: vi.fn(() => ({ verdict: "yes" as const })),
    end: vi.fn(),
    setMode: vi.fn(),
    setDivider: vi.fn(),
    flip: vi.fn(),
  };
  const activate = vi.fn();
  const store = { subscribe: () => () => {}, getComparisons: () => byView };
  const rendered = render(
    <ViewComparisons views={[LEFT, RIGHT]} store={store} actions={actions} nameOf={(id) => id} activate={activate} />,
  );
  const of = (view: number) => rendered.container.querySelector(`[data-view="${view}"]`) as HTMLElement | null;
  return { actions, activate, of, rendered };
}

describe("a view's comparison controls", () => {
  it("stand over the view that holds the comparison, and over no other", () => {
    const { of } = comparisons(new Map([[3, SWIPE]]));
    expect(of(0)).toBeNull();
    const right = of(3)!;
    expect(right.style.left).toBe("50%");
    expect(right.style.width).toBe("50%");
    expect(right.querySelector(".lc-comparison-bar")).not.toBeNull();
    expect(right.querySelector(".lc-swipe-divider")).not.toBeNull();
    expect(right.textContent).toContain("1 other layer hidden while comparing");
  });

  it("make their view the active one on a press or focus, before they act", () => {
    const { actions, activate, of } = comparisons(new Map([[0, SWIPE], [3, SWIPE]]));
    const stop = (view: number) => of(view)!.querySelector('[aria-label="Stop comparing"]') as HTMLElement;
    fireEvent.pointerDown(stop(3));
    expect(activate).toHaveBeenCalledWith(3);
    fireEvent.focus(stop(3));
    expect(activate).toHaveBeenCalledTimes(2);
    // The active view's controls already steer it.
    fireEvent.pointerDown(stop(0));
    expect(activate).toHaveBeenCalledTimes(2);
    fireEvent.click(stop(3));
    expect(actions.end).toHaveBeenCalled();
  });
});
