import { describe, expect, it } from "vitest";

import { relativeTimeFromIso } from "./relativeTime.ts";

describe("relativeTimeFromIso", () => {
  const now = new Date("2026-05-08T12:00:00Z");

  it("formats recent and multi-day timestamps", () => {
    expect(relativeTimeFromIso("2026-05-08T11:59:50Z", now).toLowerCase()).toMatch(
      /now|second/,
    );
    expect(relativeTimeFromIso("2026-05-05T12:00:00Z", now).toLowerCase()).toMatch(
      /3.*day/,
    );
  });

  it("returns an empty label for invalid input", () => {
    expect(relativeTimeFromIso("not-a-date", now)).toBe("");
  });
});
