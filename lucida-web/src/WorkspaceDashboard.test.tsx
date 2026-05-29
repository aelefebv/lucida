// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceDashboard } from "./WorkspaceDashboard.tsx";
import { sortWorkspaceDashboardRows } from "./workspaceDashboardOrder.ts";
import {
  createWorkspace,
  listWorkspaces,
  updateWorkspacePin,
  type WorkspaceSummary,
} from "./workspaceApi.ts";

vi.mock("./auth/ProfileMenu.tsx", () => ({
  ProfileMenu: () => null,
}));

vi.mock("./workspaceApi.ts", () => ({
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspacePin: vi.fn(),
}));

const listWorkspacesMock = vi.mocked(listWorkspaces);
const createWorkspaceMock = vi.mocked(createWorkspace);
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
  vi.clearAllMocks();
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
});
