// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceFromChoices,
  createWorkspaceFromDatasets,
  datasetBasename,
  workspaceNameFromChoices,
  workspaceNameFromDatasets,
} from "./workspaceFromDataset.ts";
import { createWorkspace, type WorkspaceRecord } from "./workspaceApi.ts";

vi.mock("./workspaceApi.ts", () => ({
  createWorkspace: vi.fn(),
}));

const createWorkspaceMock = vi.mocked(createWorkspace);

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: "ws-new",
    name: "sample.ome.zarr",
    role: "owner",
    created_by: "owner@example.com",
    created_at: "2026-06-23T00:00:00Z",
    updated_at: "2026-06-23T00:00:00Z",
    archived_at: null,
    seq: 0,
    default_saved_view_id: null,
    last_opened_at: null,
    pinned_at: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("datasetBasename", () => {
  it("takes the last path segment of a remote URL", () => {
    expect(datasetBasename("gs://bucket/scans/sample.ome.zarr")).toBe(
      "sample.ome.zarr",
    );
  });

  it("ignores a trailing slash", () => {
    expect(datasetBasename("/data/scans/sample.ome.zarr/")).toBe(
      "sample.ome.zarr",
    );
  });

  it("strips query and fragment", () => {
    expect(datasetBasename("https://host/foo.zarr?token=abc#frag")).toBe(
      "foo.zarr",
    );
  });

  it("returns a single-segment path unchanged", () => {
    expect(datasetBasename("foo.zarr")).toBe("foo.zarr");
  });

  it("handles raw Windows backslash paths (naming runs pre-canonicalization)", () => {
    expect(datasetBasename("C:\\Users\\me\\foo.zarr")).toBe("foo.zarr");
    expect(datasetBasename("C:\\Users\\me\\foo.zarr\\")).toBe("foo.zarr");
  });
});

describe("workspaceNameFromDatasets", () => {
  it("uses the basename for a single dataset", () => {
    expect(workspaceNameFromDatasets(["/data/sample.ome.zarr"])).toBe(
      "sample.ome.zarr",
    );
  });

  it("appends (+N) for multiple datasets, keyed to the first basename", () => {
    expect(
      workspaceNameFromDatasets([
        "/data/sample.ome.zarr",
        "gs://bucket/volume.zarr",
        "/data/plane.zarr",
      ]),
    ).toBe("sample.ome.zarr (+2)");
  });

  it("returns empty when no usable basenames (lets server default apply)", () => {
    expect(workspaceNameFromDatasets([])).toBe("");
    expect(workspaceNameFromDatasets([""])).toBe("");
  });
});

describe("createWorkspaceFromDatasets", () => {
  it("creates a workspace named from the single dataset basename", async () => {
    createWorkspaceMock.mockResolvedValue(record({ name: "sample.ome.zarr" }));

    const ws = await createWorkspaceFromDatasets(["/data/sample.ome.zarr"]);

    expect(createWorkspaceMock).toHaveBeenCalledWith("sample.ome.zarr");
    expect(ws.id).toBe("ws-new");
  });

  it("creates a workspace named with (+N) for multiple datasets", async () => {
    createWorkspaceMock.mockResolvedValue(record({ name: "a.zarr (+1)" }));

    await createWorkspaceFromDatasets(["/data/a.zarr", "/data/b.zarr"]);

    expect(createWorkspaceMock).toHaveBeenCalledWith("a.zarr (+1)");
  });

  it("honors an explicit name override", async () => {
    createWorkspaceMock.mockResolvedValue(record({ name: "Custom" }));

    await createWorkspaceFromDatasets(["/data/a.zarr"], "Custom");

    expect(createWorkspaceMock).toHaveBeenCalledWith("Custom");
  });

  it("omits the name (server default) when no basename is derivable", async () => {
    createWorkspaceMock.mockResolvedValue(record({ name: "Untitled workspace" }));

    await createWorkspaceFromDatasets([""]);

    expect(createWorkspaceMock).toHaveBeenCalledWith(undefined);
  });
});

describe("workspaceNameFromChoices", () => {
  const runs = { id: "/data/runs", label: "runs", noun: "Folder" };
  const other = { id: "/data/other", label: "other", noun: "Folder" };
  const choice = (url: string, title: string | null, group: typeof runs | null) => ({ url, title, group });

  it("names one dataset after its title, not its group", () => {
    expect(workspaceNameFromChoices([choice("/data/runs/a.zarr", "First", runs)])).toBe("First");
  });

  it("names several from one group after the group", () => {
    expect(
      workspaceNameFromChoices([choice("/data/runs/a.zarr", "First", runs), choice("/data/runs/b.zarr", "Second", runs)]),
    ).toBe("runs");
  });

  it("names several from different groups, or none, after the first one's title", () => {
    expect(
      workspaceNameFromChoices([choice("/data/runs/a.zarr", "First", runs), choice("/data/other/b.zarr", "Second", other)]),
    ).toBe("First");
    expect(
      workspaceNameFromChoices([choice("/data/runs/a.zarr", "First", runs), choice("/data/b.zarr", "Second", null)]),
    ).toBe("First");
    // A group id is unique only within its source.
    const shelf = { ...runs, noun: "Shelf" };
    expect(
      workspaceNameFromChoices([choice("/data/runs/a.zarr", "First", runs), choice("/x/b.zarr", "Second", shelf)]),
    ).toBe("First");
  });

  it("leaves a dataset with no title to be named after its URL", () => {
    expect(workspaceNameFromChoices([choice("/data/a.zarr", null, null)])).toBeUndefined();
  });
});

describe("createWorkspaceFromChoices", () => {
  it("creates one workspace and seeds the datasets side by side, in order", async () => {
    createWorkspaceMock.mockResolvedValue(record({ name: "runs" }));
    const runs = { id: "/data/runs", label: "runs", noun: "Folder" };

    const { workspace, seed } = await createWorkspaceFromChoices([
      { url: "/data/runs/b.zarr", title: "Second", group: runs },
      { url: "/data/runs/a.zarr", title: "First", group: runs },
    ]);

    expect(createWorkspaceMock).toHaveBeenCalledExactlyOnceWith("runs");
    expect(workspace.id).toBe("ws-new");
    expect(seed).toEqual({ urls: ["/data/runs/b.zarr", "/data/runs/a.zarr"], sideBySide: true });
  });

  it("names a dataset with no title after its URL", async () => {
    createWorkspaceMock.mockResolvedValue(record());

    await createWorkspaceFromChoices([{ url: "/data/sample.ome.zarr", title: null, group: null }]);

    expect(createWorkspaceMock).toHaveBeenCalledWith("sample.ome.zarr");
  });
});
