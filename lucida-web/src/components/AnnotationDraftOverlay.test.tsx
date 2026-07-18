// @vitest-environment happy-dom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationDraftOverlay } from "./AnnotationDraftOverlay.tsx";
import { AnnotationDraftStore } from "./annotationDraft.ts";

afterEach(cleanup);

describe("AnnotationDraftOverlay", () => {
  it("renders directly from draft events with a zero-callback idle budget", () => {
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame");
    const store = new AnnotationDraftStore();
    const { container } = render(<AnnotationDraftOverlay draft={store} />);

    expect(container.querySelector("rect")).toBeNull();
    expect(container.querySelector("line")).toBeNull();
    expect(requestFrame).not.toHaveBeenCalled();

    act(() => store.set({ kind: "box", x0: 20, y0: 30, x1: 5, y1: 8 }));
    const rect = container.querySelector("rect");
    expect(rect?.getAttribute("x")).toBe("5");
    expect(rect?.getAttribute("y")).toBe("8");
    expect(rect?.getAttribute("width")).toBe("15");
    expect(rect?.getAttribute("height")).toBe("22");
    expect(requestFrame).not.toHaveBeenCalled();

    act(() => store.set(null));
    expect(container.querySelector("rect")).toBeNull();
    expect(requestFrame).not.toHaveBeenCalled();
    requestFrame.mockRestore();
  });
});
