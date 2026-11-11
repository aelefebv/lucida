import { describe, expect, it } from "vitest";
import { noticesLabel, viewNotices } from "./viewNotices.ts";

describe("viewNotices", () => {
  it("puts warnings first and keeps each notice's key while its numbers change", () => {
    const notices = viewNotices({
      coverage: { wanted: 100, short: 40 },
      links: [{ kind: "depth" }, { kind: "time", last: 1 }],
      setAside: "1 other layer is hidden while comparing.",
    });
    expect(notices.map((notice) => [notice.key, notice.severity])).toEqual([
      ["coverage", "warning"],
      ["link-time", "warning"],
      ["link-depth", "note"],
      ["set-aside", "note"],
    ]);
    const later = viewNotices({ coverage: { wanted: 100, short: 7 }, links: [], setAside: null });
    expect(later.map((notice) => notice.key)).toEqual(["coverage"]);
    expect(later[0].message).toContain("7 of the 100");
  });

  it("has none for a view that covers what it asks for", () => {
    expect(viewNotices({ coverage: { wanted: 100, short: 0 }, links: [], setAside: null })).toEqual([]);
  });

  it("names the count and the most severe notice", () => {
    const notices = viewNotices({ coverage: { wanted: 10, short: 2 }, links: [{ kind: "position" }], setAside: null });
    expect(noticesLabel(notices)).toBe(`2 notices: ${notices[0].message}`);
    expect(noticesLabel(notices.slice(1))).toBe("1 notice: The linked position is outside this view's data.");
  });
});
