// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceDashboard } from "./WorkspaceDashboard.tsx";
import { sortWorkspaceDashboardRows } from "./workspaceDashboardOrder.ts";
import {
  archiveWorkspace,
  createWorkspace,
  listArchivedWorkspaces,
  listWorkspaces,
  restoreWorkspace,
  updateWorkspacePin,
  type WorkspaceSummary,
} from "./workspaceApi.ts";

vi.mock("./auth/ProfileMenu.tsx", () => ({
  ProfileMenu: () => null,
}));

// Stub the file browser: it fetches `/api/browse` on mount, which we don't want
// to exercise here. Expose a button that drives the create-from-selection
// callback so the dashboard's file-browser entry point is still covered.
vi.mock("./components/FileBrowser.tsx", () => ({
  FileBrowser: ({
    onCreateWorkspace,
    onClose,
  }: {
    onCreateWorkspace?: (paths: string[]) => void;
    onClose: () => void;
  }) => (
    <div data-testid="fake-file-browser">
      <button
        type="button"
        onClick={() => onCreateWorkspace?.(["/data/a.zarr", "/data/b.zarr"])}
      >
        fake-create-from-selection
      </button>
      <button type="button" onClick={onClose}>
        fake-close
      </button>
    </div>
  ),
}));

vi.mock("./workspaceApi.ts", () => ({
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  listArchivedWorkspaces: vi.fn(),
  listWorkspaces: vi.fn(),
  restoreWorkspace: vi.fn(),
  updateWorkspacePin: vi.fn(),
}));

const archiveWorkspaceMock = vi.mocked(archiveWorkspace);
const listArchivedWorkspacesMock = vi.mocked(listArchivedWorkspaces);
const listWorkspacesMock = vi.mocked(listWorkspaces);
const createWorkspaceMock = vi.mocked(createWorkspace);
const restoreWorkspaceMock = vi.mocked(restoreWorkspace);
const updateWorkspacePinMock = vi.mocked(updateWorkspacePin);

function workspace(overrides: Partial<WorkspaceSummary>): WorkspaceSummary {
  return {
    id: "workspace-1",
    name: "Workspace",
    role: "owner",
    created_by: "owner@example.com",
    created_at: "2026-05-29T00:00:00Z",
    updated_at: "2026-05-29T00:00:00Z",
    archived_at: null,
    seq: 1,
    dataset_count: 0,
    default_saved_view_id: null,
    last_opened_at: null,
    pinned_at: null,
    ...overrides,
  };
}

