// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import initWasm from "lucida-core";
import { WorkspaceDashboard } from "./WorkspaceDashboard.tsx";
import { sortWorkspaceDashboardRows } from "./workspaceDashboardOrder.ts";
import { fakeListingsApi, folder, listing } from "./openData/fakeListingsApi.ts";
import {
  __resetRecentSourcesForTesting,
  recentSourcesPreference,
} from "./openData/recentSources.ts";
import { __resetPreferencesForTesting, getPreference } from "./theme/preferences.ts";
import { __resetCommandsForTesting, runCommand } from "./ui/commands.ts";
import { __resetShortcutsForTesting } from "./ui/shortcuts.ts";
import { toastQueue } from "./ui/toastQueue.ts";
import {
  archiveWorkspace,
  createWorkspace,
  duplicateWorkspace,
  listArchivedWorkspaces,
  listWorkspaces,
  restoreWorkspace,
  updateWorkspacePin,
  type WorkspaceRecord,
  type WorkspaceSummary,
} from "./workspaceApi.ts";

// The segmented control's selection indicator animates through the Web
// Animations API, which happy-dom lacks.
if (!("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", { value: () => [] });
}

vi.mock("./auth/ProfileMenu.tsx", () => ({
  ProfileMenu: () => null,
}));

// The test loads the wasm build itself, from bytes, in beforeAll.
vi.mock("./wasmInit.ts", () => ({
  initWasmOnce: () => Promise.resolve(),
}));

vi.mock("./workspaceApi.ts", () => ({
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  duplicateWorkspace: vi.fn(),
  listArchivedWorkspaces: vi.fn(),
  listWorkspaces: vi.fn(),
  restoreWorkspace: vi.fn(),
  updateWorkspacePin: vi.fn(),
}));

const archiveWorkspaceMock = vi.mocked(archiveWorkspace);
const duplicateWorkspaceMock = vi.mocked(duplicateWorkspace);
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
    first_dataset_url: null,
    ...overrides,
  };
}

function record(overrides: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
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
    ...overrides,
  };
}

function openLinks(container: HTMLElement = document.body): string[] {
  return within(container)
    .queryAllByRole("link")
    .map((link) => link.getAttribute("aria-label") ?? "")
    .filter((label) => label.startsWith("Open workspace "));
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

async function chooseFromMenu(user: ReturnType<typeof userEvent.setup>, workspaceName: string, item: string) {
  await user.click(screen.getByRole("button", { name: `More actions for ${workspaceName}` }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

beforeAll(async () => {
  const bytes = readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"));
  await initWasm({ module_or_path: bytes });
});

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
  __resetRecentSourcesForTesting();
  originalFetch = globalThis.fetch;
  globalThis.fetch = fakeListingsApi([
    listing("/srv/data/runs/one.ome.zarr", { title: "First volume", group: folder("/srv/data/runs") }),
  ]).fetch;
});

/** Open the open dialog from the dashboard's field, and put focus in its field. */
async function openDataDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByTestId("new-workspace-from-dataset"));
  const dialog = await screen.findByRole("dialog", { name: "Open data" });
  // happy-dom leaves focus on the dialog; a browser puts it in the field.
  await user.click(within(dialog).getByRole("combobox"));
  return dialog;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  vi.resetAllMocks();
  toastQueue.clear();
  __resetShortcutsForTesting();
  __resetCommandsForTesting();
});

