// @vitest-environment happy-dom

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContrastControls } from "./ContrastControls.tsx";
import {
  contrastBounds,
  narrowestSpan,
  orderLimits,
  typedLimit,
  visibleSpan,
  zoomSpan,
} from "./contrastLimits.ts";
import { histogramOfSamples } from "../pipeline/valueHistogram.ts";
import { VIEWPORT_MEDIA } from "../theme/viewport.ts";

type Props = Parameters<typeof ContrastControls>[0];

function controlProps(overrides: Partial<Props> = {}) {
  return {
    label: "Channel 1",
    contrastMin: 100,
    contrastMax: 3000,
    gamma: 1,
    dataRange: { min: 50, max: 4000 } as { min: number; max: number } | null,
    valueRange: [0, 65535] as readonly [number, number] | null,
    integer: true,
    fullRange: false,
    histogram: null,
    onFullRangeChange: vi.fn(),
    onContrastChange: vi.fn(),
    onGammaChange: vi.fn(),
    onAutoFit: vi.fn(),
    ...overrides,
  } satisfies Props;
}

function renderControls(overrides: Partial<Props> = {}) {
  const props = controlProps(overrides);
  render(<ContrastControls {...props} />);
  return props;
}

/** Controls that keep the limits they set, as the layer panel does. */
function LiveControls(props: Props) {
  const [[min, max], setLimits] = useState([props.contrastMin, props.contrastMax]);
  const [fullRange, setFullRange] = useState(props.fullRange);
  return (
    <ContrastControls
      {...props}
      contrastMin={min}
      contrastMax={max}
      fullRange={fullRange}
      onFullRangeChange={setFullRange}
      onContrastChange={(lo, hi) => {
        props.onContrastChange(lo, hi);
        setLimits([lo, hi]);
      }}
    />
  );
}

function renderLive(overrides: Partial<Props> = {}) {
  const props = controlProps(overrides);
  const { container } = render(<LiveControls {...props} />);
  const track = container.querySelector(".lc-range-bar-track") as HTMLElement;
  return { props, track };
}

/** The span the bar shows, as its handles name it to assistive tech. */
function shownSpan(): [number, number] {
  const handle = screen.getByRole("slider", { name: "Minimum" }) as HTMLInputElement;
  return [Number(handle.min), Number(handle.max)];
}

/** A wheel event at `clientX`, which happy-dom's WheelEvent leaves out of its init. */
function wheel(target: HTMLElement, deltaY: number, clientX: number) {
  const event = new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  fireEvent(target, event);
}

/** The bar is 1000 px wide from x = 0, and each handle takes presses 12 px either side. */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("lc-range-bar-track") ? 1000 : this.classList.contains("lc-range-bar-handle") ? 24 : 0;
    return { left: 0, top: 0, right: width, bottom: 32, width, height: 32, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});

function field(name: string): HTMLInputElement {
  return screen.getByRole("textbox", { name }) as HTMLInputElement;
}