function openWorkspaceLabels(): string[] {
  return screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"))
    .filter((label): label is string => Boolean(label?.startsWith("Open workspace ")));
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("WorkspaceDashboard", () => {
  it("sorts pinned workspaces before recent workspaces", () => {
    const rows = sortWorkspaceDashboardRows([
      workspace({
        id: "recent",
        name: "Recent",
        last_opened_at: "2026-05-29T02:00:00Z",
      }),
      workspace({
        id: "pinned",
        name: "Pinned",
        pinned_at: "2026-05-28T01:00:00Z",
      }),
      workspace({
        id: "old",
        name: "Old",
        updated_at: "2026-05-28T00:00:00Z",
      }),
    ]);

    expect(rows.map((row) => row.name)).toEqual(["Pinned", "Recent", "Old"]);
  });

  it("pins a workspace and moves it into the pinned group", async () => {
    listWorkspacesMock.mockResolvedValue([
      workspace({
        id: "recent",
        name: "Recent",
        last_opened_at: "2026-05-29T02:00:00Z",
      }),
      workspace({
        id: "alpha",
        name: "Alpha",
        updated_at: "2026-05-28T00:00:00Z",
      }),
    ]);
    updateWorkspacePinMock.mockResolvedValue({
      workspace_id: "alpha",
      last_opened_at: null,
      pinned_at: "2026-05-29T03:00:00Z",
    });

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);

    await waitFor(() => {
      expect(openWorkspaceLabels()).toEqual([
        "Open workspace Recent",
        "Open workspace Alpha",
      ]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Pin Alpha" }));

    await waitFor(() => {
      expect(updateWorkspacePinMock).toHaveBeenCalledWith("alpha", true);
      expect(openWorkspaceLabels()).toEqual([
        "Open workspace Alpha",
        "Open workspace Recent",
      ]);
    });
    expect(screen.getByRole("button", { name: "Unpin Alpha" })).toBeTruthy();
  });

  it("creates a workspace and opens it", async () => {
    createWorkspaceMock.mockResolvedValue({
      id: "created",
      name: "Created",
      role: "owner",
      created_by: "owner@example.com",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T00:00:00Z",
      archived_at: null,
      seq: 0,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));

    await waitFor(() => {
      expect(onOpenWorkspace).toHaveBeenCalledWith("created");
    });
  });

  it("creates a workspace FROM A DATASET URL named from the basename and opens it with the seed", async () => {
    // The create call only sends a NAME — the workspace inherits the server's
    // default sharing (restricted, owner-only, link OFF). We assert the name is
    // the dataset basename and that NO sharing/visibility override is sent.
    createWorkspaceMock.mockResolvedValue({
      id: "ws-ds",
      name: "embryo.ome.zarr",
      role: "owner",
      created_by: "owner@example.com",
      created_at: "2026-06-23T00:00:00Z",
      updated_at: "2026-06-23T00:00:00Z",
      archived_at: null,
      seq: 0,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);

    fireEvent.change(
      screen.getByLabelText("New workspace from dataset URL or path"),
      { target: { value: "gs://bucket/scans/embryo.ome.zarr" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create from URL" }));

    await waitFor(() => {
      // Name derived from the basename; only the name is passed (default
      // restricted owner-only reused, never weakened).
      expect(createWorkspaceMock).toHaveBeenCalledWith("embryo.ome.zarr");
      expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
      // Navigates into the new workspace WITH the dataset to auto-open.
      expect(onOpenWorkspace).toHaveBeenCalledWith("ws-ds", [
        "gs://bucket/scans/embryo.ome.zarr",
      ]);
    });
  });

  it("creates a workspace from MULTIPLE datasets chosen in the file browser and opens all", async () => {
    createWorkspaceMock.mockResolvedValue({
      id: "ws-multi",
      name: "a.zarr (+1)",
      role: "owner",
      created_by: "owner@example.com",
      created_at: "2026-06-23T00:00:00Z",
      updated_at: "2026-06-23T00:00:00Z",
      archived_at: null,
      seq: 0,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);

    // Open the (stubbed) file browser and trigger create-from-selection.
    fireEvent.click(screen.getByRole("button", { name: "Browse files…" }));
    fireEvent.click(
      screen.getByRole("button", { name: "fake-create-from-selection" }),
    );

    await waitFor(() => {
      // Multi-name default: first basename + (+N).
      expect(createWorkspaceMock).toHaveBeenCalledWith("a.zarr (+1)");
      // All selected datasets carried as the seed to auto-open.
      expect(onOpenWorkspace).toHaveBeenCalledWith("ws-multi", [
        "/data/a.zarr",
        "/data/b.zarr",
      ]);
    });
  });

  it("keeps you on the dashboard and surfaces the error if create-from-dataset FAILS", async () => {
    createWorkspaceMock.mockRejectedValue(new Error("quota exceeded"));
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);

    fireEvent.change(
      screen.getByLabelText("New workspace from dataset URL or path"),
      { target: { value: "/data/embryo.ome.zarr" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create from URL" }));

    await waitFor(() => {
      expect(screen.getByText("quota exceeded")).toBeTruthy();
    });
    // No navigation happened — we stayed on the dashboard.
    expect(onOpenWorkspace).not.toHaveBeenCalled();
  });

  it("archives owner workspaces from the active dashboard", async () => {
    listWorkspacesMock.mockResolvedValue([
      workspace({ id: "alpha", name: "Alpha", role: "owner" }),
    ]);
    archiveWorkspaceMock.mockResolvedValue({
      id: "alpha",
      name: "Alpha",
      role: "owner",
      created_by: "owner@example.com",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T01:00:00Z",
      archived_at: "2026-05-29T01:00:00Z",
      seq: 1,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    await screen.findByRole("button", { name: "Archive Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Archive Alpha" }));

    await waitFor(() => {
      expect(archiveWorkspaceMock).toHaveBeenCalledWith("alpha");
      expect(screen.queryByRole("button", { name: "Open workspace Alpha" })).toBeNull();
    });
  });

  it("shows archived workspaces and restores them", async () => {
    listWorkspacesMock.mockResolvedValue([]);
    listArchivedWorkspacesMock.mockResolvedValue([
      workspace({
        id: "archived",
        name: "Archived",
        role: "owner",
        archived_at: "2026-05-29T01:00:00Z",
      }),
    ]);
    restoreWorkspaceMock.mockResolvedValue({
      id: "archived",
      name: "Archived",
      role: "owner",
      created_by: "owner@example.com",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T01:00:00Z",
      archived_at: null,
      seq: 1,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));

    await waitFor(() => {
      expect(listArchivedWorkspacesMock).toHaveBeenCalledTimes(1);
      expect(openWorkspaceLabels()).toEqual(["Open workspace Archived"]);
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore Archived" }));

    await waitFor(() => {
      expect(restoreWorkspaceMock).toHaveBeenCalledWith("archived");
      expect(screen.queryByRole("button", { name: "Open workspace Archived" })).toBeNull();
    });
  });
});
