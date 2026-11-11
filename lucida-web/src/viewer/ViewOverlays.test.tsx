// @vitest-environment happy-dom
/**
 * A comparison's controls stand over the view that holds it, above the
 * notice of the detail the view leaves out, and a press in them makes that view
 * the one they steer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Comparison, ComparisonActions } from "../comparison.ts";
import type { ViewPane } from "../sceneStore.ts";
import type { ViewLinkNotices } from "../viewLinks.ts";
import { ViewOverlays } from "./ViewOverlays.tsx";
import type { Coverage } from "./CoverageNotice.tsx";

afterEach(cleanup);

const LEFT: ViewPane = {
  id: 0, shows: "all", draws: ["a", "b"], rect: [0, 0, 0.5, 1], cameraMode: "slice", active: true, setAside: [],
  lines: [],
};
const RIGHT: ViewPane = {
  id: 3, shows: "all", draws: ["a", "b"], rect: [0.5, 0, 0.5, 1], cameraMode: "slice", active: false, setAside: ["c"],
  lines: [],
};
const SWIPE: Comparison = { a: "a", b: "b", mode: "swipe", divider: 0.5, showing: "a" };

function overlays(
  byView: Map<number, Comparison>,
  coverage: Record<number, Coverage> = {},
  linkNotices: readonly ViewLinkNotices[] = [],
  views: readonly ViewPane[] = [LEFT, RIGHT],
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
  const home = vi.fn();
  const store = { subscribe: () => () => {}, getComparisons: () => byView };
  const rendered = render(
    <ViewOverlays
      views={views}
      store={store}
      actions={actions}
      nameOf={(id) => id}
      activate={activate}
      coverageOf={(view) => coverage[view]}
      byHand={() => null}
      linkNotices={linkNotices}
      home={{ run: home, keys: ["0"] }}
    />,
  );
  const of = (view: number) => rendered.container.querySelector(`[data-view="${view}"]`) as HTMLElement;
  return { actions, activate, home, of, rendered };
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
    expect(children.map((child) => child.className)).toEqual(["lc-view-comparison-bar", "lc-view-notice"]);
    // A view without a comparison still says what it leaves out.
    cleanup();
    const plain = overlays(new Map(), { 0: { wanted: 100, short: 40 } });
    expect(plain.of(0).querySelector(".lc-view-overlay-top .lc-view-notice")).not.toBeNull();
  });

  it("say in the view a link took past its data where it went, and in no other", () => {
    const notices: ViewLinkNotices[] = [
      { view: 0, notices: [] },
      { view: 3, notices: [{ kind: "depth" }, { kind: "time", last: 1 }] },
    ];
    const { of } = overlays(new Map(), {}, notices);
    expect(of(0).querySelector("[data-link-notices]")).toBeNull();
    const shown = of(3).querySelector("[data-link-notices]")!;
    expect([...shown.children].map((line) => line.textContent)).toEqual([
      "The linked depth is outside this view's data, so nothing is drawn.",
      "The linked time is past this view's data, so it shows its last timepoint, 2.",
    ]);
  });

  it("give each view that draws something a Home button outside the column, which acts on that view", () => {
    const empty: ViewPane = { ...RIGHT, shows: [], draws: [] };
    const { activate, home, of } = overlays(new Map(), { 0: { wanted: 100, short: 40 } }, [], [LEFT, empty]);
    expect(of(3).querySelector(".lc-view-home")).toBeNull();
    const button = of(0).querySelector('.lc-view-home [aria-label="Home"]') as HTMLElement;
    expect(button.closest(".lc-view-overlay-top")).toBeNull();
    fireEvent.click(button);
    expect(home).toHaveBeenCalledOnce();
    cleanup();
    // In a view that isn't active, the press makes it the active one first.
    const both = overlays(new Map());
    const right = both.of(3).querySelector('.lc-view-home [aria-label="Home"]') as HTMLElement;
    fireEvent.pointerDown(right);
    expect(both.activate).toHaveBeenCalledWith(3);
    expect(activate).not.toHaveBeenCalled();
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
