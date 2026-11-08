// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { DatasetSourceHealth } from "../bridge.ts";
import type { DatasetManifest } from "../manifestTypes.ts";
import { DatasetInfoPanel, type InfoDataset } from "./DatasetInfoPanel.tsx";

afterEach(cleanup);

const dataset: InfoDataset = {
  id: "wds-1",
  name: "tiles.zarr",
  manifest: {
    kind: "Single",
    images: [
      {
        multiscale: {
          levels: [{ level_index: 0, shape: [1, 2, 1, 64, 64] }],
          data_type: "Uint16",
          channel_infos: [],
        },
      },
    ],
  } as unknown as DatasetManifest,
};

function health(overrides: Partial<DatasetSourceHealth> = {}): DatasetSourceHealth {
  return {
    workspace_dataset_id: "wds-1",
    name: "tiles.zarr",
    status: "healthy",
    source_url: "/data/tiles.zarr",
    binding: { status: "healthy", message: "server binding is ready" },
    generated_coarse: {
      status: "healthy",
      level_count: 0,
      ready_chunks: 0,
      pending_chunks: 0,
      failed_chunks: 0,
      unavailable_chunks: 0,
    },
    ...overrides,
  };
}

function healthSection() {
  return screen.getByRole("heading", { name: "Health" }).closest("section")!;
}

describe("DatasetInfoPanel", () => {
  it("shows the status and what the import found, marking what makes the data show wrong", async () => {
    const getHealth = vi.fn(async () =>
      health({
        status: "degraded",
        import_warnings: [
          { target: "wds-1", message: "tiles differ in size", degrades: true },
          { target: "B/2", message: "skipped group \"B/2\"", degrades: false },
        ],
      }),
    );
    render(<DatasetInfoPanel visible workspaceId="ws" dataset={dataset} getHealth={getHealth} />);

    const section = healthSection();
    expect(await within(section).findByText("Degraded")).toBeTruthy();
    const details = within(section).getByRole("list", { name: "Health details" });
    const items = within(details).getAllByRole("listitem");
    expect(items.map((li) => [li.textContent, li.hasAttribute("data-degrades")])).toEqual([
      ["tiles differ in size", true],
      ["skipped group \"B/2\"", false],
    ]);
    expect(screen.getByText("/data/tiles.zarr")).toBeTruthy();
    expect(getHealth).toHaveBeenCalledWith("wds-1");
  });

  it("names the server's own trouble serving the dataset", async () => {
    const getHealth = vi.fn(async () =>
      health({
        status: "unavailable",
        binding: { status: "unavailable", message: "server binding is missing; chunks cannot be served" },
      }),
    );
    render(<DatasetInfoPanel visible workspaceId="ws" dataset={dataset} getHealth={getHealth} />);

    const section = healthSection();
    expect(await within(section).findByText("Unavailable")).toBeTruthy();
    expect(within(section).getByText("server binding is missing; chunks cannot be served")).toBeTruthy();
  });

  it("lists nothing for a healthy dataset", async () => {
    render(<DatasetInfoPanel visible workspaceId="ws" dataset={dataset} getHealth={async () => health()} />);

    const section = healthSection();
    expect(await within(section).findByText("Healthy")).toBeTruthy();
    expect(within(section).queryByRole("list", { name: "Health details" })).toBeNull();
  });

  it("says when health is not available", async () => {
    render(
      <DatasetInfoPanel
        visible
        workspaceId="ws"
        dataset={dataset}
        getHealth={() => Promise.reject(new Error("offline"))}
      />,
    );

    expect(await within(healthSection()).findByText("Not available")).toBeTruthy();
  });

  it("asks again each time the panel is shown, and not while hidden", async () => {
    const getHealth = vi.fn(async () => health());
    const { rerender } = render(
      <DatasetInfoPanel visible workspaceId="ws" dataset={dataset} getHealth={getHealth} />,
    );
    await within(healthSection()).findByText("Healthy");

    rerender(<DatasetInfoPanel visible={false} workspaceId="ws" dataset={dataset} getHealth={getHealth} />);
    expect(getHealth).toHaveBeenCalledTimes(1);

    rerender(<DatasetInfoPanel visible workspaceId="ws" dataset={dataset} getHealth={getHealth} />);
    await within(healthSection()).findByText("Healthy");
    expect(getHealth).toHaveBeenCalledTimes(2);
  });
});
