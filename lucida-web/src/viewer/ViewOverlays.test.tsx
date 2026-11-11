// @vitest-environment happy-dom
/**
 * A comparison's controls stand over the view that holds it, above the
 * notice of what the view leaves out, and a press in them makes that view
 * the one they steer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Comparison, ComparisonActions } from "../comparison.ts";
import type { ViewPane } from "../sceneStore.ts";
import { ViewOverlays } from "./ViewOverlays.tsx";
import type { Coverage } from "./WithheldNotice.tsx";

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

function overlays(byView: Map<number, Comparison>, coverage: Record<number, Coverage> = {}) {
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
    <ViewOverlays
      views={[LEFT, RIGHT]}
      store={store}
      actions={actions}
      nameOf={(id) => id}
      activate={activate}
      coverageOf={(view) => coverage[view]}
    />,
  );
  const of = (view: number) => rendered.container.querySelector(`[data-view="${view}"]`) as HTMLElement;
  return { actions, activate, of, rendered };
}

describe("a view's overlays", () => {
  it("put a comparison's controls over the view that holds it, and over no other", () => {
    const { of } = overlays(new Map([[3, SWIPE]]));
    expect(of(0).querySelector(".lc-comparison-bar")).toBeNull();
    expect(of(3).style.left).toBe("50%");
    expect(of(3).style.width).toBe("50%");
    expect(of(3).querySelector(".lc-comparison-bar")).not.toBeNull();
    expect(of(3).querySelector(".lc-swipe-divider")).not.toBeNull();
    expect(of(3).textContent).toContain("1 other layer hidden while comparing");
  });

  it("stack the compare bar and then the notice in one column at the view's top", () => {
    const { of } = overlays(new Map([[3, SWIPE]]), { 3: { wanted: 100, short: 40 } });
    const column = of(3).querySelector(".lc-view-overlay-top")!;
    const children = [...column.children];
    expect(children.map((child) => child.className)).toEqual(["lc-view-comparison-bar", "lc-withheld-notice"]);
    // A view without a comparison still says what it leaves out.
    cleanup();
    const plain = overlays(new Map(), { 0: { wanted: 100, short: 40 } });
    expect(plain.of(0).querySelector(".lc-view-overlay-top .lc-withheld-notice")).not.toBeNull();
  });

  it("make their view the active one on a press or focus, before they act", () => {
    const { actions, activate, of } = overlays(new Map([[0, SWIPE], [3, SWIPE]]));
    const stop = (view: number) => of(view).querySelector('[aria-label="Stop comparing"]') as HTMLElement;
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
