import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveWorkspace,
  browseLocalFiles,
  duplicateWorkspace,
  createWorkspaceSavedView,
  deleteWorkspaceSavedView,
  getWorkspaceSavedView,
  getWorkspaceViewerProfile,
  listArchivedWorkspaces,
  listWorkspaceSavedViews,
  openWorkspace,
  restoreWorkspace,
  setWorkspaceSavedViewVisibility,
  updateWorkspaceSavedView,
  updateWorkspaceDefaultSavedView,
  updateWorkspacePin,
  updateWorkspaceLastView,
  getWorkspaceUserState,
} from "./workspaceApi.ts";
import { SAVED_VIEW_VERSION, type SavedView } from "./savedView/types.ts";

function emptyView(): SavedView {
  return {
    v: SAVED_VIEW_VERSION,
    datasets: [],
    active_layouts: {},
    camera: { mode: "slice", center: [0, 0], zoom: 1.0, viewport: [800, 600] },
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0, multi_channel: false },
    display: { contrast_min: 0, contrast_max: 65535, gamma: 1.0 },
    dataset_order: [],
    dataset_settings: {},
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
  method: string;
}

let originalFetch: typeof globalThis.fetch;
let calls: FetchCall[];
let responder: (url: string, init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  responder = () => jsonResponse(200, []);
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init, method: init?.method ?? "GET" });
    return responder(url, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("local file browser API", () => {
  it("uses same-origin config and omits the empty root query", async () => {
    await browseLocalFiles();
    expect(calls[0].url).toBe("/api/browse");
    expect(calls[0].init?.credentials).toBe("same-origin");
  });

  it("encodes canonical paths in the shared request helper", async () => {
    await browseLocalFiles("c:/Users/a b/data.zarr");
    expect(calls[0].url).toBe(
      `/api/browse?path=${encodeURIComponent("c:/Users/a b/data.zarr")}`,
    );
  });
});

describe("workspace saved view API", () => {
  it("lists saved views under the workspace route", async () => {
    await listWorkspaceSavedViews("workspace/a b");
    expect(calls[0].url).toBe("/api/workspaces/workspace%2Fa%20b/saved-views");
    expect(calls[0].init?.credentials).toBe("same-origin");
  });

  it("gets a single saved view with encoded ids", async () => {
    responder = () => jsonResponse(200, {
      id: "view/1",
      workspace_id: "workspace/a b",
      name: "view",
      created_by: "alice@example.com",
      created_by_name: "Alice",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T00:00:00Z",
      view: emptyView(),
    });

    await getWorkspaceSavedView("workspace/a b", "view/1");
    expect(calls[0].url).toBe("/api/workspaces/workspace%2Fa%20b/saved-views/view%2F1");
  });

  it("gets a private viewer profile with encoded names", async () => {
    responder = () => jsonResponse(200, {
      workspace_id: "workspace/a b",
      user_email: "alice@example.com",
      profile: "cli.default",
      created_at: "2026-06-06T00:00:00Z",
      updated_at: "2026-06-06T00:00:00Z",
      seed_source: "workspace_snapshot",
      view: emptyView(),
    });

    const profile = await getWorkspaceViewerProfile("workspace/a b", "cli.default");
    expect(profile?.profile).toBe("cli.default");
    expect(calls[0].url).toBe(
      "/api/workspaces/workspace%2Fa%20b/viewer-profiles/cli.default",
    );
  });

  it("returns null when a private viewer profile is not initialized", async () => {
    responder = () => new Response(null, { status: 204 });
    await expect(getWorkspaceViewerProfile("workspace-1", "default")).resolves.toBeNull();
  });

  it("POSTs name and view when creating", async () => {
    responder = () => jsonResponse(201, {
      id: "view-1",
      workspace_id: "workspace-1",
      name: "view",
      created_by: "alice@example.com",
      created_by_name: "Alice",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T00:00:00Z",
      view: emptyView(),
    });

    await createWorkspaceSavedView("workspace-1", "view", emptyView());
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/workspaces/workspace-1/saved-views");
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      name: "view",
      view: { v: SAVED_VIEW_VERSION },
    });
  });

  it("PATCHes partial updates", async () => {
    responder = () => jsonResponse(200, {
      id: "view-1",
      workspace_id: "workspace-1",
      name: "renamed",
      created_by: "alice@example.com",
      created_by_name: "Alice",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T00:00:00Z",
      view: emptyView(),
    });

    await updateWorkspaceSavedView("workspace-1", "view-1", { name: "renamed" });
    expect(calls[0].method).toBe("PATCH");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ name: "renamed" });
  });

  it("DELETEs a saved view", async () => {
    responder = () => new Response(null, { status: 204 });
    await deleteWorkspaceSavedView("workspace-1", "view-1");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("/api/workspaces/workspace-1/saved-views/view-1");
  });

  it("PATCHes visibility to promote a saved view and returns the updated view", async () => {
    responder = () => jsonResponse(200, {
      id: "view/1",
      workspace_id: "workspace/a b",
      name: "view",
      created_by: "alice@example.com",
      created_by_name: "Alice",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
      visibility: "shared",
      view: emptyView(),
    });

    const updated = await setWorkspaceSavedViewVisibility(
      "workspace/a b",
      "view/1",
      "shared",
    );
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(
      "/api/workspaces/workspace%2Fa%20b/saved-views/view%2F1/visibility",
    );
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ visibility: "shared" });
    expect(updated.visibility).toBe("shared");
    // Attribution is preserved end-to-end (the server returns created_by).
    expect(updated.created_by).toBe("alice@example.com");
  });

  it("PATCHes visibility to demote a saved view back to personal", async () => {
    responder = () => jsonResponse(200, {
      id: "view-1",
      workspace_id: "workspace-1",
      name: "view",
      created_by: "alice@example.com",
      created_by_name: "Alice",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
      visibility: "personal",
      view: emptyView(),
    });

    await setWorkspaceSavedViewVisibility("workspace-1", "view-1", "personal");
    expect(calls[0].url).toBe(
      "/api/workspaces/workspace-1/saved-views/view-1/visibility",
    );
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ visibility: "personal" });
  });

  it("PATCHes the workspace default saved view pointer", async () => {
    responder = () => jsonResponse(200, {
      id: "workspace-1",
      name: "Workspace",
      role: "editor",
      created_by: "alice@example.com",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T00:00:00Z",
      archived_at: null,
      seq: 1,
      default_saved_view_id: "view-1",
      last_opened_at: null,
      pinned_at: null,
    });

    await updateWorkspaceDefaultSavedView("workspace-1", "view-1");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("/api/workspaces/workspace-1/default-saved-view");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      saved_view_id: "view-1",
    });
  });

  it("clears the workspace default saved view pointer", async () => {
    responder = () => jsonResponse(200, {
      id: "workspace-1",
      name: "Workspace",
      role: "editor",
      created_by: "alice@example.com",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T00:00:00Z",
      archived_at: null,
      seq: 1,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });

    await updateWorkspaceDefaultSavedView("workspace-1", null);
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      saved_view_id: null,
    });
  });

  it("POSTs to duplicate a workspace and returns the new copy (#698)", async () => {
    responder = () => jsonResponse(201, {
      id: "workspace-copy",
      name: "Copy of Project",
      role: "owner",
      created_by: "alice@example.com",
      created_at: "2026-06-22T00:00:00Z",
      updated_at: "2026-06-22T00:00:00Z",
      archived_at: null,
      seq: 0,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });

    const copy = await duplicateWorkspace("workspace/a b");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/workspaces/workspace%2Fa%20b/duplicate");
    // The caller owns the copy and it is named "Copy of …" by the server.
    expect(copy.id).toBe("workspace-copy");
    expect(copy.name).toBe("Copy of Project");
    expect(copy.role).toBe("owner");
  });

  it("POSTs duplicate with an explicit name override (#698)", async () => {
    responder = () => jsonResponse(201, {
      id: "workspace-copy",
      name: "My Experiment",
      role: "owner",
      created_by: "alice@example.com",
      created_at: "2026-06-22T00:00:00Z",
      updated_at: "2026-06-22T00:00:00Z",
      archived_at: null,
      seq: 0,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });

    await duplicateWorkspace("workspace-1", "My Experiment");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ name: "My Experiment" });
  });

  it("POSTs to open a workspace and record recents", async () => {
    responder = () => jsonResponse(200, {
      id: "workspace-1",
      name: "Workspace",
      role: "viewer",
      created_by: "alice@example.com",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T00:00:00Z",
      archived_at: null,
      seq: 1,
      default_saved_view_id: null,
      last_opened_at: "2026-05-29T01:00:00Z",
      pinned_at: null,
    });

    await openWorkspace("workspace-1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/workspaces/workspace-1");
  });

  it("PATCHes personal workspace pin state", async () => {
    responder = () => jsonResponse(200, {
      workspace_id: "workspace-1",
      last_opened_at: "2026-05-29T01:00:00Z",
      pinned_at: "2026-05-29T02:00:00Z",
    });

    await updateWorkspacePin("workspace-1", true);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("/api/workspaces/workspace-1/pin");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ pinned: true });
  });

  it("PATCHes the per-user last view with a {view} body (#700)", async () => {
    responder = () => jsonResponse(200, {
      workspace_id: "workspace/a b",
      last_opened_at: "2026-06-19T01:00:00Z",
      pinned_at: null,
      last_view: emptyView(),
    });

    const state = await updateWorkspaceLastView("workspace/a b", emptyView());
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("/api/workspaces/workspace%2Fa%20b/last-view");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      view: emptyView(),
    });
    expect(state.last_view).toMatchObject({ v: SAVED_VIEW_VERSION });
  });

  it("GETs the principal-scoped user state incl. last_view (#700)", async () => {
    responder = () => jsonResponse(200, {
      workspace_id: "workspace-1",
      last_opened_at: "2026-06-19T01:00:00Z",
      pinned_at: null,
      last_view: emptyView(),
    });

    const state = await getWorkspaceUserState("workspace-1");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("/api/workspaces/workspace-1/user-state");
    expect(state.last_view).toMatchObject({ v: SAVED_VIEW_VERSION });
  });

  it("tolerates a user state with no remembered last view (#700)", async () => {
    responder = () => jsonResponse(200, {
      workspace_id: "workspace-1",
      last_opened_at: null,
      pinned_at: null,
    });

    const state = await getWorkspaceUserState("workspace-1");
    expect(state.last_view ?? null).toBeNull();
  });

  it("lists archived workspaces under the archived route", async () => {
    await listArchivedWorkspaces();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("/api/workspaces/archived");
  });

  it("POSTs archive and restore lifecycle actions", async () => {
    responder = () => jsonResponse(200, {
      id: "workspace-1",
      name: "Workspace",
      role: "owner",
      created_by: "alice@example.com",
      created_at: "2026-05-29T00:00:00Z",
      updated_at: "2026-05-29T00:00:00Z",
      archived_at: "2026-05-29T03:00:00Z",
      seq: 1,
      default_saved_view_id: null,
      last_opened_at: null,
      pinned_at: null,
    });

    await archiveWorkspace("workspace-1");
    await restoreWorkspace("workspace-1");

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/workspaces/workspace-1/archive");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe("/api/workspaces/workspace-1/restore");
  });
});
