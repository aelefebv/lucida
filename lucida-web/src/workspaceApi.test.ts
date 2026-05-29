import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceSavedView,
  deleteWorkspaceSavedView,
  getWorkspaceSavedView,
  listWorkspaceSavedViews,
  updateWorkspaceSavedView,
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
});

