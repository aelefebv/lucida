import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approveWorkspaceSavedView,
  createWorkspaceSavedView,
  rejectWorkspaceSavedView,
  type WorkspaceSavedView,
} from "./workspaceApi.ts";
import type { SavedView } from "./savedView/types.ts";

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

function savedView(overrides: Partial<WorkspaceSavedView>): WorkspaceSavedView {
  return {
    id: "sv-1",
    workspace_id: "ws-1",
    name: "proposal",
    created_by: "viewer@example.com",
    created_by_name: "Viewer",
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-20T00:00:00Z",
    visibility: "proposed",
    view: emptyView(),
    ...overrides,
  };
}

function mockFetchOnce(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace proposed saved views API", () => {
  it("creates a saved view with visibility 'proposed'", async () => {
    const fetchMock = mockFetchOnce(savedView({ visibility: "proposed" }), 201);
    const created = await createWorkspaceSavedView(
      "ws-1",
      "proposal",
      emptyView(),
      "proposed",
    );
    expect(created.visibility).toBe("proposed");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/workspaces/ws-1/saved-views");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string);
    expect(sent.visibility).toBe("proposed");
  });

  it("approveWorkspaceSavedView POSTs to .../approve and resolves the shared view", async () => {
    const fetchMock = mockFetchOnce(
      savedView({ visibility: "shared", created_by: "viewer@example.com" }),
    );
    const updated = await approveWorkspaceSavedView("ws-1", "sv-1");
    expect(updated.visibility).toBe("shared");
    // Attribution preserved: the proposer stays the author.
    expect(updated.created_by).toBe("viewer@example.com");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/workspaces/ws-1/saved-views/sv-1/approve");
    expect(init?.method).toBe("POST");
  });

  it("rejectWorkspaceSavedView POSTs to .../reject and resolves the reverted personal view", async () => {
    const fetchMock = mockFetchOnce(savedView({ visibility: "personal" }));
    const updated = await rejectWorkspaceSavedView("ws-1", "sv-1");
    expect(updated.visibility).toBe("personal");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/workspaces/ws-1/saved-views/sv-1/reject");
    expect(init?.method).toBe("POST");
  });

  it("URL-encodes the ids in approve/reject", async () => {
    const fetchMock = mockFetchOnce(savedView({ visibility: "shared" }));
    await approveWorkspaceSavedView("ws/space", "sv id");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/workspaces/ws%2Fspace/saved-views/sv%20id/approve");
  });

  it("rejects on a non-ok response", async () => {
    mockFetchOnce({ error: "forbidden" }, 403);
    await expect(approveWorkspaceSavedView("ws-1", "sv-1")).rejects.toThrow();
  });
});
