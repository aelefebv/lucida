import { describe, expect, it } from "vitest";

import { DeliveryState } from "./deliveryState.ts";

describe("DeliveryState", () => {
  it("counts the chunks the worker has not yet answered", () => {
    const state = new DeliveryState();
    state.markChunkSent("img", 0, "0/0/0/0/0/0");
    state.markChunkSent("img", 0, "0/0/0/0/0/1");
    state.markChunkSent("img", 0, "0/0/0/0/0/1");
    expect(state.chunksUnanswered).toBe(2);
    state.markChunkHeld("img", 0, "0/0/0/0/0/0");
    state.markChunkRefused("img", 0, "0/0/0/0/0/1");
    expect(state.chunksUnanswered).toBe(0);
    state.markChunkSent("img", 0, "0/0/0/0/0/2");
    state.clearChunksForImage("img");
    expect(state.chunksUnanswered).toBe(0);
  });

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
    state.markChunkRefused("img-0", 0, "1/0/0/0/0/0", "coarse");

    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "detail")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "coarse")).toBe(false);
  });

  it("holds a chunk only once the worker says so, and keeps it until the worker reports it lost", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a", "detail");
    expect(state.isChunkHeld("img-0", 0, "a", "detail")).toBe(false);

    state.markChunkHeld("img-0", 0, "a", "detail");
    expect(state.isChunkHeld("img-0", 0, "a", "detail")).toBe(true);
    // Sending again would only re-send what the worker holds.
    state.markChunkSent("img-0", 0, "a", "detail");
    expect(state.isChunkHeld("img-0", 0, "a", "detail")).toBe(true);

    state.markChunkLost("img-0", 0, "a", "detail");
    expect(state.wasChunkSent("img-0", 0, "a", "detail")).toBe(false);
  });

  it("lets a refused chunk go again", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a", "detail");
    state.markChunkRefused("img-0", 0, "a", "detail");
    expect(state.wasChunkSent("img-0", 0, "a", "detail")).toBe(false);
  });

  it("keeps a copy sent after a loss: the loss is of the slot it replaces", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a", "detail");
    state.markChunkLost("img-0", 0, "a", "detail");
    expect(state.wasChunkSent("img-0", 0, "a", "detail")).toBe(true);
    expect(state.isChunkHeld("img-0", 0, "a", "detail")).toBe(false);
  });

  it("treats a missing report as a disagreement only for a held chunk", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "sent", "detail");
    state.markChunkSent("img-0", 0, "held", "detail");
    state.markChunkHeld("img-0", 0, "held", "detail");

    // The report predates the answer to a chunk still in transit.
    expect(state.markChunkMissing("img-0", 0, "sent", "detail")).toBe(false);
    expect(state.wasChunkSent("img-0", 0, "sent", "detail")).toBe(true);
    expect(state.markChunkMissing("img-0", 0, "never", "detail")).toBe(false);

    expect(state.markChunkMissing("img-0", 0, "held", "detail")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "held", "detail")).toBe(false);
  });

  it("clears image-wide chunk state", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a");
    state.markChunkHeld("img-0", 1, "b");

    state.clearChunksForImage("img-0");
    expect(state.wasChunkSent("img-0", 0, "a")).toBe(false);
    expect(state.wasChunkSent("img-0", 1, "b")).toBe(false);
  });

  it("tracks proxy state by composite key and clears by key or dataset", () => {
    const state = new DeliveryState();
    state.markProxySent("ds1|tile-0|TileProxy3D|0|0");
    state.markProxySent("ds2|tile-0|TileProxy3D|0|0");

    state.clearProxySent("ds1|tile-0|TileProxy3D|0|0");
    expect(state.wasProxySent("ds1|tile-0|TileProxy3D|0|0")).toBe(false);
    expect(state.wasProxySent("ds2|tile-0|TileProxy3D|0|0")).toBe(true);

    state.clearProxySentForDataset("ds2");
    expect(state.wasProxySent("ds2|tile-0|TileProxy3D|0|0")).toBe(false);
  });
});
