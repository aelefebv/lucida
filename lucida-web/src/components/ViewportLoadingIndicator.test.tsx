// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewportLoadingTracker } from "../viewportLoadingState.ts";
import { ViewportLoadingIndicator } from "./ViewportLoadingIndicator.tsx";

describe("ViewportLoadingIndicator", () => {
  it("shows the current discrete transition and exact residency progress", () => {
    const tracker = new ViewportLoadingTracker();
    render(<ViewportLoadingIndicator store={tracker} />);

    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      tracker.begin({
        source: "collection_group_click",
        targetFrameId: 4,
        minimumEpochs: { view: 8, content: 1, selection: 2, layout: 3, request: 4 },
        datasetIds: ["wide-collection"],
      });
    });
    expect(screen.getByRole("status").textContent).toContain("Loading group");
    expect(screen.getByRole("status").textContent).toContain("Checking available data");

    act(() => {
      tracker.wantedSet("wide-collection", { view: 8, content: 1, selection: 2, layout: 3, request: 4 }, 1_204);
    });
    expect(screen.getByRole("status").textContent).toContain("1,204 chunks remaining");

    act(() => {
      tracker.framePresented(4);
      tracker.wantedSet("wide-collection", { view: 8, content: 1, selection: 2, layout: 3, request: 4 }, 0);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
