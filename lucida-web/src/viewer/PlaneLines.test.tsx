// @vitest-environment happy-dom
/**
 * Four-up's planes over a view: each line in its axis's color, and a drag of
 * a slice view's line moves its plane to the pointer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PlaneLines } from "./PlaneLines.tsx";
import { planeLinesCaptured, type PlaneLine } from "./planeLines.ts";

afterEach(cleanup);

const UPRIGHT: PlaneLine = { axis: "x", from: [0.5, 0], to: [0.5, 1] };
const LEVEL: PlaneLine = { axis: "y", from: [0, 0.25], to: [1, 0.25] };

function overSvg(svg: SVGSVGElement) {
  svg.getBoundingClientRect = () =>
    ({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150, x: 100, y: 50, toJSON() {} }) as DOMRect;
}

describe("PlaneLines", () => {
  it("draws each plane in its axis's color, and nothing without lines", () => {
    const { container, rerender } = render(<PlaneLines lines={[UPRIGHT, LEVEL]} />);
    const axes = [...container.querySelectorAll("[data-axis]")].map((g) => g.getAttribute("data-axis"));
    expect(axes).toEqual(["x", "y"]);
    // Without a drag, as over the volume, no line takes the pointer.
    expect(container.querySelector(".lc-plane-line-grip")).toBeNull();
    rerender(<PlaneLines lines={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("moves a plane to the pointer along the screen axis its line crosses", () => {
    const onDrag = vi.fn();
    const { container } = render(<PlaneLines lines={[UPRIGHT, LEVEL]} onDrag={onDrag} />);
    overSvg(container.querySelector("svg")!);
    const [upright, level] = [...container.querySelectorAll<SVGLineElement>(".lc-plane-line-grip")];
    for (const grip of [upright, level]) {
      grip.setPointerCapture = vi.fn();
      grip.hasPointerCapture = () => true;
    }
    fireEvent.pointerDown(upright, { pointerId: 1, clientX: 150, clientY: 60 });
    fireEvent.pointerMove(upright, { pointerId: 1, clientX: 250, clientY: 140 });
    expect(onDrag.mock.calls).toEqual([["x", 0.25], ["x", 0.75]]);
    onDrag.mockClear();
    fireEvent.pointerDown(level, { pointerId: 2, clientX: 400, clientY: 125 });
    expect(onDrag.mock.calls).toEqual([["y", 0.75]]);
  });
});

describe("planeLinesCaptured", () => {
  it("draws the lines on a capture only when its URL asks", () => {
    expect(planeLinesCaptured("?render=1")).toBe(false);
    expect(planeLinesCaptured("?render=1&plane_lines=1")).toBe(true);
    // The viewer page draws them whatever the URL says.
    expect(planeLinesCaptured("?plane_lines=1")).toBe(false);
  });
});
