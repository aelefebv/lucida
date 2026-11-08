import { describe, expect, it } from "vitest";

import { relativeTimeFromIso } from "./relativeTime.ts";

describe("relativeTimeFromIso", () => {
  it("renders 'just now' for sub-minute deltas", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    const outRef = relativeTimeFromIso("2026-05-08T11:59:50Z", now);
    expect(outRef.toLowerCase()).toMatch(/now|second/);
  });

  it("renders 'X days ago' for multi-day deltas", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    const outRef = relativeTimeFromIso("2026-05-05T12:00:00Z", now);
    expect(outRef.toLowerCase()).toMatch(/3.*day/);
  });

  it("returns empty string for invalid ISO", () => {
    expect(relativeTimeFromIso("not-a-date")).toBe("");
  });
});
