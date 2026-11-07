// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetPreferencesForTesting } from "../../theme/preferences.ts";
import { __resetSidePanelsForTesting, isPanelOpen, setPanelOpen } from "../sidePanels.ts";
import { keyboardInset, nextSnap, revealCanvas, sheetHeights, snapAfterDrag, stepSnap } from "./sheet.ts";

function setViewport(width: number, height = 800) {
  (window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } }).happyDOM.setViewport(
    { width, height },
  );
}

describe("sheetHeights", () => {
  it("rests at the peek, half the room, and the whole room", () => {
    expect(sheetHeights(792, 184)).toEqual({ peek: 184, half: 424, full: 792 });
    expect(sheetHeights(1000, 120)).toEqual({ peek: 120, half: 500, full: 1000 });
  });

  it("leaves some canvas at half, and never goes below the peek", () => {
    expect(sheetHeights(400, 184).half).toBe(240);
    expect(sheetHeights(300, 184).half).toBe(184);
  });

  it("fits a room smaller than the peek", () => {
    expect(sheetHeights(100, 184)).toEqual({ peek: 100, half: 100, full: 100 });
  });
});

describe("snapAfterDrag", () => {
  const heights = { peek: 184, half: 424, full: 792 };

  it("settles at the nearest snap when released at rest", () => {
    expect(snapAfterDrag(heights, 250, 0)).toBe("peek");
    expect(snapAfterDrag(heights, 380, 0)).toBe("half");
    expect(snapAfterDrag(heights, 700, 0)).toBe("full");
  });

  it("carries a fling on in its direction", () => {
    expect(snapAfterDrag(heights, 250, 1.5)).toBe("half");
    expect(snapAfterDrag(heights, 450, 2.5)).toBe("full");
    expect(snapAfterDrag(heights, 400, -1.5)).toBe("peek");
  });
});

describe("stepping the snap", () => {
  it("taps up to full, then back to peek", () => {
    expect(nextSnap("peek")).toBe("half");
    expect(nextSnap("half")).toBe("full");
    expect(nextSnap("full")).toBe("peek");
  });

  it("steps one at a time with the arrow keys, stopping at the ends", () => {
    expect(stepSnap("peek", 1)).toBe("half");
    expect(stepSnap("full", 1)).toBe("full");
    expect(stepSnap("half", -1)).toBe("peek");
    expect(stepSnap("peek", -1)).toBe("peek");
  });
});

describe("keyboardInset", () => {
  it("is the layout viewport the visual viewport no longer reaches", () => {
    expect(keyboardInset(844, { height: 544, offsetTop: 0, scale: 1 })).toBe(300);
    expect(keyboardInset(844, { height: 500, offsetTop: 44, scale: 1 })).toBe(300);
  });

  it("ignores browser chrome moving, a zoomed page, and a missing visual viewport", () => {
    expect(keyboardInset(844, { height: 800, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(844, { height: 422, offsetTop: 100, scale: 2 })).toBe(0);
    expect(keyboardInset(844, null)).toBe(0);
  });
});

describe("revealCanvas", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPreferencesForTesting();
    __resetSidePanelsForTesting();
  });
  afterEach(() => setViewport(1024, 768));

  it("lowers the sheet on a phone", () => {
    setViewport(390, 844);
    setPanelOpen("right", true);
    revealCanvas();
    expect(isPanelOpen("right")).toBe(false);
  });

  it("leaves wider screens' panels alone", () => {
    setViewport(1280, 800);
    setPanelOpen("right", true);
    revealCanvas();
    expect(isPanelOpen("right")).toBe(true);
  });
});
