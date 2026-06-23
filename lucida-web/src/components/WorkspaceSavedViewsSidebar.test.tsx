// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// --- Coverage ported from the deleted BookmarkSidebar.test.tsx ---------------
// These four behavior groups (rename, delete-with-confirm, copy link, filter)
// were exercised only by the now-removed BookmarkSidebar test. They are still
// live in WorkspaceSavedViewsSidebar, so they are re-asserted here against the
// successor component's real API and DOM (menu via "Saved view actions" ->
// role="menu"; rename via .bookmark-name-input; delete via a role="alertdialog"
// ConfirmModal; PATCH/DELETE to /api/workspaces/<ws>/saved-views/<id>).

describe("WorkspaceSavedViewsSidebar — inline rename", () => {
  it("Enter commits the new name via PATCH", async () => {
    let patchBody: Record<string, unknown> | null = null;
    let patchUrl: string | null = null;
    let patchMethod: string | null = null;
    responder = (url, init) => {
      if (init?.method === "PATCH") {
        patchMethod = init.method;
        patchUrl = url;
        patchBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return jsonResponse(200, savedViewRow({ id: "p1", name: "renamed", visibility: "personal" }));
      }
      return jsonResponse(200, [savedViewRow({ id: "p1", name: "old", visibility: "personal" })]);
    };
    await renderSidebar(true);

    const menu = await openRowMenu({ name: "old" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: /rename/i }));

    // The rename input renders in place of the name (class set by RenameInput);
    // pick it by class so the search box isn't grabbed instead.
    const input = document.querySelector(".bookmark-name-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await userEvent.clear(input);
    await act(async () => {
      await userEvent.type(input, "renamed{Enter}");
    });

    expect(patchMethod).toBe("PATCH");
    expect(patchUrl).toBe("/api/workspaces/ws-1/saved-views/p1");
    expect(patchBody).toEqual({ name: "renamed" });
  });

  it("Esc cancels the rename without PATCHing", async () => {
    responder = (_url, init) => {
      if (init?.method === "PATCH") {
        return jsonResponse(200, savedViewRow({ id: "p1", visibility: "personal" }));
      }
      return jsonResponse(200, [savedViewRow({ id: "p1", name: "old", visibility: "personal" })]);
    };
    await renderSidebar(true);

    const menu = await openRowMenu({ name: "old" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: /rename/i }));

    const input = document.querySelector(".bookmark-name-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await userEvent.clear(input);
    await act(async () => {
      await userEvent.type(input, "won't commit{Escape}");
    });

    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // The rename input closed; the original name is shown again.
    expect(document.querySelector(".bookmark-name-input")).toBeNull();
    expect(screen.getByText("old")).toBeTruthy();
  });
});

describe("WorkspaceSavedViewsSidebar — delete confirmation", () => {
  it("requires confirmation, then DELETEs the view", async () => {
    let deleteUrl: string | null = null;
    let deleteMethod: string | null = null;
    responder = (url, init) => {
      if (init?.method === "DELETE") {
        deleteMethod = init.method;
        deleteUrl = url;
        return new Response(null, { status: 204 });
      }
      return jsonResponse(200, [savedViewRow({ id: "p1", name: "Doomed", visibility: "personal" })]);
    };
    await renderSidebar(true);

    const menu = await openRowMenu({ name: "Doomed" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: /delete/i }));

    // Confirmation dialog appears naming the view; no DELETE has fired yet.
    const dialog = await screen.findByRole("alertdialog", { name: /confirm delete/i });
    expect(within(dialog).getByText(/Doomed/)).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await act(async () => {
      await userEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    });

    expect(deleteMethod).toBe("DELETE");
    expect(deleteUrl).toBe("/api/workspaces/ws-1/saved-views/p1");
  });

  it("Cancel from the confirmation modal does NOT DELETE", async () => {
    responder = (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse(200, [savedViewRow({ id: "p1", name: "Doomed", visibility: "personal" })]);
    };
    await renderSidebar(true);

    const menu = await openRowMenu({ name: "Doomed" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: /delete/i }));

    const dialog = await screen.findByRole("alertdialog", { name: /confirm delete/i });
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("WorkspaceSavedViewsSidebar — copy view link", () => {
  it("writes the #b=<encoded id> deep link to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    // An id with a character that must be URL-encoded, so the encodeURIComponent
    // step is actually asserted (not just a passthrough).
    responder = () =>
      jsonResponse(200, [savedViewRow({ id: "a b/c", name: "Linkable", visibility: "shared" })]);
    await renderSidebar(true);

    const menu = await openRowMenu({ name: "Linkable" });
    await act(async () => {
      await userEvent.click(within(menu).getByRole("menuitem", { name: /copy view link/i }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const arg = writeText.mock.calls[0][0] as string;
    expect(arg).toContain(`#b=${encodeURIComponent("a b/c")}`);
    expect(arg).toContain("#b=a%20b%2Fc");
  });
});

describe("WorkspaceSavedViewsSidebar — filter and search", () => {
  it("'Mine only' filters the list to the current user's views", async () => {
    responder = () =>
      jsonResponse(200, [
        savedViewRow({ id: "b1", name: "alice 1", created_by: "alice@example.com", visibility: "personal" }),
        savedViewRow({ id: "b2", name: "bob 1", created_by: "bob@example.com", created_by_name: "Bob", visibility: "shared" }),
      ]);
    await renderSidebar(true);

    expect(screen.getByText("alice 1")).toBeTruthy();
    expect(screen.getByText("bob 1")).toBeTruthy();

    await userEvent.click(screen.getByRole("checkbox", { name: /mine only/i }));

    expect(screen.getByText("alice 1")).toBeTruthy();
    expect(screen.queryByText("bob 1")).toBeNull();
  });

  it("the search box filters the list by name substring", async () => {
    responder = () =>
      jsonResponse(200, [
        savedViewRow({ id: "b1", name: "Apoptosis", visibility: "shared" }),
        savedViewRow({ id: "b2", name: "CYP7A1", visibility: "shared" }),
      ]);
    await renderSidebar(true);

    const search = screen.getByPlaceholderText(/search/i);
    await userEvent.type(search, "Apop");

    expect(screen.getByText("Apoptosis")).toBeTruthy();
    expect(screen.queryByText("CYP7A1")).toBeNull();
  });
});
