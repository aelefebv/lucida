import { describe, expect, it } from "vitest";

import { DeliveryState } from "./deliveryState.ts";

describe("DeliveryState", () => {
  it("tracks chunk sent state by image, channel, and chunk key", () => {
    const state = new DeliveryState();
    state.markChunkSent("ds-0", "img-0", 1, "0/0/1/0/0/0");

    expect(state.wasChunkSent("ds-0", "img-0", 1, "0/0/1/0/0/0")).toBe(true);
    expect(state.wasChunkSent("ds-0", "img-0", 0, "0/0/1/0/0/0")).toBe(false);
    expect(state.wasChunkSent("ds-0", "img-1", 1, "0/0/1/0/0/0")).toBe(false);
    expect(state.wasChunkSent("ds-1", "img-0", 1, "0/0/1/0/0/0")).toBe(false);
  });

  it("tracks the same chunk key independently per residency tier", () => {
    const state = new DeliveryState();
    state.markChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0", "detail");

    expect(state.wasChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0", "detail")).toBe(true);
    expect(state.wasChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0", "coarse")).toBe(false);

    state.markChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0", "coarse");
    state.clearChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0", "coarse");

    expect(state.wasChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0", "detail")).toBe(true);
    expect(state.wasChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0", "coarse")).toBe(false);

    state.clearChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0");
    expect(state.wasChunkSent("ds-0", "img-0", 0, "1/0/0/0/0/0", "detail")).toBe(false);
  });

  it("clears individual chunk keys and image-wide chunk state", () => {
    const state = new DeliveryState();
    state.markChunkSent("ds-0", "img-0", 0, "a");
    state.markChunkSent("ds-0", "img-0", 1, "b");
    state.clearChunkSent("ds-0", "img-0", 0, "a");

    expect(state.wasChunkSent("ds-0", "img-0", 0, "a")).toBe(false);
    expect(state.wasChunkSent("ds-0", "img-0", 1, "b")).toBe(true);

    state.clearChunksForImage("ds-0", "img-0");
    expect(state.wasChunkSent("ds-0", "img-0", 1, "b")).toBe(false);
  });

  it("clears chunk state on plan rebuild", () => {
    const state = new DeliveryState();
    state.markChunkSent("ds-0", "img-0", 0, "a");

    state.onPlanRebuildStart();

    expect(state.wasChunkSent("ds-0", "img-0", 0, "a")).toBe(false);
  });
});
