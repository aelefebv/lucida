// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

// Instance-recording double for the GPU worker wrapper: the real
// RenderClient transfers canvas control to a worker in its constructor,
// neither of which exists in this environment. Mirrors the real settle
// contract: ready() stays pending until the worker reports in, and
// destroy() rejects a still-pending ready().
vi.mock("../renderer/renderClient.ts", () => {
  class MockRenderClient {
    static instances: MockRenderClient[] = [];
    static constructionError: Error | null = null;
    canvas: HTMLCanvasElement;
    private readyPromise: Promise<void>;
    private readyReject!: (err: Error) => void;
    onFailure: ((error: Error) => void) | null = null;
    destroy = vi.fn(() => {
      this.readyReject(new Error("RenderClient destroyed"));
    });
    constructor(canvas: HTMLCanvasElement) {
      const constructionError = MockRenderClient.constructionError;
      MockRenderClient.constructionError = null;
      if (constructionError) throw constructionError;
      this.canvas = canvas;
      this.readyPromise = new Promise<void>((_resolve, reject) => {
        this.readyReject = reject;
      });
      MockRenderClient.instances.push(this);
    }
    ready(): Promise<void> {
      return this.readyPromise;
    }
    fail(message: string, code?: string): void {
      this.onFailure?.(Object.assign(new Error(message), { code }));
    }
  }
  return { RenderClient: MockRenderClient };
});

import { useRenderClient } from "./useRenderClient.ts";
import { RenderClient } from "../renderer/renderClient.ts";

const MockedRenderClient = RenderClient as unknown as {
  constructionError: Error | null;
  instances: Array<{
    canvas: HTMLCanvasElement;
    destroy: ReturnType<typeof vi.fn>;
    fail(message: string, code?: string): void;
  }>;
};

/** Minimal host mirroring App's usage: a keyed canvas carrying the ref. */
function Host() {
  const {
    canvasKey,
    canvasRef,
    retryRender,
    renderError,
    renderErrorCode,
  } = useRenderClient();
  return <>
    <canvas key={canvasKey} ref={canvasRef} />
    <button type="button" onClick={retryRender}>retry</button>
    {renderError && <p role="alert" data-error-code={renderErrorCode}>{renderError}</p>}
  </>;
}

beforeEach(() => {
  MockedRenderClient.instances.length = 0;
  MockedRenderClient.constructionError = null;
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

  it("surfaces a terminal runtime failure and retries on a fresh canvas", async () => {
    const view = render(<Host />);
    const first = MockedRenderClient.instances[0];
    first.fail("device lost");

    expect((await view.findByRole("alert")).textContent).toContain("device lost");
    fireEvent.click(view.getByRole("button", { name: "retry" }));

    await waitFor(() => expect(MockedRenderClient.instances).toHaveLength(2));
    const second = MockedRenderClient.instances[1];
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.canvas).not.toBe(first.canvas);
  });

  it("surfaces synchronous worker construction failure and retries on a fresh canvas", async () => {
    MockedRenderClient.constructionError = new Error("GPU worker construction blocked");
    const view = render(<Host />);
    const failedCanvas = view.container.querySelector("canvas");

    expect((await view.findByRole("alert")).textContent)
      .toContain("GPU worker construction blocked");
    expect(MockedRenderClient.instances).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "retry" }));

    await waitFor(() => expect(MockedRenderClient.instances).toHaveLength(1));
    expect(MockedRenderClient.instances[0].canvas).not.toBe(failedCanvas);
  });

  it("exposes the stable GPU classification to the UI", async () => {
    const view = render(<Host />);
    MockedRenderClient.instances[0].fail(
      "WebGPU ran out of memory",
      "gpu-out-of-memory",
    );

    expect((await view.findByRole("alert")).dataset.errorCode)
      .toBe("gpu-out-of-memory");
  });
});
