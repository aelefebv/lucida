// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  WorkspaceSavedViewsSidebar,
  type WorkspaceSavedViewsSidebarProps,
} from "./WorkspaceSavedViewsSidebar.tsx";
import { SAVED_VIEW_VERSION, type SavedView } from "../savedView/types.ts";

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

function savedViewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "view-1",
    workspace_id: "ws-1",
    name: "Shared view",
    created_by: "alice@example.com",
    created_by_name: "Alice",
    created_at: "2026-05-29T00:00:00Z",
    updated_at: "2026-05-29T00:00:00Z",
    visibility: "shared",
    view: emptyView(),
    ...overrides,
  };
}

function baseProps(canEdit: boolean): WorkspaceSavedViewsSidebarProps {
  return {
    workspaceId: "ws-1",
    currentUserEmail: "alice@example.com",
    canEdit,
    getCurrentSavedView: () => emptyView(),
    onOpenSavedView: () => {},
    loadedDatasetNames: ["dataset.zarr"],
    defaultSavedViewId: null,
    onSetDefaultSavedView: async () => {},
    visible: true,
  };
}

async function renderSidebar(canEdit: boolean) {
  await act(async () => {
    render(<WorkspaceSavedViewsSidebar {...baseProps(canEdit)} />);
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
  cleanup();
});

describe("WorkspaceSavedViewsSidebar — visibility on rows", () => {
  it("marks shared and personal rows with data-visibility and a Personal cue", async () => {
    responder = () =>
      jsonResponse(200, [
        savedViewRow({ id: "s1", name: "Team layout", visibility: "shared" }),
        savedViewRow({ id: "p1", name: "My layout", visibility: "personal" }),
      ]);
    await renderSidebar(true);

    const rows = screen.getAllByTestId("saved-view-row");
    expect(rows).toHaveLength(2);

    const shared = rows.find((r) => within(r).queryByText("Team layout"));
    const personal = rows.find((r) => within(r).queryByText("My layout"));
    expect(shared?.getAttribute("data-visibility")).toBe("shared");
    expect(personal?.getAttribute("data-visibility")).toBe("personal");

    // Visible cue only on the personal row.
    expect(within(personal as HTMLElement).getByText("Personal")).toBeTruthy();
    expect(within(shared as HTMLElement).queryByText("Personal")).toBeNull();
  });
});

async function openRowMenu(view: { name: string }) {
  const rows = screen.getAllByTestId("saved-view-row");
  const row = rows.find((r) => within(r).queryByText(view.name)) as HTMLElement;
  const trigger = within(row).getByRole("button", { name: /saved view actions/i });
  await userEvent.click(trigger);
  return screen.getByRole("menu");
}

describe("WorkspaceSavedViewsSidebar — promote to shared", () => {
  it("shows 'Share with team' for an own personal view (editor), PATCHes visibility, and the row becomes shared", async () => {
    let listBody = [
      savedViewRow({ id: "p1", name: "My layout", visibility: "personal" }),
    ];
    let patchBody: Record<string, unknown> | null = null;
    let patchedUrl: string | null = null;
    let patchMethod: string | null = null;
    responder = (url, init) => {
      if (init?.method === "PATCH") {
        patchMethod = init.method;
        patchBody = JSON.parse(init.body as string) as Record<string, unknown>;
        patchedUrl = url;
        // Server promotes it; the canonical row now reads as shared.
        const promoted = savedViewRow({ id: "p1", name: "My layout", visibility: "shared" });
        listBody = [promoted];
        return jsonResponse(200, promoted);
      }
      return jsonResponse(200, listBody);
    };
    await renderSidebar(true);

    const menu = await openRowMenu({ name: "My layout" });
    const promote = within(menu).getByTestId("saved-view-promote-p1");
    expect(promote.textContent).toMatch(/share with team/i);

    await act(async () => {
      await userEvent.click(promote);
    });

    expect(patchMethod).toBe("PATCH");
    expect(patchBody).toEqual({ visibility: "shared" });
    expect(patchedUrl).toBe("/api/workspaces/ws-1/saved-views/p1/visibility");

    // The row lost its Personal chip once the server's shared row landed.
    const row = screen
      .getAllByTestId("saved-view-row")
      .find((r) => within(r).queryByText("My layout")) as HTMLElement;
    expect(row.getAttribute("data-visibility")).toBe("shared");
    expect(within(row).queryByText("Personal")).toBeNull();
  });

  it("does not offer 'Share with team' for a shared view", async () => {
    responder = () =>
      jsonResponse(200, [savedViewRow({ id: "s1", name: "Team layout", visibility: "shared" })]);
    await renderSidebar(true);

    const menu = await openRowMenu({ name: "Team layout" });
    expect(within(menu).queryByTestId("saved-view-promote-s1")).toBeNull();
  });

  it("does not offer 'Share with team' for someone else's personal view", async () => {
    responder = () =>
      jsonResponse(200, [
        savedViewRow({
          id: "p2",
          name: "Bob layout",
          visibility: "personal",
          created_by: "bob@example.com",
          created_by_name: "Bob",
        }),
      ]);
    await renderSidebar(true);

    const menu = await openRowMenu({ name: "Bob layout" });
    expect(within(menu).queryByTestId("saved-view-promote-p2")).toBeNull();
  });

  it("does not offer 'Share with team' to a viewer (cannot edit) even on their own personal view", async () => {
    responder = () =>
      jsonResponse(200, [savedViewRow({ id: "p1", name: "My layout", visibility: "personal" })]);
    await renderSidebar(false);

    const menu = await openRowMenu({ name: "My layout" });
    expect(within(menu).queryByTestId("saved-view-promote-p1")).toBeNull();
  });
});

describe("WorkspaceSavedViewsSidebar — save modal (editor)", () => {
  it("defaults to personal, lets the editor pick shared, and POSTs visibility", async () => {
    // Slice 2 (#699/#700 follow-up): the dialog now defaults to Personal for ALL
    // roles so a hurried save can't broadcast to the team by accident; an editor
    // can still deliberately pick Shared.
    let postBody: Record<string, unknown> | null = null;
    responder = (_url, init) => {
      if (init?.method === "POST") {
        postBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return jsonResponse(201, savedViewRow({ id: "new", visibility: "shared" }));
      }
      return jsonResponse(200, []);
    };
    await renderSidebar(true);

    await userEvent.click(screen.getByRole("button", { name: /save view/i }));

    const shared = screen.getByTestId("visibility-shared") as HTMLInputElement;
    const personal = screen.getByTestId("visibility-personal") as HTMLInputElement;
    expect(shared.disabled).toBe(false);
    expect(personal.checked).toBe(true);
    expect(shared.checked).toBe(false);

    await userEvent.click(shared);
    expect(shared.checked).toBe(true);

    await act(async () => {
      await userEvent.click(screen.getByTestId("saved-view-save-confirm"));
    });

    expect(postBody).not.toBeNull();
    expect(postBody).toMatchObject({ visibility: "shared" });
  });
});

describe("WorkspaceSavedViewsSidebar — save modal (viewer)", () => {
  it("shows Save view, defaults to personal, disables shared, and POSTs personal", async () => {
    let postBody: Record<string, unknown> | null = null;
    responder = (_url, init) => {
      if (init?.method === "POST") {
        postBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return jsonResponse(201, savedViewRow({ id: "new", visibility: "personal" }));
      }
      return jsonResponse(200, []);
    };
    await renderSidebar(false);

    // The Save view button is available to viewers too.
    const saveBtn = screen.getByRole("button", { name: /save view/i });
    await userEvent.click(saveBtn);

    const shared = screen.getByTestId("visibility-shared") as HTMLInputElement;
    const personal = screen.getByTestId("visibility-personal") as HTMLInputElement;
    expect(personal.checked).toBe(true);
    expect(shared.disabled).toBe(true);
    expect(shared.checked).toBe(false);

    // Clicking the disabled shared option must not change the selection.
    fireEvent.click(shared);
    expect(personal.checked).toBe(true);

    await act(async () => {
      await userEvent.click(screen.getByTestId("saved-view-save-confirm"));
    });

    expect(postBody).toMatchObject({ visibility: "personal" });
  });
});
