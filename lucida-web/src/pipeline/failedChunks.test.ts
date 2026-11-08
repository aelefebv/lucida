import { describe, expect, it } from "vitest";
import { failedChunkReport, failedChunksNotice, summarizeFailedChunks } from "./failedChunks.ts";
import type { FailedChunk } from "./fetch/index.ts";

const chunk = (datasetId: string, chunkKey: string, failure: FailedChunk["failure"]): FailedChunk => ({
  datasetId,
  imageId: `${datasetId}-image`,
  chunkKey,
  failure,
});

describe("failed chunk summaries", () => {
  it("counts each dataset's failures by reason, most first", () => {
    const summaries = summarizeFailedChunks([
      chunk("a", "0/0/0/0/0/0", "wrong_size"),
      chunk("a", "0/0/0/0/0/1", "corrupt_chunk"),
      chunk("b", "0/0/0/0/0/0", null),
      chunk("a", "0/0/0/0/1/0", "corrupt_chunk"),
    ]);
    expect(summaries.get("a")).toEqual({
      count: 3,
      byReason: [
        { failure: "corrupt_chunk", count: 2 },
        { failure: "wrong_size", count: 1 },
      ],
    });
    expect(summaries.get("b")).toEqual({ count: 1, byReason: [{ failure: null, count: 1 }] });
  });

  it("says how many chunks failed, why, and what the hatch means", () => {
    expect(failedChunksNotice({ count: 1, byReason: [{ failure: "corrupt_chunk", count: 1 }] }))
      .toBe("1 chunk could not be read (corrupt), so its region shows hatched.");
    expect(failedChunksNotice({
      count: 5,
      byReason: [{ failure: "corrupt_chunk", count: 3 }, { failure: null, count: 2 }],
    })).toBe("5 chunks could not be read (3 corrupt, 2 no reason given), so their regions show hatched.");
  });
});

describe("the page's failed chunk report", () => {
  it("hands out one summary object per publication and tells subscribers", () => {
    let heard = 0;
    const unsubscribe = failedChunkReport.subscribe(() => heard++);
    failedChunkReport.publish(summarizeFailedChunks([chunk("a", "0/0/0/0/0/0", "permission")]));
    const first = failedChunkReport.get("a");
    expect(first?.count).toBe(1);
    expect(failedChunkReport.get("a")).toBe(first);
    expect(failedChunkReport.get("b")).toBeNull();
    failedChunkReport.publish(new Map());
    expect(failedChunkReport.get("a")).toBeNull();
    // Empty to empty is no change.
    failedChunkReport.publish(new Map());
    expect(heard).toBe(2);
    unsubscribe();
  });
});
