// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { SavedView } from "../savedView/types.ts";
import type { WorkspaceSavedView } from "../workspaceApi.ts";

// Mock the API surface so the sidebar's hook talks to spies, not the network.
const listMock = vi.fn<(ws: string) => Promise<WorkspaceSavedView[]>>();
const setVisibilityMock = vi.fn<
  (ws: string, id: string, vis: string) => Promise<WorkspaceSavedView>
>();
const approveMock = vi.fn<(ws: string, id: string) => Promise<WorkspaceSavedView>>();
const rejectMock = vi.fn<(ws: string, id: string) => Promise<WorkspaceSavedView>>();

vi.mock("../workspaceApi.ts", () => ({
  listWorkspaceSavedViews: (ws: string) => listMock(ws),
  createWorkspaceSavedView: vi.fn(),
  updateWorkspaceSavedView: vi.fn(),
  deleteWorkspaceSavedView: vi.fn(),
  setWorkspaceSavedViewVisibility: (ws: string, id: string, vis: string) =>
    setVisibilityMock(ws, id, vis),
  approveWorkspaceSavedView: (ws: string, id: string) => approveMock(ws, id),
  rejectWorkspaceSavedView: (ws: string, id: string) => rejectMock(ws, id),
}));

const { WorkspaceSavedViewsSidebar } = await import("./WorkspaceSavedViewsSidebar.tsx");

function emptyView(): SavedView {
  return {
    v: 1,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [0, 0], zoom: 1, viewport: [800, 600] },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    dataset_order: [],
    dataset_settings: {},
  };
}

function view(overrides: Partial<WorkspaceSavedView>): WorkspaceSavedView {
  return {
    id: "sv-1",
    workspace_id: "ws-1",
    name: "My view",
    created_by: "viewer@example.com",
    created_by_name: "Viewer",
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-20T00:00:00Z",
    visibility: "personal",
    view: emptyView(),
    ...overrides,
  };
}

function baseProps() {
  return {
    workspaceId: "ws-1",
    getCurrentSavedView: () => emptyView(),
    onOpenSavedView: vi.fn(),
    loadedDatasetNames: [] as string[],
    activeLayoutName: null,
    defaultSavedViewId: null,
    onSetDefaultSavedView: vi.fn(async () => {}),
    visible: true,
  };
}

beforeEach(() => {
  listMock.mockReset();
  setVisibilityMock.mockReset();
  approveMock.mockReset();
  rejectMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceSavedViewsSidebar — viewer propose flow", () => {
  it("offers 'Propose to team' for a viewer's own personal view and sets it proposed", async () => {
    const own = view({ id: "sv-own", visibility: "personal" });
    listMock.mockResolvedValue([own]);
    setVisibilityMock.mockResolvedValue(view({ id: "sv-own", visibility: "proposed" }));

    render(
      <WorkspaceSavedViewsSidebar
        {...baseProps()}
        currentUserEmail="viewer@example.com"
        canEdit={false}
      />,
    );

    await screen.findByText("My view");
    // Open the per-row actions menu.
    await userEvent.click(screen.getByLabelText("Saved view actions"));
    const proposeBtn = await screen.findByTestId("saved-view-propose-sv-own");
    await userEvent.click(proposeBtn);

    await waitFor(() =>
      expect(setVisibilityMock).toHaveBeenCalledWith("ws-1", "sv-own", "proposed"),
    );
  });

  it("does NOT offer 'Propose to team' for a view that is not the viewer's own", async () => {
    const someoneElse = view({
      id: "sv-other",
      visibility: "personal",
      created_by: "other@example.com",
    });
    // A viewer would never actually receive someone else's personal view from
    // the server; this guards the client predicate regardless.
    listMock.mockResolvedValue([someoneElse]);

    render(
      <WorkspaceSavedViewsSidebar
        {...baseProps()}
        currentUserEmail="viewer@example.com"
        canEdit={false}
      />,
    );
    await screen.findByText("My view");
    await userEvent.click(screen.getByLabelText("Saved view actions"));
    expect(screen.queryByTestId("saved-view-propose-sv-other")).toBeNull();
  });
});

describe("WorkspaceSavedViewsSidebar — editor review queue", () => {
  it("shows proposed views distinctly with Approve / Reject and calls the API", async () => {
    const proposal = view({
      id: "sv-prop",
      name: "Pending proposal",
      visibility: "proposed",
      created_by: "viewer@example.com",
    });
    const shared = view({ id: "sv-shared", name: "Team view", visibility: "shared" });
    listMock.mockResolvedValue([proposal, shared]);
    approveMock.mockResolvedValue(view({ id: "sv-prop", visibility: "shared" }));
    rejectMock.mockResolvedValue(view({ id: "sv-prop", visibility: "personal" }));

    render(
      <WorkspaceSavedViewsSidebar
        {...baseProps()}
        currentUserEmail="editor@example.com"
        canEdit
      />,
    );

    // The review queue is present and the proposed view carries a distinct chip.
    await screen.findByTestId("saved-view-review-queue");
    expect(screen.getByTestId("saved-view-visibility-sv-prop").textContent).toBe(
      "Proposed",
    );

    // Approve calls the approve API for the right id.
    await userEvent.click(screen.getByTestId("saved-view-approve-sv-prop"));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith("ws-1", "sv-prop"));

    // Reject also wired (use a fresh render to avoid the optimistic removal).
    cleanup();
    listMock.mockResolvedValue([proposal]);
    render(
      <WorkspaceSavedViewsSidebar
        {...baseProps()}
        currentUserEmail="editor@example.com"
        canEdit
      />,
    );
    await screen.findByTestId("saved-view-reject-sv-prop");
    await userEvent.click(screen.getByTestId("saved-view-reject-sv-prop"));
    await waitFor(() => expect(rejectMock).toHaveBeenCalledWith("ws-1", "sv-prop"));
  });

  it("does not render a review queue when there are no proposals", async () => {
    listMock.mockResolvedValue([view({ id: "sv-shared", visibility: "shared" })]);
    render(
      <WorkspaceSavedViewsSidebar
        {...baseProps()}
        currentUserEmail="editor@example.com"
        canEdit
      />,
    );
    await screen.findByText("My view");
    expect(screen.queryByTestId("saved-view-review-queue")).toBeNull();
  });
});
