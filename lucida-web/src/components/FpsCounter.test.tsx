// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderLoop } from "../renderLoop.ts";
import { FpsCounter } from "./FpsCounter.tsx";

afterEach(cleanup);

describe("FpsCounter", () => {
  it("updates only from renderer-presented frames and owns no browser cadence", () => {
    let presented: (() => void) | null = null;
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame");
    const snapshot = vi.fn(() => ({ fps: 47.5 }));
    const loop = {
      subscribePresentedFrame(listener: () => void) {
        presented = listener;
        return () => { presented = null; };
      },
      getDebugSnapshot: snapshot,
    } as unknown as RenderLoop;

    render(<FpsCounter loop={loop} />);
    expect(screen.getByLabelText("Presented frame rate: 0 frames per second")).toBeTruthy();
    expect(snapshot).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();

    act(() => presented?.());
    expect(screen.getByLabelText("Presented frame rate: 47.5 frames per second")).toBeTruthy();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(requestFrame).not.toHaveBeenCalled();
    requestFrame.mockRestore();
  });
});
