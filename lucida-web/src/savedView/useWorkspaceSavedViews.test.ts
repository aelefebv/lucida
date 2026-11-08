import { describe, it, expect } from "vitest";
import { defaultWorkspaceSavedViewName } from "./useWorkspaceSavedViews.ts";

describe("defaultWorkspaceSavedViewName", () => {
  it("names the position counted from 1, with T only off its first position", () => {
    expect(defaultWorkspaceSavedViewName(["volume"], null, { z_range: { start: 0, end: 1 }, t: 0 })).toBe(
      "volume — Z 1",
    );
    expect(defaultWorkspaceSavedViewName(["volume"], null, { z_range: { start: 170, end: 171 }, t: 4 })).toBe(
      "volume — Z 171 · T 5",
    );
  });
});
