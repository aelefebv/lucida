// @vitest-environment happy-dom
/**
 * A wheel over a control floating over a view goes on to the view's pane,
 * unless the control scrolls or used the wheel itself.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { forwardStrayWheels, paneAt } from "./viewPane.ts";

// happy-dom's WheelEvent leaves out the MouseEvent a browser's extends,
// which carries the pointer's place and the modifier keys.
class BrowserWheelEvent extends MouseEvent {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaZ: number;
  readonly deltaMode: number;
  constructor(type: string, init: WheelEventInit = {}) {
    super(type, init);
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = init.deltaZ ?? 0;
    this.deltaMode = init.deltaMode ?? 0;
  }
}
beforeAll(() => vi.stubGlobal("WheelEvent", BrowserWheelEvent));
afterAll(() => vi.unstubAllGlobals());

function placed<T extends HTMLElement>(element: T, [left, top, width, height]: number[]): T {
  element.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
  return element;
}

/** Two views side by side, and over them a stage's controls, as the viewer lays them out. */
function stage() {
  const root = document.createElement("div");
  const panes = document.createElement("div");
  const heard = new Map<number, WheelEvent[]>();
  for (const [view, left] of [[0, 0], [3, 500]]) {
    const pane = placed(document.createElement("div"), [left, 0, 500, 800]);
    pane.dataset.viewPane = String(view);
    heard.set(view, []);
    // As a viewer does, which keeps the page from scrolling.
    pane.addEventListener("wheel", (e) => {
      e.preventDefault();
      heard.get(view)!.push(e);
    }, { passive: false });
    panes.append(pane);
  }
  const home = document.createElement("button");
  const palette = document.createElement("button");
  const list = document.createElement("ul");
  list.style.overflowY = "auto";
  Object.defineProperties(list, { scrollHeight: { value: 400 }, clientHeight: { value: 120 } });
  const item = document.createElement("li");
  list.append(item);
  const minimap = document.createElement("canvas");
  minimap.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
  root.append(panes, home, palette, list, minimap);
  document.body.append(root);
  const stop = forwardStrayWheels(root, panes);
  const wheel = (target: Element, init: WheelEventInit) =>
    target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
  return { heard, home, palette, item, minimap, panes, stop, wheel };
}

afterEach(() => document.body.replaceChildren());

describe("a wheel over the stage", () => {
  it("goes from a control over a view to that view's pane, with its deltas, place and keys", () => {
    const { heard, home, wheel } = stage();
    const notPrevented = wheel(home, { deltaY: -100, clientX: 940, clientY: 30, ctrlKey: true });
    expect(heard.get(3)!.map((e) => [e.deltaY, e.deltaMode, e.clientX, e.clientY, e.ctrlKey])).toEqual([[-100, 0, 940, 30, true]]);
    expect(heard.get(0)).toEqual([]);
    // The viewer kept the page from scrolling, or from zooming with Ctrl.
    expect(notPrevented).toBe(false);
  });

  it("goes to whichever view a stage control lies over", () => {
    const { heard, palette, wheel } = stage();
    wheel(palette, { deltaY: 50, clientX: 30, clientY: 200 });
    expect(heard.get(0)!.map((e) => e.deltaY)).toEqual([50]);
    expect(heard.get(3)).toEqual([]);
  });

  it("reaches a pane that took it once, and goes nowhere off every view", () => {
    const { heard, home, panes, wheel } = stage();
    wheel(panes.querySelector('[data-view-pane="0"]')!, { deltaY: -100, clientX: 100, clientY: 100 });
    expect(heard.get(0)).toHaveLength(1);
    expect(wheel(home, { deltaY: -100, clientX: 1200, clientY: 100 })).toBe(true);
    expect(heard.get(3)).toEqual([]);
  });

  it("stays with a control that scrolls, or that used it itself", () => {
    const { heard, item, minimap, wheel } = stage();
    expect(wheel(item, { deltaY: 100, clientX: 700, clientY: 100 })).toBe(true);
    wheel(minimap, { deltaY: 100, clientX: 900, clientY: 700 });
    expect(heard.get(3)).toEqual([]);
  });

  it("stops going on once stopped", () => {
    const { heard, home, stop, wheel } = stage();
    stop();
    wheel(home, { deltaY: -100, clientX: 940, clientY: 30 });
    expect(heard.get(3)).toEqual([]);
  });
});

describe("the pane under a point", () => {
  it("is the one whose rectangle holds it, and none off every view", () => {
    const { panes } = stage();
    expect(paneAt(panes, 499, 10)?.dataset.viewPane).toBe("0");
    expect(paneAt(panes, 500, 10)?.dataset.viewPane).toBe("3");
    expect(paneAt(panes, 500, 800)).toBeNull();
  });
});
