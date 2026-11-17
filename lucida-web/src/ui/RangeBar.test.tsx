// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RangeBar, type RangeBarProps } from "./RangeBar.tsx";

/** The bar is 1000 px wide from x = 0, and each handle takes presses 12 px either side. */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("lc-range-bar-track") ? 1000 : this.classList.contains("lc-range-bar-handle") ? 24 : 0;
    return { left: 0, top: 0, right: width, bottom: 32, width, height: 32, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderBar(overrides: Partial<RangeBarProps> = {}) {
  const props = {
    label: "Contrast",
    value: [200, 800] as const,
    span: [0, 1000] as const,
    step: 1,
    onChange: vi.fn(),
    onZoom: vi.fn(),
    onZoomReset: vi.fn(),
    ...overrides,
  };
  const { container } = render(<RangeBar {...props} />);
  const track = container.querySelector(".lc-range-bar-track") as HTMLElement;
  return { props, track, container };
}

function drag(track: HTMLElement, from: number, to: number, init: { shiftKey?: boolean } = {}) {
  fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: from });
  fireEvent.pointerMove(track, { pointerId: 1, clientX: to, ...init });
  fireEvent.pointerUp(track, { pointerId: 1, clientX: to });
}

/** A wheel event at `clientX`, which happy-dom's WheelEvent leaves out of its init. */
function wheel(target: HTMLElement, deltaY: number, clientX: number): WheelEvent {
  const event = new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  target.dispatchEvent(event);
  return event;
}

describe("RangeBar dragging", () => {
  it("moves a handle by the pointer's travel", () => {
    const { props, track } = renderBar();
    drag(track, 205, 305);
    expect(props.onChange).toHaveBeenLastCalledWith([300, 800]);
  });

  it("moves a handle a tenth as far with Shift held", () => {
    const { props, track } = renderBar();
    drag(track, 800, 900, { shiftKey: true });
    expect(props.onChange).toHaveBeenLastCalledWith([200, 810]);
  });

  it("moves nothing for a press that barely moves", () => {
    const { props, track } = renderBar();
    drag(track, 200, 202);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("stops a handle at the span's end and at the other handle", () => {
    const { props, track } = renderBar();
    drag(track, 200, -400);
    expect(props.onChange).toHaveBeenLastCalledWith([0, 800]);
    drag(track, 200, 950);
    expect(props.onChange).toHaveBeenLastCalledWith([800, 800]);
  });

  it("drags the band, keeping its width, until an end meets the span's edge", () => {
    const { props, track } = renderBar();
    drag(track, 500, 550);
    expect(props.onChange).toHaveBeenLastCalledWith([250, 850]);
    drag(track, 500, 900);
    expect(props.onChange).toHaveBeenLastCalledWith([400, 1000]);
  });

  it("takes the handle on the side pressed when the two meet", () => {
    const { props, track } = renderBar({ value: [500, 500] });
    drag(track, 495, 400);
    expect(props.onChange).toHaveBeenLastCalledWith([405, 500]);
    drag(track, 505, 600);
    expect(props.onChange).toHaveBeenLastCalledWith([500, 595]);
  });

  it("shows a value past the span at its end, and leaves it to the keyboard", () => {
    const { props, track, container } = renderBar({ value: [-500, 800] });
    const handles = container.querySelectorAll(".lc-range-bar-handle");
    expect(handles[0].getAttribute("data-beyond")).toBe("start");
    expect((handles[0] as HTMLElement).style.left).toBe("0%");
    // A press at the left end drags the band, whose low end can only come in.
    drag(track, 2, 102);
    expect(props.onChange).toHaveBeenLastCalledWith([-400, 900]);
    drag(track, 102, 2);
    expect(props.onChange).toHaveBeenCalledTimes(1);
  });
});

describe("RangeBar keyboard", () => {
  it("steps a handle with the arrow keys, ten steps with Shift", async () => {
    const { props } = renderBar({ step: 2 });
    screen.getByRole("slider", { name: "Minimum" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(props.onChange).toHaveBeenLastCalledWith([202, 800]);
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(props.onChange).toHaveBeenLastCalledWith([180, 800]);
  });

  it("stops at the span's end", async () => {
    const { props } = renderBar({ value: [200, 995] });
    screen.getByRole("slider", { name: "Maximum" }).focus();
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(props.onChange).toHaveBeenLastCalledWith([200, 1000]);
  });

  it("brings a handle past the span back, and no further out", async () => {
    const { props } = renderBar({ value: [-500, 800] });
    const low = screen.getByRole("slider", { name: "Minimum" });
    expect(low.getAttribute("aria-valuetext")).toBe("-500");
    low.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(props.onChange).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowRight}");
    expect(props.onChange).toHaveBeenLastCalledWith([-499, 800]);
  });
});

describe("RangeBar zoom", () => {
  it("asks to zoom about the value under the pointer, in on a scroll up and out on a scroll down", () => {
    const onZoom = vi.fn();
    const { props, track } = renderBar({ onZoom });
    // The panel under the bar doesn't scroll as well.
    expect(wheel(track, -100, 250).defaultPrevented).toBe(true);
    const [anchor, factor] = onZoom.mock.calls[0];
    expect(anchor).toBe(250);
    expect(factor).toBeLessThan(1);
    wheel(track, 100, 250);
    expect(onZoom.mock.calls[1][1]).toBeCloseTo(1 / factor);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("asks for the span back on a double-click, moving no handle", () => {
    const { props, track } = renderBar();
    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 200 });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 200 });
    fireEvent.doubleClick(track, { clientX: 200 });
    expect(props.onZoomReset).toHaveBeenCalledTimes(1);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("names the span it shows on each handle", () => {
    renderBar({ span: [100, 600] });
    const high = screen.getByRole("slider", { name: "Maximum" }) as HTMLInputElement;
    expect([high.min, high.max]).toEqual(["100", "600"]);
  });
});
