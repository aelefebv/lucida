// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { WasmScene } from "lucida-core";
import { ScaleBar } from "./ScaleBar.tsx";
import type { ScaleBarReading } from "./scaleBar.ts";

afterEach(cleanup);

let scheduled: FrameRequestCallback[] = [];
let originalRaf: typeof globalThis.requestAnimationFrame;
beforeEach(() => {
  scheduled = [];
  originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    scheduled.push(callback);
    return scheduled.length;
  }) as typeof globalThis.requestAnimationFrame;
});
afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
});

function runFrame() {
  scheduled[scheduled.length - 1]?.(performance.now());
}

const ACROSS = { axis: "x", pixels: 90.9, label: "20 samples" } as const;

function mount(reading: ScaleBarReading | null) {
  let current = reading;
  const scene = { scale_bar: () => JSON.stringify(current) } as unknown as WasmScene;
  const element = document.createElement("div");
  document.body.append(element);
  const rendered = render(<ScaleBar scene={scene} surface={{ view: 0, element }} />, { container: element });
  const root = () => element.querySelector(".lc-scale-bar") as HTMLElement;
  const part = (selector: string) => root().querySelector(selector) as HTMLElement;
  return {
    rendered,
    root,
    mark: () => part(".lc-scale-bar-mark"),
    across: () => part('[data-arm="across"]'),
    down: () => part('[data-arm="down"]'),
    note: () => part(".lc-scale-bar-note"),
    set(next: ScaleBarReading | null) {
      current = next;
    },
  };
}

const READING: ScaleBarReading = {
  dataset_id: "a",
  measure: "samples",
  per_pixel: [0.22, 0.22],
  across: { ...ACROSS, axis: null },
  down: null,
  at_orbit_center: false,
};

describe("ScaleBar", () => {
  it("draws one bar as long as its length, in whole device pixels", () => {
    const bar = mount(READING);
    runFrame();
    expect(bar.root().hidden).toBe(false);
    expect(bar.mark().dataset.shape).toBe("bar");
    expect(bar.mark().style.width).toBe("91px");
    expect(bar.across().textContent).toBe("20 samples");
    expect(bar.down().hidden).toBe(true);
    expect(bar.note().hidden).toBe(true);
  });

  it("draws an L with each arm labelled by its axis where the axes measure differently", () => {
    const bar = mount({
      ...READING,
      per_pixel: [0.22, 0.086],
      across: ACROSS,
      down: { axis: "z", pixels: 116.25, label: "10 samples" },
    });
    runFrame();
    expect(bar.mark().dataset.shape).toBe("corner");
    expect(bar.mark().style.width).toBe("91px");
    expect(bar.mark().style.height).toBe("116px");
    expect(bar.across().textContent).toBe("X 20 samples");
    expect(bar.down().textContent).toBe("Z 10 samples");
    expect(bar.down().hidden).toBe(false);
  });

  it("says a volume view's reading holds at the orbit center", () => {
    const bar = mount({ ...READING, measure: "length", across: { axis: null, pixels: 94, label: "50 µm" }, at_orbit_center: true });
    runFrame();
    expect(bar.note().hidden).toBe(false);
    expect(bar.note().textContent).toBe("at orbit center");
  });

  it("hides when the view shows no bar, and follows the reading", () => {
    const bar = mount(null);
    runFrame();
    expect(bar.root().hidden).toBe(true);
    bar.set(READING);
    runFrame();
    expect(bar.root().hidden).toBe(false);
  });
});
