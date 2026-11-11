// @vitest-environment happy-dom
/**
 * The crosshair of the point under the pointer over another view: a cross at
 * the point with an arm along each axis the view draws, and, where the
 * view's data misses the point, a notice in its column instead.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Crosshair, CrosshairOutside } from "./Crosshair.tsx";
import { Hover, type CrosshairMark } from "./hover.ts";

afterEach(cleanup);

function hoverWith(marks: CrosshairMark[]) {
  const hover = new Hover();
  hover.setPointer({ view: 0, x: 0.5, y: 0.5, touch: false, atMs: 0 });
  hover.refresh({ crosshairs: () => JSON.stringify(marks) });
  return hover;
}

describe("Crosshair", () => {
  it("centers a cross on the point, an arm either side of a gap along each axis the view draws", () => {
    const hover = hoverWith([{ view: 1, kind: "at", at: [0.25, 0.75], arms: [[1, 0], [0, 1], [0, 0]] }]);
    const { container } = render(<Crosshair hover={hover} view={1} />);
    const svg = container.querySelector<SVGSVGElement>("[data-crosshair]")!;
    expect(svg.style.left).toBe("25%");
    expect(svg.style.top).toBe("75%");
    const lines = [...svg.querySelectorAll("line")].map((line) =>
      ["x1", "y1", "x2", "y2"].map((name) => Number(line.getAttribute(name)) + 0));
    // X across, Y down; the view looks along Z, which has no arm.
    expect(lines).toEqual([[4, 0, 16, 0], [-4, 0, -16, 0], [0, 4, 0, 16], [0, -4, 0, -16]]);
  });

  it("follows the point, and draws nothing in a view with no mark or one outside its data", () => {
    const hover = hoverWith([{ view: 2, kind: "outside" }]);
    const { container } = render(
      <>
        <Crosshair hover={hover} view={1} />
        <Crosshair hover={hover} view={2} />
        <CrosshairOutside hover={hover} view={1} />
        <CrosshairOutside hover={hover} view={2} />
      </>,
    );
    expect(container.querySelector("[data-crosshair]")).toBeNull();
    expect(container.querySelectorAll("[data-crosshair-outside]")).toHaveLength(1);
    expect(container.textContent).toMatch(/outside this view's data/);

    act(() => {
      hover.refresh({ crosshairs: () => JSON.stringify([{ view: 2, kind: "at", at: [0.5, 0.5], arms: [[1, 0], [0, 1], [0, 0]] }]) });
    });
    expect(container.querySelector("[data-crosshair-outside]")).toBeNull();
    expect(container.querySelectorAll("[data-crosshair]")).toHaveLength(1);
  });
});
