import { describe, expect, it } from "vitest";

import { DeliveryState } from "./deliveryState.ts";

describe("DeliveryState", () => {
  it("tracks chunk sent state by image, channel, and chunk key", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 1, "0/0/1/0/0/0");

    expect(state.wasChunkSent("img-0", 1, "0/0/1/0/0/0")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "0/0/1/0/0/0")).toBe(false);
    expect(state.wasChunkSent("img-1", 1, "0/0/1/0/0/0")).toBe(false);
  });

  it("tracks the same chunk key independently per residency tier", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "1/0/0/0/0/0", "detail");

    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "detail")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "coarse")).toBe(false);

    state.markChunkSent("img-0", 0, "1/0/0/0/0/0", "coarse");
    state.clearChunkSent("img-0", 0, "1/0/0/0/0/0", "coarse");

    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "detail")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "coarse")).toBe(false);

    state.clearChunkSent("img-0", 0, "1/0/0/0/0/0");
    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "detail")).toBe(false);
  });

  it("clears individual chunk keys and image-wide chunk state", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a");
    state.markChunkSent("img-0", 1, "b");
    state.clearChunkSent("img-0", 0, "a");

    expect(state.wasChunkSent("img-0", 0, "a")).toBe(false);
    expect(state.wasChunkSent("img-0", 1, "b")).toBe(true);

    state.clearChunksForImage("img-0");
    expect(state.wasChunkSent("img-0", 1, "b")).toBe(false);
  });

  it("clears chunk state but preserves proxy state on plan rebuild", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a");
    state.markProxySent("ds1|field-0|FieldProxy3D|0|0");

    state.onPlanRebuildStart();

    expect(state.wasChunkSent("img-0", 0, "a")).toBe(false);
    expect(state.wasProxySent("ds1|field-0|FieldProxy3D|0|0")).toBe(true);
  });

  it("tracks proxy state by composite key and clears by key or dataset", () => {
    const state = new DeliveryState();
    state.markProxySent("ds1|field-0|FieldProxy3D|0|0");
    state.markProxySent("ds2|field-0|FieldProxy3D|0|0");

    state.clearProxySent("ds1|field-0|FieldProxy3D|0|0");
    expect(state.wasProxySent("ds1|field-0|FieldProxy3D|0|0")).toBe(false);
    expect(state.wasProxySent("ds2|field-0|FieldProxy3D|0|0")).toBe(true);

    state.clearProxySentForDataset("ds2");
    expect(state.wasProxySent("ds2|field-0|FieldProxy3D|0|0")).toBe(false);
  });
});
