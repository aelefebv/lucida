// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { readChrome } from "./chromeLayout.ts";

function box(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) };
}

function mount(html: string, boxes: Record<string, DOMRect>): void {
  document.body.innerHTML = html;
  for (const [selector, rect] of Object.entries(boxes)) {
    const element = document.querySelector(selector);
    if (element) vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
  }
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("reading the chrome", () => {
  it("reads a phone's top bar and bottom sheet against the viewport, to the hundredth of a pixel", () => {
    mount(
      `<div id="root"><div class="lc-shell" data-layout="phone">
         <header class="lc-phone-topbar"></header>
         <div class="lc-shell-body"><div class="lc-shell-center">
           <div class="lc-phone-sheet-dock"><section class="lc-phone-sheet"></section></div>
         </div></div>
       </div></div>`,
      {
        ".lc-phone-topbar": box(0, -80, 390, -27.666666),
        ".lc-phone-sheet": box(0, 660, 390, 844),
      },
    );

    const reading = readChrome();

    expect(reading.parts).toEqual([
      { part: "top bar", left: 0, top: -80, right: 390, bottom: -27.67 },
      { part: "bottom sheet", left: 0, top: 660, right: 390, bottom: 844 },
    ]);
    expect(reading.viewportWidth).toBe(document.documentElement.clientWidth);
    expect(reading.viewportHeight).toBe(document.documentElement.clientHeight);
  });

  it("reads the desktop's top bar, and no part on a page that renders none", () => {
    mount(`<div class="lc-shell"><header class="lc-topbar"></header></div>`, {
      ".lc-topbar": box(0, 0, 1440, 48),
    });
    expect(readChrome().parts).toEqual([{ part: "top bar", left: 0, top: 0, right: 1440, bottom: 48 }]);

    mount(`<div class="lc-shell" data-capture="true"><div class="lc-shell-body"></div></div>`, {});
    expect(readChrome().parts).toEqual([]);
  });
});