async function typeInto(name: string, text: string, commit: "{Enter}" | "blur") {
  const input = field(name);
  await userEvent.clear(input);
  await userEvent.type(input, text);
  if (commit === "blur") await userEvent.tab();
  else await userEvent.keyboard(commit);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ContrastControls typed limits", () => {
  it("applies a typed minimum on Enter", async () => {
    const props = renderControls();
    await typeInto("Contrast minimum", "250", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(250, 3000);
  });

  it("applies a typed maximum on blur", async () => {
    const props = renderControls();
    await typeInto("Contrast maximum", "3500", "blur");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(100, 3500);
  });

  it("accepts a typed limit past the span, and grows the span to show it", async () => {
    const { props } = renderLive();
    expect(shownSpan()).toEqual([50, 4000]);
    await typeInto("Contrast maximum", "9000", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(100, 9000);
    expect(shownSpan()).toEqual([50, 9000]);
  });

  it("clamps a typed limit to an integer type's values, below its minimum and above its maximum", async () => {
    const props = renderControls();
    await typeInto("Contrast maximum", "90000", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(100, 65535);
    await typeInto("Contrast minimum", "-20", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(0, 3000);
  });

  it("takes any finite typed limit for a float type", async () => {
    const props = renderControls({ integer: false, valueRange: null, contrastMin: 0, contrastMax: 1, dataRange: { min: 0, max: 1 } });
    await typeInto("Contrast minimum", "-250000.5", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(-250000.5, 1);
    await typeInto("Contrast maximum", "70000", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(0, 70000);
  });

  it("grows a zoomed span to show a typed limit", async () => {
    const { track } = renderLive({ contrastMin: 200, contrastMax: 800, dataRange: { min: 0, max: 1000 } });
    wheel(track, -1000, 500);
    const [lo, hi] = shownSpan();
    expect(hi - lo).toBeLessThan(200);
    await typeInto("Contrast maximum", "900", "{Enter}");
    expect(shownSpan()).toEqual([lo, 900]);
  });

  it("keeps the minimum below the maximum", async () => {
    const props = renderControls();
    await typeInto("Contrast minimum", "3800", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(2999, 3000);
  });

  it("applies a typed gamma, clamped", async () => {
    const props = renderControls();
    await typeInto("Gamma", "2.5", "{Enter}");
    expect(props.onGammaChange).toHaveBeenLastCalledWith(2.5);
    await typeInto("Gamma", "9", "blur");
    expect(props.onGammaChange).toHaveBeenLastCalledWith(5);
  });
});

describe("ContrastControls fields", () => {
  it("show a 64-bit integer limit whole", () => {
    renderControls({
      contrastMin: -6000000000,
      contrastMax: 1234567890,
      dataRange: { min: -6e9, max: 6e9 },
      valueRange: [-(2 ** 63), 2 ** 63],
    });
    expect(field("Contrast minimum").value).toBe("-6000000000");
    expect(field("Contrast maximum").value).toBe("1234567890");
    expect(field("Contrast maximum").style.getPropertyValue("--lc-field-chars")).toBe("10");
  });

  it("show a float limit as the float32 the renderer applies, to the last digit it needs", () => {
    renderControls({
      integer: false,
      contrastMin: Math.fround(0.1),
      contrastMax: 1234.5678,
      dataRange: { min: 0, max: 2000 },
      valueRange: null,
    });
    expect(field("Contrast minimum").value).toBe("0.1");
    expect(field("Contrast maximum").value).toBe("1234.5677");
  });

  it("place a float limit on the bar as shown, even where that falls just past the data's end", () => {
    // The float32 nearest -0.7237397 is a little above it, so the shown limit is below the data's minimum.
    const min = Math.fround(-0.7237397);
    renderControls({ integer: false, valueRange: null, contrastMin: min, contrastMax: 6, dataRange: { min, max: 6 } });
    expect(field("Contrast minimum").value).toBe("-0.7237397");
    const handles = document.querySelectorAll(".lc-range-bar-handle");
    expect([...handles].map((h) => h.getAttribute("data-beyond"))).toEqual([null, null]);
  });

  it("keep the value a float limit holds when only the other is typed", async () => {
    const props = renderControls({
      integer: false,
      contrastMin: Math.fround(0.1),
      contrastMax: 1000,
      dataRange: { min: 0, max: 2000 },
      valueRange: null,
    });
    await typeInto("Contrast maximum", "1500.25", "{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(Math.fround(0.1), 1500.25);
  });
});

describe("ContrastControls bar", () => {
  it("zooms the span about the pointer on a scroll, and resets it on a double-click, leaving the limits", () => {
    const { props, track } = renderLive({ contrastMin: 200, contrastMax: 800, dataRange: { min: 0, max: 1000 } });
    expect(shownSpan()).toEqual([0, 1000]);
    wheel(track, -500, 250);
    const [lo, hi] = shownSpan();
    // The value under the pointer keeps its place a quarter of the way along.
    expect((250 - lo) / (hi - lo)).toBeCloseTo(0.25);
    expect(hi - lo).toBeCloseTo(1000 * Math.exp(-1));
    fireEvent.doubleClick(track);
    expect(shownSpan()).toEqual([0, 1000]);
    expect(props.onContrastChange).not.toHaveBeenCalled();
  });

  it("zooms out no further than the full span, and ends a zoom when the full range is turned on", async () => {
    const { track } = renderLive({ contrastMin: 200, contrastMax: 800, dataRange: { min: 0, max: 1000 } });
    wheel(track, 2000, 500);
    expect(shownSpan()).toEqual([0, 1000]);
    wheel(track, -500, 500);
    expect(shownSpan()[0]).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Span the bar over the full value range" }));
    expect(shownSpan()).toEqual([0, 65535]);
  });

  it("moves both limits together when the band is dragged", () => {
    const { props, track } = renderLive({ contrastMin: 200, contrastMax: 800, dataRange: { min: 0, max: 1000 } });
    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 450 });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 450 });
    expect(props.onContrastChange).toHaveBeenLastCalledWith(150, 750);
  });

  it("draws the channel's histogram behind the bar, and redraws it with each fit", () => {
    const histogram = (values: number[]) => histogramOfSamples([Float32Array.from(values)], 1, { min: 0, max: 1000 }, true);
    const props = controlProps({ contrastMin: 0, contrastMax: 1000, dataRange: { min: 0, max: 1000 } });
    const { rerender } = render(<ContrastControls {...props} />);
    expect(screen.queryByTestId("contrast-histogram")).toBeNull();
    rerender(<ContrastControls {...props} histogram={histogram([10, 20, 20])} />);
    const first = screen.getByTestId("contrast-histogram").querySelector("path")?.getAttribute("d");
    rerender(<ContrastControls {...props} histogram={histogram([900, 950])} />);
    const second = screen.getByTestId("contrast-histogram").querySelector("path")?.getAttribute("d");
    expect(first).toMatch(/^M0 1V/);
    expect(second).not.toBe(first);
  });
});

describe("ContrastControls auto", () => {
  it("fits once on Auto, and waits for data before offering it", async () => {
    const props = renderControls();
    await userEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(props.onAutoFit).toHaveBeenCalledTimes(1);
    cleanup();

    renderControls({ dataRange: null });
    expect(screen.getByRole("button", { name: "Auto" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows continuous auto-contrast as a switch when given one", async () => {
    const onChange = vi.fn();
    renderControls({ continuous: { isSelected: true, onChange } });
    await userEvent.click(screen.getByRole("switch", { name: "Continuous" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("ContrastControls editor", () => {
  /** The span a bar shows inside `root`, as its handles name it. */
  function spanIn(root: HTMLElement): [number, number] {
    const handle = within(root).getByRole("slider", { name: "Minimum", hidden: true }) as HTMLInputElement;
    return [Number(handle.min), Number(handle.max)];
  }

  function fieldIn(root: HTMLElement, name: string): HTMLInputElement {
    return within(root).getByRole("textbox", { name, hidden: true }) as HTMLInputElement;
  }

  function trackIn(root: HTMLElement): HTMLElement {
    return root.querySelector(".lc-range-bar-track") as HTMLElement;
  }

  async function openEditor(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Expand contrast" }));
    return screen.findByRole("dialog", { name: "Channel 1 contrast" });
  }

  function renderInline() {
    const props = controlProps({ contrastMin: 200, contrastMax: 800, dataRange: { min: 0, max: 1000 } });
    const { container } = render(<LiveControls {...props} />);
    return { props, inline: container.querySelector(".lc-contrast") as HTMLElement };
  }

  it("opens beside the channel with every control, takes focus, and gives it back on Escape", async () => {
    const user = userEvent.setup();
    renderInline();
    const editor = await openEditor(user);
    expect(editor.closest(".lc-contrast-editor-popover")).not.toBeNull();
    expect(editor.contains(document.activeElement)).toBe(true);
    for (const name of ["Contrast minimum", "Contrast maximum", "Gamma"]) expect(fieldIn(editor, name)).toBeTruthy();
    expect(within(editor).getByRole("button", { name: "Auto" })).toBeTruthy();
    expect(within(editor).getByRole("button", { name: "Span the bar over the full value range" })).toBeTruthy();
    expect(within(editor).queryByRole("button", { name: "Expand contrast" })).toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand contrast" }));
  });

  it("closes on a click outside", async () => {
    const user = userEvent.setup();
    renderInline();
    await openEditor(user);
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows Continuous when the inline control does", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderControls({ continuous: { isSelected: true, onChange } });
    const editor = await openEditor(user);
    await user.click(within(editor).getByRole("switch", { name: "Continuous" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("opens as a sheet from the bottom edge on a phone, and closes from its button", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === VIEWPORT_MEDIA.phone,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const user = userEvent.setup();
    renderInline();
    const editor = await openEditor(user);
    expect(editor.closest(".lc-dialog")?.getAttribute("data-placement")).toBe("bottom");
    expect(editor.contains(document.activeElement)).toBe(true);
    await user.click(within(editor).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand contrast" }));
  });

  it("shows a limit set in either in both", async () => {
    const user = userEvent.setup();
    const { props, inline } = renderInline();
    const track = trackIn(inline);
    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 450 });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 450 });
    expect(props.onContrastChange).toHaveBeenLastCalledWith(150, 750);

    const editor = await openEditor(user);
    expect(fieldIn(editor, "Contrast minimum").value).toBe("150");
    expect(fieldIn(editor, "Contrast maximum").value).toBe("750");
    const editorMax = fieldIn(editor, "Contrast maximum");
    await user.clear(editorMax);
    await user.type(editorMax, "900{Enter}");
    expect(props.onContrastChange).toHaveBeenLastCalledWith(150, 900);
    expect(fieldIn(inline, "Contrast maximum").value).toBe("900");
  });

  it("follows limits set elsewhere while it is open, as a continuous fit sets them", async () => {
    const user = userEvent.setup();
    const props = controlProps();
    const { container, rerender } = render(<ContrastControls {...props} />);
    const editor = await openEditor(user);
    rerender(<ContrastControls {...props} contrastMin={400} contrastMax={2500} />);
    for (const root of [container, editor]) {
      expect(fieldIn(root, "Contrast minimum").value).toBe("400");
      expect(fieldIn(root, "Contrast maximum").value).toBe("2500");
    }
  });

  it("shows the gamma the inline control shows", async () => {
    const user = userEvent.setup();
    const props = controlProps({ gamma: 1.5 });
    const { rerender } = render(<ContrastControls {...props} />);
    const editor = await openEditor(user);
    const gamma = fieldIn(editor, "Gamma");
    expect(gamma.value).toBe("1.50");
    await user.clear(gamma);
    await user.type(gamma, "2.25{Enter}");
    expect(props.onGammaChange).toHaveBeenLastCalledWith(2.25);
    rerender(<ContrastControls {...props} gamma={0.8} />);
    expect(fieldIn(editor, "Gamma").value).toBe("0.80");
  });

  it("opens at the span the inline bar shows, and zooms without moving it", async () => {
    const user = userEvent.setup();
    const { inline } = renderInline();
    wheel(trackIn(inline), -500, 250);
    const inlineSpan = spanIn(inline);
    const editor = await openEditor(user);
    expect(spanIn(editor)).toEqual(inlineSpan);

    wheel(trackIn(editor), -500, 250);
    expect(spanIn(editor)[1] - spanIn(editor)[0]).toBeLessThan(inlineSpan[1] - inlineSpan[0]);
    expect(spanIn(inline)).toEqual(inlineSpan);
    fireEvent.doubleClick(trackIn(editor));
    expect(spanIn(editor)).toEqual([0, 1000]);
    expect(spanIn(inline)).toEqual(inlineSpan);
  });

  it("drags the band, slows a Shift-drag, and ends both zooms when the full range is turned on", async () => {
    const user = userEvent.setup();
    const { props, inline } = renderInline();
    wheel(trackIn(inline), -500, 500);
    const editor = await openEditor(user);
    const track = trackIn(editor);
    fireEvent.doubleClick(track);

    fireEvent.pointerDown(track, { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 450 });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 450 });
    expect(props.onContrastChange).toHaveBeenLastCalledWith(150, 750);

    // The maximum is at 750 on a bar 1000 values and 1000 px wide.
    fireEvent.pointerDown(track, { pointerId: 2, button: 0, clientX: 750 });
    fireEvent.pointerMove(track, { pointerId: 2, clientX: 850, shiftKey: true });
    fireEvent.pointerUp(track, { pointerId: 2, clientX: 850, shiftKey: true });
    expect(props.onContrastChange).toHaveBeenLastCalledWith(150, 760);

    await user.click(within(editor).getByRole("button", { name: "Span the bar over the full value range" }));
    expect(spanIn(editor)).toEqual([0, 65535]);
    expect(spanIn(inline)).toEqual([0, 65535]);
  });
});

describe("contrast span", () => {
  it("spans the loaded data, or the whole range, and always holds the limits", () => {
    expect(contrastBounds(100, 3000, { min: 50, max: 4000 }, [0, 65535], false)).toEqual([50, 4000]);
    expect(contrastBounds(100, 3000, { min: 50, max: 4000 }, [0, 65535], true)).toEqual([0, 65535]);
    expect(contrastBounds(0, 65535, { min: 50, max: 4000 }, [0, 65535], false)).toEqual([0, 65535]);
    expect(contrastBounds(10, 20, null, [0, 255], false)).toEqual([0, 255]);
    expect(contrastBounds(-5, 20, null, [-32768, 32767], true)).toEqual([-32768, 32767]);
    // A float type spans its loaded data, or its limits before any loads.
    expect(contrastBounds(0, 100, { min: -5, max: 500 }, null, false)).toEqual([-5, 500]);
    expect(contrastBounds(0, 100, { min: -5, max: 500 }, null, true)).toEqual([-5, 500]);
    expect(contrastBounds(-2, 7.5, null, null, false)).toEqual([-2, 7.5]);
  });

  it("zooms about an anchor, inside the full span, down to its narrowest", () => {
    expect(zoomSpan([0, 1000], 250, 0.5, [0, 1000], 10)).toEqual([125, 625]);
    // Held inside the full span, and unzoomed once it would cover it.
    expect(zoomSpan([100, 300], 300, 4, [0, 1000], 10)).toEqual([0, 800]);
    expect(zoomSpan([100, 300], 200, 6, [0, 1000], 10)).toBeNull();
    expect(zoomSpan([100, 120], 110, 0.01, [0, 1000], 10)).toEqual([105, 115]);
    expect(narrowestSpan([0, 65535], true)).toBe(10);
    expect(narrowestSpan([-1, 1], false)).toBe(2e-4);
  });

  it("shows the part of a zoom inside the full span, or the full span once none is", () => {
    expect(visibleSpan(null, [0, 10])).toEqual([0, 10]);
    expect(visibleSpan([5, 20], [0, 10])).toEqual([5, 10]);
    expect(visibleSpan([20, 30], [0, 10])).toEqual([0, 10]);
  });

  it("holds a typed limit to what the data type holds", () => {
    expect(typedLimit(-5, true, [0, 255])).toBe(0);
    expect(typedLimit(300, true, [0, 255])).toBe(255);
    expect(typedLimit(12.6, true, [0, 255])).toBe(13);
    expect(typedLimit(-1e12, true, null)).toBe(-1e12);
    expect(typedLimit(-1e12, false, null)).toBe(-1e12);
    expect(typedLimit(0.25, false, null)).toBe(0.25);
  });

  it("moves whichever limit the user did not set", () => {
    expect(orderLimits([100, 3000], 100, 1)).toEqual([100, 3000]);
    expect(orderLimits([3000, 3000], 100, 1)).toEqual([2999, 3000]);
    expect(orderLimits([100, 100], 100, 1)).toEqual([100, 101]);
  });
});
