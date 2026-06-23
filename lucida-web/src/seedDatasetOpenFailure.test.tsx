// @vitest-environment happy-dom
//
// Contract test for the "create workspace from dataset(s)" failure behavior
// (#697): a FAILED dataset import must LEAVE the created workspace in place and
// SURFACE the error — never abandon/delete the workspace, never silently
// swallow.
//
// The real wiring (App.tsx) is: the workspace is created + navigated into, then
// `useSeedDatasetOpens` opens the seed dataset(s) via `datasets.handleUrlSubmit`
// → `sendOpenRemoteDataset`. That send is fire-and-forget; a failure comes back
// asynchronously on the websocket and the bridge records it in
// `remoteDatasetError`, which the viewer renders while staying mounted. This
// harness reproduces exactly that separation — a fire-and-forget open plus an
// independent failure callback — so we can assert the contract without standing
// up the full WASM viewer. The open is "mocked to reject" per the slice's test
// spec by having the simulated server respond with a failure.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useSeedDatasetOpens } from "./hooks/useSeedDatasetOpens.ts";

afterEach(cleanup);

/**
 * Stand-in for the workspace viewer. It auto-opens the seed datasets exactly
 * like App.tsx does, and mirrors the bridge's open-failed → remoteDatasetError
 * surfacing. `onOpen` is the fire-and-forget send (the thing the slice spec
 * says to "mock to reject"); when it signals failure we record the error and
 * stay mounted.
 */
function FakeWorkspaceViewer({
  initialDatasetUrls,
  onOpen,
}: {
  initialDatasetUrls: readonly string[];
  // Returns a promise that RESOLVES on success or REJECTS on import failure —
  // the test injects the failure here. (In production the send never throws and
  // failure arrives over the socket; the observable contract is identical.)
  onOpen: (url: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  useSeedDatasetOpens({
    initialDatasetUrls,
    ready: true,
    openDataset: (url) => {
      // Fire-and-forget, exactly like bridge.sendOpenRemoteDataset: kick off the
      // open; a rejection (import failure) is surfaced, not rethrown.
      void onOpen(url).catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    },
  });

  return (
    <div data-testid="workspace-viewer">
      {error && <p data-testid="dataset-open-error">{error}</p>}
    </div>
  );
}

describe("create-from-dataset: failed import leaves the workspace + surfaces error", () => {
  it("keeps the workspace mounted and shows the error when the open rejects", async () => {
    const onOpen = vi
      .fn()
      .mockRejectedValue(new Error("dataset import failed: not a zarr group"));

    await act(async () => {
      render(
        <FakeWorkspaceViewer
          initialDatasetUrls={["/data/broken.zarr"]}
          onOpen={onOpen}
        />,
      );
    });

    // The open was attempted.
    expect(onOpen).toHaveBeenCalledWith("/data/broken.zarr");
    // The error is surfaced (not swallowed).
    expect(await screen.findByTestId("dataset-open-error")).toBeTruthy();
    expect(screen.getByTestId("dataset-open-error").textContent).toContain(
      "dataset import failed",
    );
    // The workspace viewer is STILL mounted — the workspace was not abandoned.
    expect(screen.getByTestId("workspace-viewer")).toBeTruthy();
  });

  it("opens all datasets; a later failure does not retract the others", async () => {
    const opened: string[] = [];
    const onOpen = vi.fn(async (url: string) => {
      opened.push(url);
      if (url === "/data/b.zarr") throw new Error("b failed");
    });

    await act(async () => {
      render(
        <FakeWorkspaceViewer
          initialDatasetUrls={["/data/a.zarr", "/data/b.zarr", "/data/c.zarr"]}
          onOpen={onOpen}
        />,
      );
    });

    expect(opened).toEqual(["/data/a.zarr", "/data/b.zarr", "/data/c.zarr"]);
    expect(await screen.findByTestId("dataset-open-error")).toBeTruthy();
    expect(screen.getByTestId("workspace-viewer")).toBeTruthy();
  });

  it("does not re-open on re-render (one-shot)", async () => {
    const onOpen = vi.fn().mockResolvedValue(undefined);
    let rerender: (ui: React.ReactElement) => void = () => {};

    await act(async () => {
      const r = render(
        <FakeWorkspaceViewer
          initialDatasetUrls={["/data/a.zarr"]}
          onOpen={onOpen}
        />,
      );
      rerender = r.rerender;
    });
    expect(onOpen).toHaveBeenCalledTimes(1);

    // Force a re-render with the SAME seed: must not re-open.
    await act(async () => {
      fireEvent.click(document.body); // no-op interaction
      rerender(
        <FakeWorkspaceViewer
          initialDatasetUrls={["/data/a.zarr"]}
          onOpen={onOpen}
        />,
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
