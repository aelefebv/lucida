import { describe, expect, it } from "vitest";
import {
  computeMemberIndexMap,
  iterateColdMembers,
  memberIdForColdEntry,
} from "../descriptorBuffer.ts";
import { makeColdEntry, makeColdMessage } from "../testFixtures.ts";

describe("cold-state member identity", () => {
  it("uses the image id for a single-channel member", () => {
    const entry = makeColdEntry({ entityId: "entity-a", imageId: "image-a" });
    expect(memberIdForColdEntry(entry, 0, false)).toBe("image-a");
  });

  it("suffixes the image id in explicit multi-channel mode", () => {
    const entry = makeColdEntry({ entityId: "entity-a", imageId: "image-a" });
    expect(memberIdForColdEntry(entry, 2, true)).toBe("image-a:ch2");
  });

  it("iterates active entries outermost and visible channels innermost", () => {
    const cold = makeColdMessage(
      [
        makeColdEntry({ entityId: "a", imageId: "image-a" }),
        makeColdEntry({ entityId: "b", imageId: "image-b" }),
      ],
      { multiChannel: true, visibleChannels: [0, 2] },
    );
    expect([...iterateColdMembers(cold)].map(({ memberId }) => memberId)).toEqual([
      "image-a:ch0",
      "image-a:ch2",
      "image-b:ch0",
      "image-b:ch2",
    ]);
  });

  it("honors explicit multi-channel mode with only one visible channel", () => {
    const cold = makeColdMessage(
      [makeColdEntry({ entityId: "a", imageId: "image-a" })],
      { multiChannel: true, visibleChannels: [2] },
    );
    expect([...iterateColdMembers(cold)].map(({ memberId }) => memberId))
      .toEqual(["image-a:ch2"]);
  });

  it("assigns dense descriptor indices in canonical first-seen order", () => {
    const cold = makeColdMessage([
      makeColdEntry({ entityId: "a", imageId: "shared" }),
      makeColdEntry({ entityId: "b", imageId: "shared" }),
      makeColdEntry({ entityId: "c", imageId: "other" }),
    ]);
    expect([...computeMemberIndexMap(cold)]).toEqual([
      ["shared", 0],
      ["other", 1],
    ]);
  });
});
