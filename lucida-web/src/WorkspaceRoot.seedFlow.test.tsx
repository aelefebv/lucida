// @vitest-environment happy-dom

import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  appProps: [] as Array<{
    workspaceId: string;
    initialDatasetUrls?: readonly string[];
  }>,
}));

vi.mock("./App.tsx", () => ({
  default: (props: {
    workspaceId: string;
    initialDatasetUrls?: readonly string[];
  }) => {
    captured.appProps.push(props);
    return <div data-testid="app-mounted" />;
  },
}));

vi.mock("./auth/ProfileMenu.tsx", () => ({ ProfileMenu: () => null }));
vi.mock("./components/FileBrowser.tsx", () => ({ FileBrowser: () => null }));
vi.mock("./workspaceApi.ts", () => ({
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  duplicateWorkspace: vi.fn(),
  listArchivedWorkspaces: vi.fn(),
  listWorkspaces: vi.fn(),
  openWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  updateWorkspaceDefaultSavedView: vi.fn(),
  updateWorkspacePin: vi.fn(),
}));

import { WorkspaceRoot } from "./WorkspaceRoot.tsx";
import {
  createWorkspace,
  listWorkspaces,
  openWorkspace,
  type WorkspaceRecord,
} from "./workspaceApi.ts";

const createWorkspaceMock = vi.mocked(createWorkspace);
const listWorkspacesMock = vi.mocked(listWorkspaces);
const openWorkspaceMock = vi.mocked(openWorkspace);

function record(): WorkspaceRecord {
  return {
    id: "ws-created",
    name: "sample.ome.zarr",
    role: "owner",
    created_by: "owner@example.com",
    created_at: "2026-07-16T00:00:00Z",
    updated_at: "2026-07-16T00:00:00Z",
    archived_at: null,
    seq: 0,
    default_saved_view_id: null,
    last_opened_at: null,
    pinned_at: null,
  };
}

beforeEach(() => {
  captured.appProps.length = 0;
  window.history.replaceState({}, "", "/");
  createWorkspaceMock.mockReset();
  listWorkspacesMock.mockReset();
  openWorkspaceMock.mockReset();
});

afterEach(cleanup);

describe("WorkspaceRoot dashboard seed composition", () => {
  it("keeps the dataset seed across async creation and route loading", async () => {
    const workspace = record();
    listWorkspacesMock.mockResolvedValue([]);
    createWorkspaceMock.mockResolvedValue(workspace);
    openWorkspaceMock.mockResolvedValue(workspace);

    render(
      <StrictMode>
        <WorkspaceRoot />
      </StrictMode>,
    );

    const datasetUrl = "/data/sample.ome.zarr";
    fireEvent.change(
      await screen.findByLabelText("New workspace from dataset URL or path"),
      { target: { value: datasetUrl } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create from URL" }));

    await screen.findByTestId("app-mounted");
    await waitFor(() => {
      expect(captured.appProps.at(-1)).toMatchObject({
        workspaceId: workspace.id,
        initialDatasetUrls: [datasetUrl],
      });
    });
  });
});
