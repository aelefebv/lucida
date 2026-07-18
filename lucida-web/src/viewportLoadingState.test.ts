import { describe, expect, it, vi } from "vitest";
import {
  IDLE_VIEWPORT_LOADING_STATE,
  isDiscreteViewportTransition,
  ViewportLoadingTracker,
} from "./viewportLoadingState.ts";

const epochs = (view: number, selection = view) => ({
  content: 1,
  layout: 1,
  view,
  selection,
  request: 1,
});

describe("ViewportLoadingTracker", () => {
  it("waits for both current residency truth and the correlated GPU frame", () => {
    const tracker = new ViewportLoadingTracker();
    tracker.begin({
      source: "dimension_t",
      targetFrameId: 7,
      minimumEpochs: epochs(4),
      datasetIds: ["a", "b"],
    });

    expect(tracker.getViewportLoadingState()).toMatchObject({
      phase: "evaluating",
      missingChunks: null,
    });
    tracker.wantedSet("a", epochs(4), 3);
    expect(tracker.getViewportLoadingState().phase).toBe("evaluating");
    tracker.wantedSet("b", epochs(4), 2);
    expect(tracker.getViewportLoadingState()).toMatchObject({
      phase: "loading",
      missingChunks: 5,
    });

    tracker.framePresented(6);
    tracker.wantedSet("a", epochs(4), 0);
    tracker.wantedSet("b", epochs(4), 0);
    expect(tracker.getViewportLoadingState().phase).toBe("evaluating");

    tracker.framePresented(7);
    expect(tracker.getViewportLoadingState()).toBe(IDLE_VIEWPORT_LOADING_STATE);
  });

  it("ignores stale wanted sets during rapid navigation", () => {
    const tracker = new ViewportLoadingTracker();
    tracker.begin({
      source: "collection_group_click",
      targetFrameId: 10,
      minimumEpochs: epochs(8),
      datasetIds: ["collection"],
    });

    tracker.wantedSet("collection", epochs(7), 0);
    tracker.framePresented(10);
    expect(tracker.getViewportLoadingState().phase).toBe("evaluating");

    tracker.wantedSet("collection", epochs(8), 12);
    expect(tracker.getViewportLoadingState()).toMatchObject({
      phase: "loading",
      missingChunks: 12,
    });
  });

  it("rejects an old selection when the camera view epoch is unchanged", () => {
    const tracker = new ViewportLoadingTracker();
    tracker.begin({
      source: "dimension_t",
      targetFrameId: 20,
      minimumEpochs: epochs(5, 9),
      datasetIds: ["collection"],
    });

    tracker.wantedSet("collection", epochs(5, 8), 0);
    tracker.framePresented(20);
    expect(tracker.getViewportLoadingState().phase).toBe("evaluating");

    tracker.wantedSet("collection", epochs(5, 9), 4);
    expect(tracker.getViewportLoadingState()).toMatchObject({
      phase: "loading",
      missingChunks: 4,
    });
  });

  it("keeps the chip but discards acknowledgements after continuous motion", () => {
    const tracker = new ViewportLoadingTracker();
    tracker.begin({
      source: "collection_group_click",
      targetFrameId: 20,
      minimumEpochs: epochs(5, 8),
      datasetIds: ["collection"],
    });
    tracker.wantedSet("collection", epochs(5, 8), 0);
    const transitionId = tracker.getViewportLoadingState().transitionId;

    tracker.advance({
      targetFrameId: 21,
      minimumEpochs: epochs(6, 8),
      datasetIds: ["collection"],
    });
    tracker.framePresented(20);
    tracker.wantedSet("collection", epochs(5, 8), 0);
    expect(tracker.getViewportLoadingState()).toMatchObject({
      phase: "evaluating",
      source: "collection_group_click",
      transitionId,
      missingChunks: null,
    });

    tracker.wantedSet("collection", epochs(6, 8), 0);
    tracker.framePresented(21);
    expect(tracker.getViewportLoadingState().phase).toBe("idle");
  });

  it("publishes semantic changes and removes datasets without hanging", () => {
    const tracker = new ViewportLoadingTracker();
    const listener = vi.fn();
    tracker.subscribeViewportLoading(listener);
    tracker.begin({
      source: "loop_start",
      targetFrameId: 1,
      minimumEpochs: epochs(0, 0),
      datasetIds: ["gone"],
    });
    tracker.removeDataset("gone");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(tracker.getViewportLoadingState()).toBe(IDLE_VIEWPORT_LOADING_STATE);
  });

  it("classifies discrete replacement transitions without flagging continuous motion", () => {
    expect(isDiscreteViewportTransition("dimension_t")).toBe(true);
    expect(isDiscreteViewportTransition("collection_group_click")).toBe(true);
    expect(isDiscreteViewportTransition("auto_contrast")).toBe(false);
    expect(isDiscreteViewportTransition("external")).toBe(false);
  });
});
