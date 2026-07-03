// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, cleanup } from "@testing-library/react";

// Instance-recording double for the GPU worker wrapper: the real
// RenderClient transfers canvas control to a worker in its constructor,
// neither of which exists in this environment. Mirrors the real settle
// contract: ready() stays pending until the worker reports in, and
// destroy() rejects a still-pending ready().
vi.mock("../renderer/renderClient.ts", () => {
  class MockRenderClient {
    static instances: MockRenderClient[] = [];
    canvas: HTMLCanvasElement;
    private readyPromise: Promise<void>;
    private readyReject!: (err: Error) => void;
    destroy = vi.fn(() => {
      this.readyReject(new Error("RenderClient destroyed"));
    });
    constructor(canvas: HTMLCanvasElement) {
      this.canvas = canvas;
      this.readyPromise = new Promise<void>((_resolve, reject) => {
        this.readyReject = reject;
      });
      MockRenderClient.instances.push(this);
    }
    ready(): Promise<void> {
      return this.readyPromise;
    }
  }
  return { RenderClient: MockRenderClient };
});

import { useRenderClient } from "./useRenderClient.ts";
import { RenderClient } from "../renderer/renderClient.ts";

const MockedRenderClient = RenderClient as unknown as {
  instances: Array<{ canvas: HTMLCanvasElement; destroy: ReturnType<typeof vi.fn> }>;
};

/** Minimal host mirroring App's usage: a keyed canvas carrying the ref. */
function Host() {
  const renderClient = useRenderClient();
  // canvasKey is plain state and canvasRef is only ATTACHED here (not read);
  // the rule can't see through the hook's return object.
  // eslint-disable-next-line react-hooks/refs
  return <canvas key={renderClient.canvasKey} ref={renderClient.canvasRef} />;
}

beforeEach(() => {
  MockedRenderClient.instances.length = 0;
  cleanup();
});

describe("useRenderClient teardown", () => {
  it("creates one client per mount and destroys it on unmount", () => {
    const { unmount } = render(<Host />);

    expect(MockedRenderClient.instances).toHaveLength(1);
    expect(MockedRenderClient.instances[0].destroy).not.toHaveBeenCalled();

    unmount();
    expect(MockedRenderClient.instances[0].destroy).toHaveBeenCalledTimes(1);
  });

  it("StrictMode mount→cleanup→mount leaves one live client on a FRESH canvas", () => {
    const { unmount } = render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );

    // First client is destroyed by the simulated remount; the replacement
    // must be built against a different canvas element, because the first
    // element's control was already transferred to the dead client's worker.
    expect(MockedRenderClient.instances).toHaveLength(2);
    const [first, second] = MockedRenderClient.instances;
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).not.toHaveBeenCalled();
    expect(second.canvas).not.toBe(first.canvas);
    expect(second.canvas.isConnected).toBe(true);

    unmount();
    expect(second.destroy).toHaveBeenCalledTimes(1);
  });

  it("a destroy that preempts init settles ready() without logging an init failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // StrictMode destroys the first client while its ready() is still
      // pending — the resulting rejection is the settle path, not a
      // worker failure.
      render(
        <StrictMode>
          <Host />
        </StrictMode>,
      );
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(MockedRenderClient.instances[0].destroy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalledWith(
        "Render worker init failed:",
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
