import { describe, expect, it } from "vitest";

import { DeliveryState } from "./deliveryState.ts";

describe("DeliveryState", () => {
  it("counts the chunks the worker has not yet answered", () => {
    const state = new DeliveryState();
    state.markChunkSent("img", 0, "0/0/0/0/0/0", "detail", "slice");
    state.markChunkSent("img", 0, "0/0/0/0/0/1", "detail", "slice");
    state.markChunkSent("img", 0, "0/0/0/0/0/1", "detail", "slice");
    expect(state.chunksUnanswered).toBe(2);
    state.markChunkHeld("img", 0, "0/0/0/0/0/0", "detail", "slice");
    state.markChunkRefused("img", 0, "0/0/0/0/0/1", "detail", "slice");
    expect(state.chunksUnanswered).toBe(0);
    state.markChunkSent("img", 0, "0/0/0/0/0/2", "detail", "slice");
    state.clearChunksForImage("img");
    expect(state.chunksUnanswered).toBe(0);
  });

  it("tracks chunk sent state by image, channel, and chunk key", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 1, "0/0/1/0/0/0", "detail", "slice");

    expect(state.wasChunkSent("img-0", 1, "0/0/1/0/0/0", "detail", "slice")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "0/0/1/0/0/0", "detail", "slice")).toBe(false);
    expect(state.wasChunkSent("img-1", 1, "0/0/1/0/0/0", "detail", "slice")).toBe(false);
  });

  it("tracks the same chunk key independently per residency tier", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "1/0/0/0/0/0", "detail", "slice");

    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "detail", "slice")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "coarse", "slice")).toBe(false);

    state.markChunkSent("img-0", 0, "1/0/0/0/0/0", "coarse", "slice");
    state.markChunkRefused("img-0", 0, "1/0/0/0/0/0", "coarse", "slice");

    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "detail", "slice")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "1/0/0/0/0/0", "coarse", "slice")).toBe(false);
  });

  it("tracks the same chunk independently per pool mode", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a", "detail", "slice");
    state.markChunkHeld("img-0", 0, "a", "detail", "slice");

    expect(state.isChunkHeld("img-0", 0, "a", "detail", "slice")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "a", "detail", "volume")).toBe(false);

    state.markChunkSent("img-0", 0, "a", "detail", "volume");
    state.markChunkLost("img-0", 0, "a", "detail", "slice");
    expect(state.wasChunkSent("img-0", 0, "a", "detail", "slice")).toBe(false);
    expect(state.wasChunkSent("img-0", 0, "a", "detail", "volume")).toBe(true);
  });

  it("holds a chunk only once the worker says so, and keeps it until the worker reports it lost", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a", "detail", "slice");
    expect(state.isChunkHeld("img-0", 0, "a", "detail", "slice")).toBe(false);

    state.markChunkHeld("img-0", 0, "a", "detail", "slice");
    expect(state.isChunkHeld("img-0", 0, "a", "detail", "slice")).toBe(true);
    // Sending again would only re-send what the worker holds.
    state.markChunkSent("img-0", 0, "a", "detail", "slice");
    expect(state.isChunkHeld("img-0", 0, "a", "detail", "slice")).toBe(true);

    state.markChunkLost("img-0", 0, "a", "detail", "slice");
    expect(state.wasChunkSent("img-0", 0, "a", "detail", "slice")).toBe(false);
  });

  it("lets a refused chunk go again", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a", "detail", "slice");
    state.markChunkRefused("img-0", 0, "a", "detail", "slice");
    expect(state.wasChunkSent("img-0", 0, "a", "detail", "slice")).toBe(false);
  });

  it("keeps a copy sent after a loss: the loss is of the slot it replaces", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a", "detail", "slice");
    state.markChunkLost("img-0", 0, "a", "detail", "slice");
    expect(state.wasChunkSent("img-0", 0, "a", "detail", "slice")).toBe(true);
    expect(state.isChunkHeld("img-0", 0, "a", "detail", "slice")).toBe(false);
  });

  it("treats a missing report as a disagreement only for a held chunk", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "sent", "detail", "slice");
    state.markChunkSent("img-0", 0, "held", "detail", "slice");
    state.markChunkHeld("img-0", 0, "held", "detail", "slice");

    // The report predates the answer to a chunk still in transit.
    expect(state.markChunkMissing("img-0", 0, "sent", "detail", "slice")).toBe(false);
    expect(state.wasChunkSent("img-0", 0, "sent", "detail", "slice")).toBe(true);
    expect(state.markChunkMissing("img-0", 0, "never", "detail", "slice")).toBe(false);

    expect(state.markChunkMissing("img-0", 0, "held", "detail", "slice")).toBe(true);
    expect(state.wasChunkSent("img-0", 0, "held", "detail", "slice")).toBe(false);
  });

  it("clears image-wide chunk state", () => {
    const state = new DeliveryState();
    state.markChunkSent("img-0", 0, "a", "detail", "slice");
    state.markChunkHeld("img-0", 1, "b", "detail", "slice");

    state.clearChunksForImage("img-0");
    expect(state.wasChunkSent("img-0", 0, "a", "detail", "slice")).toBe(false);
    expect(state.wasChunkSent("img-0", 1, "b", "detail", "slice")).toBe(false);
  });
});
