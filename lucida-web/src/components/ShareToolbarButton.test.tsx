// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVED_VIEW_VERSION, type SavedView } from "../savedView/types.ts";
import type { CommittedShareLink } from "../savedView/urlSync.ts";
import { ShareToolbarButton } from "./ShareToolbarButton.tsx";

function view(): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [4, 8], zoom: 2, viewport: [800, 600] },
    view: { z_range: { start: 1, end: 2 }, t: 0, c: 0, multi_channel: false },
    display: { contrast_min: 0, contrast_max: 255, gamma: 1 },
    dataset_order: [],
    dataset_settings: {},
  };
}

const committed: CommittedShareLink = {
  url: "http://localhost/w/ws-1#view=current",
  view: view(),
};

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShareToolbarButton failure recovery", () => {
  it("shows a capture/encode failure and retries with a fresh committed link", async () => {
    const prepareShareLink = vi.fn()
      .mockRejectedValueOnce(new Error("could not encode current view"))
      .mockResolvedValueOnce(committed);
    render(<ShareToolbarButton prepareShareLink={prepareShareLink} />);

    await userEvent.click(screen.getByRole("button", { name: "Share view" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not copy this view: could not encode current view",
    );
    expect(writeText).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(committed.url));
    expect(prepareShareLink).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows clipboard failure and retry recaptures rather than copying stale state", async () => {
    const next: CommittedShareLink = {
      ...committed,
      url: "http://localhost/w/ws-1#view=retry-current",
    };
    const prepareShareLink = vi.fn()
      .mockResolvedValueOnce(committed)
      .mockResolvedValueOnce(next);
    writeText
      .mockRejectedValueOnce(new Error("clipboard denied"))
      .mockResolvedValueOnce(undefined);
    render(<ShareToolbarButton prepareShareLink={prepareShareLink} />);

    await userEvent.click(screen.getByRole("button", { name: "Share view" }));
    expect((await screen.findByRole("alert")).textContent).toContain("clipboard denied");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(next.url));
    expect(prepareShareLink).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});
