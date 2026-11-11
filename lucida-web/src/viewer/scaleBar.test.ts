import { describe, expect, it } from "vitest";
import { armLabel, parseScaleBar, scaleBarNote, scaleBarShown, type ScaleBarReading } from "./scaleBar.ts";

describe("scaleBarShown", () => {
  it("follows the setting on the viewer page", () => {
    expect(scaleBarShown(true, "")).toBe(true);
    expect(scaleBarShown(false, "?viewer_profile=a")).toBe(false);
  });

  it("stays off on the capture surface unless the URL asks", () => {
    expect(scaleBarShown(true, "?render=1")).toBe(false);
    expect(scaleBarShown(true, "?render=1&scale_bar=1")).toBe(true);
    expect(scaleBarShown(false, "?render=1&scale_bar=1")).toBe(true);
  });

  it("lets the URL turn it off whatever the setting", () => {
    expect(scaleBarShown(true, "?scale_bar=0")).toBe(false);
  });
});

describe("armLabel", () => {
  const arm = { axis: "z" as const, pixels: 80, label: "20 samples" };

  it("names the axis only when there are two arms", () => {
    expect(armLabel(arm, true)).toBe("Z 20 samples");
    expect(armLabel(arm, false)).toBe("20 samples");
    expect(armLabel({ ...arm, axis: null }, true)).toBe("20 samples");
  });
});

describe("parseScaleBar", () => {
  it("reads no bar from null", () => {
    expect(parseScaleBar("null")).toBeNull();
    expect(parseScaleBar("")).toBeNull();
  });
});

describe("scaleBarNote", () => {
  const reading: ScaleBarReading = {
    dataset_id: "a",
    measure: "length",
    per_pixel: [1e-7, 1e-7],
    across: { axis: null, pixels: 100, label: "10 µm" },
    down: null,
    at_orbit_center: false,
    scaled_by_hand: false,
  };

  it("says what qualifies the reading, and nothing otherwise", () => {
    expect(scaleBarNote(reading)).toBeNull();
    expect(scaleBarNote({ ...reading, scaled_by_hand: true })).toBe("scaled by hand");
    expect(scaleBarNote({ ...reading, at_orbit_center: true, scaled_by_hand: true })).toBe(
      "at orbit center, scaled by hand",
    );
  });
});
