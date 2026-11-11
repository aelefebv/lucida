// @vitest-environment happy-dom
/**
 * A comparison's controls stand over the view that holds it, above the icon
 * that holds the view's notices, and a press in them makes that view the one
 * they steer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Comparison, ComparisonActions } from "../comparison.ts";
import type { ViewPane } from "../sceneStore.ts";
import type { ViewLinkNotices } from "../viewLinks.ts";
import { ViewOverlays } from "./ViewOverlays.tsx";
import type { Coverage } from "./coverage.ts";

afterEach(cleanup);

const LEFT: ViewPane = {
  id: 0, shows: "all", draws: ["a", "b"], rect: [0, 0, 0.5, 1], cameraMode: "slice", active: true, setAside: [],
};
const RIGHT: ViewPane = {
  id: 3, shows: "all", draws: ["a", "b"], rect: [0.5, 0, 0.5, 1], cameraMode: "slice", active: false, setAside: ["c"],
};
const SWIPE: Comparison = { a: "a", b: "b", mode: "swipe", divider: 0.5, showing: "a" };

function overlays(
  byView: Map<number, Comparison>,
  coverage: Record<number, Coverage> = {},
  linkNotices: readonly ViewLinkNotices[] = [],
) {
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
      byHand={() => null}
      linkNotices={linkNotices}
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
  });

  it("say what a comparison hides among the view's notices, not on its bar", () => {
    const { of } = overlays(new Map([[3, SWIPE]]));
    expect(of(3).querySelector(".lc-comparison-bar")!.textContent).not.toContain("hidden while comparing");
    expect(of(3).querySelector(".lc-view-notices-list")!.textContent).toBe("1 other layer is hidden while comparing.");
    expect(of(3).querySelector(".lc-view-notices")!.getAttribute("data-severity")).toBe("note");
  });

  it("stack the compare bar and then the notices' icon in one column at the view's top", () => {
    const { of } = overlays(new Map([[3, SWIPE]]), { 3: { wanted: 100, short: 40 } });
    const column = of(3).querySelector(".lc-view-overlay-top")!;
    const children = [...column.children];
    expect(children.map((child) => child.className)).toEqual(["lc-view-comparison-bar", "lc-view-notices"]);
    // The shortfall is the most severe, so the icon wears a warning and counts both.
    expect(of(3).querySelector(".lc-view-notices")!.getAttribute("data-severity")).toBe("warning");
    expect(of(3).querySelector(".lc-view-notices button")!.textContent).toBe("2");
    // A view without a comparison still says what it leaves out.
    cleanup();
    const plain = overlays(new Map(), { 0: { wanted: 100, short: 40 } });
    expect(plain.of(0).querySelector(".lc-view-overlay-top .lc-view-notices-list")!.textContent).toContain("40 of the 100");
  });

  it("say in the view a link took past its data where it went, and in no other", () => {
    const notices: ViewLinkNotices[] = [
      { view: 0, notices: [] },
      { view: 3, notices: [{ kind: "depth" }, { kind: "time", last: 1 }] },
    ];
    const { of } = overlays(new Map(), {}, notices);
    expect(of(0).querySelector(".lc-view-notices")).toBeNull();
    const shown = of(3).querySelector(".lc-view-notices-list")!;
    // The timepoint held at the layer's last comes first: it shows a value as another.
    expect([...shown.children].map((line) => line.textContent)).toEqual([
      "The linked time is past this view's data, so it shows its last timepoint, 2.",
      "The linked depth is outside this view's data, so nothing is drawn.",
    ]);
  });

  it("leave the active view as it is when someone reads another view's notices", () => {
    const notices: ViewLinkNotices[] = [{ view: 3, notices: [{ kind: "position" }] }];
    const { activate, of } = overlays(new Map(), {}, notices);
    const icon = of(3).querySelector(".lc-view-notices button") as HTMLElement;
    fireEvent.pointerDown(icon);
    fireEvent.focus(icon);
    fireEvent.click(icon);
    expect(activate).not.toHaveBeenCalled();
    expect(icon.getAttribute("aria-expanded")).toBe("false");
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
