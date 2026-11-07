// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetPreferencesForTesting, getPreference } from "../theme/preferences.ts";
import {
  __resetCanvasCardsForTesting,
  getCanvasCardState,
  minimapCardPreference,
  navigatorCardPreference,
  setCanvasCardState,
} from "./canvasCards.ts";

function setViewport(width: number, height = 800) {
  (window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } }).happyDOM.setViewport(
    { width, height },
  );
}

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  __resetCanvasCardsForTesting();
});

afterEach(() => setViewport(1024, 768));

describe("canvas cards on a phone", () => {
  beforeEach(() => setViewport(390, 844));

  it("start with the minimap hidden, and other cards folded", () => {
    expect(getCanvasCardState(minimapCardPreference)).toBe("hidden");
    expect(getCanvasCardState(navigatorCardPreference)).toBe("collapsed");
  });

  it("show the minimap and hide it again without storing either", () => {
    setCanvasCardState(minimapCardPreference, "open");
    expect(getCanvasCardState(minimapCardPreference)).toBe("open");
    setCanvasCardState(minimapCardPreference, "hidden");
    expect(getCanvasCardState(minimapCardPreference)).toBe("hidden");
    expect(getPreference(minimapCardPreference)).toBe("open");
  });

  it("keep a hide made elsewhere", () => {
    setViewport(1280, 800);
    setCanvasCardState(minimapCardPreference, "hidden");
    setViewport(390, 844);
    expect(getCanvasCardState(minimapCardPreference)).toBe("hidden");
    setCanvasCardState(minimapCardPreference, "open");
    expect(getPreference(minimapCardPreference)).toBe("open");
  });

  it("leave the desktop minimap as stored", () => {
    setCanvasCardState(minimapCardPreference, "open");
    setViewport(1280, 800);
    expect(getCanvasCardState(minimapCardPreference)).toBe("open");
  });
});
