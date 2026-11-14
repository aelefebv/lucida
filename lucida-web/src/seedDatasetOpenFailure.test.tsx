// @vitest-environment happy-dom
//
// Contract: a failed dataset import in "create workspace from datasets" leaves
// the created workspace in place and surfaces the error.
//
// In App.tsx the seed open is fire-and-forget, and a failure arrives later over
// the socket into `remoteDatasetError`. This harness reproduces that split, a
// fire-and-forget open plus an independent failure callback, without the WASM
// viewer.

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
 * Stand-in for the workspace viewer. It auto-opens the seed datasets as App.tsx
 * does; when the fire-and-forget `onOpen` fails it records the error and stays
 * mounted.
 */
function FakeWorkspaceViewer({
  initialDatasetUrls,
  onOpen,
}: {
  initialDatasetUrls: readonly string[];
  // Rejects on import failure; the test injects the failure here. In production
  // the failure arrives over the socket, with the same observable contract.
  onOpen: (url: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  useSeedDatasetOpens({
    seed: { urls: initialDatasetUrls, sideBySide: false },
    ready: true,
    viewsForEach: () => [],
    openDataset: (url) => {
      // Fire-and-forget, like bridge.sendOpenRemoteDataset: a rejection is
      // surfaced, not rethrown.
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
    // The workspace viewer is still mounted; the workspace was not abandoned.
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

    // Force a re-render with the same seed: must not re-open.
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
