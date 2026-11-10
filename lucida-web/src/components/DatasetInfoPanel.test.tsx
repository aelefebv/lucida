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
          { kind: "mismatched_tile_geometry", target: "wds-1", message: "tiles differ in size", degrades: true },
          { kind: "skipped_group", target: "B/2", message: "skipped group \"B/2\": invalid JSON", degrades: false },
        ],
      }),
    );
    render(<DatasetInfoPanel visible workspaceId="ws" dataset={dataset} getHealth={getHealth} />);

    const section = healthSection();
    expect(await within(section).findByText("Degraded")).toBeTruthy();
    const details = within(section).getByRole("list", { name: "Health details" });
    const items = within(details).getAllByRole("listitem");
    expect(items.map((li) => [li.textContent, li.hasAttribute("data-degrades")])).toEqual([
      ["Tiles differ in size", true],
      ["Cell B/2 was left out because it couldn't be read.", false],
    ]);
    expect(screen.getByText("/data/tiles.zarr")).toBeTruthy();
    expect(getHealth).toHaveBeenCalledWith("wds-1");
  });

  it("words the server's own trouble serving the dataset for people", async () => {
    const getHealth = vi.fn(async () =>
      health({
        status: "unavailable",
        binding: { status: "unavailable", message: "server binding is missing; chunks cannot be served" },
        messages: ["dataset exists in the workspace document but has no runtime binding; retry dataset restore"],
      }),
    );
    render(<DatasetInfoPanel visible workspaceId="ws" dataset={dataset} getHealth={getHealth} />);

    const section = healthSection();
    expect(await within(section).findByText("Unavailable")).toBeTruthy();
    const details = within(section).getByRole("list", { name: "Health details" });
    expect(within(details).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "The server can't read this dataset right now, so none of it can be shown.",
    ]);
    expect(section.textContent).not.toMatch(/binding/);
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

  it("shows the color the dataset declares beside each channel's name, when it is one", async () => {
    const declared = structuredClone(dataset);
    declared.manifest.images[0].multiscale.levels[0].shape = [1, 4, 1, 64, 64];
    declared.manifest.images[0].multiscale.channel_infos = [
      { label: "First", color: "00FFFF" },
      { label: "Channel 2", color: "#ff00ff" },
      { label: "Third", color: "not-a-color" },
    ];
    render(<DatasetInfoPanel visible workspaceId="ws" dataset={declared} getHealth={async () => health()} />);

    const fact = screen.getByText("4 channels").closest(".lc-info-fact")!;
    const rows = within(fact as HTMLElement).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "First00FFFF",
      "Channel 2#ff00ff",
      "Third",
      "Channel 4",
    ]);
    const swatches = rows.map(
      (row) => row.querySelector<HTMLElement>(".lc-info-swatch")?.style.backgroundColor ?? null,
    );
    expect(swatches[2]).toBeNull();
    expect(swatches[3]).toBeNull();
    expect(swatches.slice(0, 2).every((color) => color)).toBe(true);
  });

  it("states the precision a type is drawn at when a float32 can't hold all of it", async () => {
    const dataType = (data_type: string) => {
      cleanup();
      const wide = structuredClone(dataset);
      wide.manifest.images[0].multiscale.data_type = data_type;
      render(<DatasetInfoPanel visible workspaceId="ws" dataset={wide} getHealth={async () => health()} />);
      return screen.getByText("Data type").closest(".lc-info-fact")!.textContent;
    };
    expect(dataType("Int64")).toBe("Data typeint64 drawn at float32 precision");
    expect(dataType("Uint64")).toBe("Data typeuint64 drawn at float32 precision");
    expect(dataType("Float16")).toBe("Data typefloat16");
  });
});