describe("WorkspaceDashboard", () => {
  it("sorts pinned workspaces before recent workspaces", () => {
    const rows = sortWorkspaceDashboardRows([
      workspace({ id: "recent", name: "Recent", last_opened_at: "2026-05-29T02:00:00Z" }),
      workspace({ id: "pinned", name: "Pinned", pinned_at: "2026-05-28T01:00:00Z" }),
      workspace({ id: "old", name: "Old", updated_at: "2026-05-28T00:00:00Z" }),
    ]);

    expect(rows.map((row) => row.name)).toEqual(["Pinned", "Recent", "Old"]);
  });

  it("tells same-named workspaces apart by where their first dataset lives", async () => {
    listWorkspacesMock.mockResolvedValue([
      workspace({
        id: "north",
        name: "sample.zarr",
        dataset_count: 1,
        first_dataset_url: "/data/north/sample.zarr",
        last_opened_at: "2026-05-29T02:00:00Z",
      }),
      workspace({
        id: "south",
        name: "sample.zarr",
        dataset_count: 2,
        first_dataset_url: "gs://bucket/south/sample.zarr",
        last_opened_at: "2026-05-29T01:00:00Z",
      }),
      workspace({ id: "blank", name: "Blank" }),
    ]);

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);

    const links = await screen.findAllByRole("link", { name: "Open workspace sample.zarr" });
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/w/north", "/w/south"]);
    // The location is part of each link's description, so a screen reader
    // tells the two apart as well.
    const describedBy = (link: HTMLElement) =>
      (link.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
    expect(describedBy(links[0])).toContain("…/north/sample.zarr");
    expect(describedBy(links[0])).toContain("1 dataset");
    expect(describedBy(links[1])).toContain("…/south/sample.zarr");
    expect(describedBy(links[1])).toContain("2 datasets");
    expect(screen.getByText("…/north/sample.zarr").closest("p")?.getAttribute("title")).toBe(
      "/data/north/sample.zarr",
    );
    expect(screen.getByText("No datasets yet")).toBeTruthy();
    expect(screen.getAllByText("Owner")).toHaveLength(3);
  });

  it("doesn't claim a workspace with datasets has none when the listing lacks their location", async () => {
    listWorkspacesMock.mockResolvedValue([workspace({ id: "older", name: "Older", dataset_count: 2 })]);

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);

    expect(await screen.findByText("Location unknown")).toBeTruthy();
    expect(screen.queryByText("No datasets yet")).toBeNull();
    expect(screen.getByText("2 datasets")).toBeTruthy();
  });

  it("opens a workspace from its card", async () => {
    listWorkspacesMock.mockResolvedValue([workspace({ id: "alpha", name: "Alpha" })]);
    const onOpenWorkspace = vi.fn();
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    await user.click(await screen.findByRole("link", { name: "Open workspace Alpha" }));

    expect(onOpenWorkspace).toHaveBeenCalledWith("alpha");
  });

  it("pins a workspace and moves it into the pinned section", async () => {
    listWorkspacesMock.mockResolvedValue([
      workspace({ id: "recent", name: "Recent", last_opened_at: "2026-05-29T02:00:00Z" }),
      workspace({ id: "alpha", name: "Alpha", updated_at: "2026-05-28T00:00:00Z" }),
    ]);
    updateWorkspacePinMock.mockResolvedValue({
      workspace_id: "alpha",
      last_opened_at: null,
      pinned_at: "2026-05-29T03:00:00Z",
    });
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    await waitFor(() => {
      expect(openLinks()).toEqual(["Open workspace Recent", "Open workspace Alpha"]);
    });
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();

    const pin = screen.getByRole("button", { name: "Pin Alpha" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    await user.click(pin);

    await waitFor(() => {
      expect(updateWorkspacePinMock).toHaveBeenCalledWith("alpha", true);
      expect(openLinks(section("Pinned"))).toEqual(["Open workspace Alpha"]);
    });
    expect(openLinks(section("Recent"))).toEqual(["Open workspace Recent"]);
    expect(screen.getByRole("button", { name: "Pin Alpha" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("creates an empty workspace and opens it", async () => {
    createWorkspaceMock.mockResolvedValue(record({ id: "created" }));
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    await user.click(screen.getByRole("button", { name: "New workspace" }));

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledWith();
      expect(onOpenWorkspace).toHaveBeenCalledWith("created");
    });
  });

  it("opens a pasted URL into a new workspace named after it", async () => {
    // Only a name is sent, so the workspace keeps the server's owner-only
    // default sharing.
    createWorkspaceMock.mockResolvedValue(record({ id: "ws-ds", name: "sample.ome.zarr" }));
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    const dialog = await openDataDialog(user);
    await user.paste("GS://bucket/scans/sample.ome.zarr");
    await within(dialog).findByText("Open gs://bucket/scans/sample.ome.zarr");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledWith("sample.ome.zarr");
      expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
      // The canonical URL, carried into the viewer to open there.
      expect(onOpenWorkspace).toHaveBeenCalledWith("ws-ds", {
        urls: ["gs://bucket/scans/sample.ome.zarr"],
        sideBySide: true,
      });
    });
    expect(getPreference(recentSourcesPreference)).toEqual(["gs://bucket/scans/sample.ome.zarr"]);
  });

  it("opens a listing into a new workspace named after its title", async () => {
    createWorkspaceMock.mockResolvedValue(record({ id: "ws-one", name: "First volume" }));
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    const dialog = await openDataDialog(user);
    await user.click(await within(dialog).findByText("First volume"));

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledWith("First volume");
      expect(onOpenWorkspace).toHaveBeenCalledWith("ws-one", { urls: ["/srv/data/runs/one.ome.zarr"], sideBySide: true });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens a small folder side by side in a new workspace named after it", async () => {
    const runs = folder("/srv/data/runs");
    globalThis.fetch = fakeListingsApi([
      listing("/srv/data/runs/one.ome.zarr", { title: "First volume", group: runs }),
      listing("/srv/data/runs/two.ome.zarr", { title: "Second volume", group: runs }),
    ]).fetch;
    createWorkspaceMock.mockResolvedValue(record({ id: "ws-runs", name: "runs" }));
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    const dialog = await openDataDialog(user);
    await user.click(await within(dialog).findByRole("button", { name: "Open folder" }));

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledExactlyOnceWith("runs");
      expect(onOpenWorkspace).toHaveBeenCalledWith("ws-runs", {
        urls: ["/srv/data/runs/one.ome.zarr", "/srv/data/runs/two.ome.zarr"],
        sideBySide: true,
      });
    });
  });

  it("explains a location that cannot open and creates nothing", async () => {
    listWorkspacesMock.mockResolvedValue([]);
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    await openDataDialog(user);
    await user.paste("~/data/sample.zarr");
    expect(await screen.findByText(/doesn't expand ~/)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("keeps you on the dashboard and shows the error if the create fails", async () => {
    createWorkspaceMock.mockRejectedValue(new Error("quota exceeded"));
    listWorkspacesMock.mockResolvedValue([]);
    const onOpenWorkspace = vi.fn();
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    const dialog = await openDataDialog(user);
    await user.paste("/data/sample.ome.zarr");
    await within(dialog).findByText("Open /data/sample.ome.zarr");
    await user.keyboard("{Enter}");

    expect((await screen.findByRole("alert")).textContent).toContain("quota exceeded");
    expect(onOpenWorkspace).not.toHaveBeenCalled();
  });

  it("offers the open dialog from the empty dashboard", async () => {
    listWorkspacesMock.mockResolvedValue([]);
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Open data…" }));
    expect(await screen.findByRole("dialog", { name: "Open data" })).toBeTruthy();
  });

  it("duplicates a workspace the user only views and opens the copy", async () => {
    // Duplicate is offered whatever the role; the copy becomes the user's own.
    listWorkspacesMock.mockResolvedValue([
      workspace({ id: "shared-1", name: "Shared Project", role: "viewer" }),
    ]);
    duplicateWorkspaceMock.mockResolvedValue(record({ id: "copy-1", name: "Copy of Shared Project" }));
    const onOpenWorkspace = vi.fn();
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    await screen.findByRole("link", { name: "Open workspace Shared Project" });
    expect(screen.getByText("Viewer")).toBeTruthy();
    await chooseFromMenu(user, "Shared Project", "Duplicate");

    await waitFor(() => {
      expect(duplicateWorkspaceMock).toHaveBeenCalledWith("shared-1");
      expect(onOpenWorkspace).toHaveBeenCalledWith("copy-1");
    });
  });

  it("shows the error when duplicating fails and stays on the dashboard", async () => {
    listWorkspacesMock.mockResolvedValue([workspace({ id: "ws-1", name: "Project", role: "editor" })]);
    duplicateWorkspaceMock.mockRejectedValue(new Error("boom"));
    const onOpenWorkspace = vi.fn();
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={onOpenWorkspace} />);
    await screen.findByRole("link", { name: "Open workspace Project" });
    await chooseFromMenu(user, "Project", "Duplicate");

    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(onOpenWorkspace).not.toHaveBeenCalled();
  });

  it("archives a workspace its owner holds, and offers it to nobody else", async () => {
    listWorkspacesMock.mockResolvedValue([
      workspace({ id: "alpha", name: "Alpha", role: "owner" }),
      workspace({ id: "beta", name: "Beta", role: "editor" }),
    ]);
    archiveWorkspaceMock.mockResolvedValue(record({ id: "alpha", archived_at: "2026-05-29T01:00:00Z" }));
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    await screen.findByRole("link", { name: "Open workspace Beta" });

    await user.click(screen.getByRole("button", { name: "More actions for Beta" }));
    expect(await screen.findByRole("menuitem", { name: "Copy link" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    await user.keyboard("{Escape}");

    await chooseFromMenu(user, "Alpha", "Archive");

    await waitFor(() => {
      expect(archiveWorkspaceMock).toHaveBeenCalledWith("alpha");
      expect(openLinks()).toEqual(["Open workspace Beta"]);
    });
    const [archived] = toastQueue.visibleToasts;
    expect(archived.content.title).toBe("Archived Alpha");

    // Undo restores it and lists the active workspaces again.
    restoreWorkspaceMock.mockResolvedValue(record({ id: "alpha" }));
    listWorkspacesMock.mockResolvedValue([
      workspace({ id: "alpha", name: "Alpha", role: "owner" }),
      workspace({ id: "beta", name: "Beta", role: "editor" }),
    ]);
    act(() => archived.content.action?.onPress());
    await waitFor(() => {
      expect(restoreWorkspaceMock).toHaveBeenCalledWith("alpha");
      expect(openLinks()).toEqual(["Open workspace Alpha", "Open workspace Beta"]);
    });
  });

  it("shows archived workspaces and restores them", async () => {
    listWorkspacesMock.mockResolvedValue([]);
    listArchivedWorkspacesMock.mockResolvedValue([
      workspace({ id: "archived", name: "Archived one", archived_at: "2026-05-29T01:00:00Z" }),
    ]);
    restoreWorkspaceMock.mockResolvedValue(record({ id: "archived" }));
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    await screen.findByText("No workspaces yet");
    await user.click(screen.getByRole("radio", { name: "Archived" }));

    await waitFor(() => {
      expect(listArchivedWorkspacesMock).toHaveBeenCalledTimes(1);
      expect(openLinks()).toEqual(["Open workspace Archived one"]);
    });
    // Archived workspaces cannot be pinned or created from here.
    expect(screen.queryByRole("button", { name: "Pin Archived one" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New workspace" })).toBeNull();

    await chooseFromMenu(user, "Archived one", "Restore");

    await waitFor(() => {
      expect(restoreWorkspaceMock).toHaveBeenCalledWith("archived");
      expect(screen.getByText("Nothing archived")).toBeTruthy();
    });
  });

  it("searches names and dataset locations", async () => {
    listWorkspacesMock.mockResolvedValue([
      workspace({ id: "a", name: "Alpha", first_dataset_url: "/data/north/sample.zarr", dataset_count: 1 }),
      workspace({ id: "b", name: "Beta", first_dataset_url: "/data/south/sample.zarr", dataset_count: 1 }),
    ]);
    const user = userEvent.setup();

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    await screen.findByRole("link", { name: "Open workspace Alpha" });
    const search = screen.getByRole("searchbox", { name: "Search workspaces" });

    await user.type(search, "beta");
    expect(openLinks()).toEqual(["Open workspace Beta"]);

    await user.clear(search);
    await user.type(search, "north");
    expect(openLinks()).toEqual(["Open workspace Alpha"]);

    await user.type(search, "-nowhere");
    expect(screen.getByText("No workspaces match “north-nowhere”")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(openLinks()).toEqual(["Open workspace Alpha", "Open workspace Beta"]);
  });

  it("copies a workspace link", async () => {
    listWorkspacesMock.mockResolvedValue([workspace({ id: "a b", name: "Alpha" })]);
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    await screen.findByRole("link", { name: "Open workspace Alpha" });
    await chooseFromMenu(user, "Alpha", "Copy link");

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/w/a%20b`);
    await waitFor(() => {
      expect(toastQueue.visibleToasts.map((t) => t.content.title)).toEqual(["Link copied"]);
    });
  });

  it("offers Open data as a command that opens the dialog", async () => {
    listWorkspacesMock.mockResolvedValue([]);

    render(<WorkspaceDashboard onOpenWorkspace={() => {}} />);
    act(() => {
      expect(runCommand("data.open")).toBe(true);
    });
    expect(await screen.findByRole("dialog", { name: "Open data" })).toBeTruthy();
  });
});
