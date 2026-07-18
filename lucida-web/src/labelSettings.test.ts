import { describe, expect, it } from "vitest";
import {
  DEFAULT_LABEL_OPACITY,
  DEFAULT_LABEL_SETTINGS,
  DEFAULT_LABEL_VISIBLE,
  normalizeLabelOpacity,
  resolveLabelSettings,
} from "./labelSettings.ts";

describe("label settings contract", () => {
  it("uses the same named default for absent and short legacy arrays", () => {
    expect(resolveLabelSettings(undefined, 0)).toEqual(DEFAULT_LABEL_SETTINGS);
    expect(resolveLabelSettings([{ visible: true, opacity: 0.25 }], 1)).toEqual(
      DEFAULT_LABEL_SETTINGS,
    );
    expect(DEFAULT_LABEL_VISIBLE).toBe(false);
    expect(DEFAULT_LABEL_OPACITY).toBe(0.5);
  });

  it("honors explicit visibility and normalizes untrusted opacity", () => {
    expect(resolveLabelSettings([{ visible: true, opacity: 1.5 }], 0)).toEqual({
      visible: true,
      opacity: 1,
    });
    expect(normalizeLabelOpacity(Number.NaN)).toBe(DEFAULT_LABEL_OPACITY);
    expect(normalizeLabelOpacity(-1)).toBe(0);
  });
});
