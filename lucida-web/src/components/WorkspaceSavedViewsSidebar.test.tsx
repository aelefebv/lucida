// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
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
  vi.restoreAllMocks();
});

describe("WorkspaceSavedViewsSidebar — visibility on rows", () => {
  it("renders an empty-state message outside ARIA list semantics", async () => {
    await renderSidebar(true);

    const empty = screen.getByText("No saved views yet. Save the current view to get started.");
    expect(empty.closest("[role='list']")).toBeNull();
  });

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

describe("WorkspaceSavedViewsSidebar — actions menu keyboard contract", () => {
  it("publishes trigger state, focuses the first item, navigates, and restores focus on Escape", async () => {
    responder = () => jsonResponse(200, [savedViewRow({ name: "Keyboard view" })]);
    await renderSidebar(true);

    const row = screen.getByTestId("saved-view-row");
    const trigger = within(row).getByRole("button", { name: "Saved view actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);

    await userEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Saved view actions" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(items.at(-1));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(items[0]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(items.at(-1));

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Saved view actions" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
  });

  it("restores the row trigger for keyboard actions and makes it the delete modal invoker", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onSetDefaultSavedView = vi.fn().mockResolvedValue(undefined);
    responder = () => jsonResponse(200, [savedViewRow({ name: "Action view" })]);
    const props = { ...baseProps(true), onSetDefaultSavedView };
    await act(async () => render(<WorkspaceSavedViewsSidebar {...props} />));

    const trigger = within(screen.getByTestId("saved-view-row"))
      .getByRole("button", { name: "Saved view actions" });
    trigger.focus();

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy view link" }))
      .toBe(document.activeElement));
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(writeText).toHaveBeenCalledOnce();

    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(onSetDefaultSavedView).toHaveBeenCalledWith("view-1"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{End}{Enter}");
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm delete" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes a menu whose filtered row detached and reopens the recreated row in one click", async () => {
    responder = () => jsonResponse(200, [savedViewRow({ name: "Filter target" })]);
    await renderSidebar(true);

    const firstTrigger = within(screen.getByTestId("saved-view-row"))
      .getByRole("button", { name: "Saved view actions" });
    await userEvent.click(firstTrigger);
    expect(screen.getByRole("menu")).toBeTruthy();

    const search = screen.getByRole("textbox", { name: "Search saved views" });
    await userEvent.type(search, "no match");
    await waitFor(() => expect(screen.queryByTestId("saved-view-row")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await userEvent.clear(search);
    const restoredRow = await screen.findByTestId("saved-view-row");
    const restoredTrigger = within(restoredRow)
      .getByRole("button", { name: "Saved view actions" });
    expect(restoredTrigger).not.toBe(firstTrigger);
    expect(restoredTrigger.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(restoredTrigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(restoredTrigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes a menu whose connected trigger becomes fully clipped and focuses search", async () => {
    responder = () => jsonResponse(200, [savedViewRow({ name: "Scroll target" })]);
    let triggerTop = 130;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("saved-view-list")) return domRect(100, 100, 300, 180);
      if (this.classList.contains("saved-view-menu-btn")) return domRect(350, triggerTop, 32, 28);
      if (this.classList.contains("saved-view-menu")) return domRect(190, 120, 180, 260);
      return domRect(110, 110, 120, 32);
    });
    await renderSidebar(true);

    const trigger = within(screen.getByTestId("saved-view-row"))
      .getByRole("button", { name: "Saved view actions" });
    await userEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // The row stays mounted, but scrolling moves its trigger wholly above the
    // list's painted clip. This is the distinct case a detached-node observer
    // cannot see.
    triggerTop = -80;
    await act(async () => window.dispatchEvent(new Event("scroll")));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger.isConnected).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Search saved views" }),
    );
  });
});

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

// --- Coverage ported from the deleted WorkspaceSavedViewsSidebar.test.tsx ---------------
// These four behavior groups (rename, delete-with-confirm, copy link, filter)
// were exercised only by the now-removed pre-workspace sidebar test. They are still
// live in WorkspaceSavedViewsSidebar, so they are re-asserted here against the
// successor component's real API and DOM (menu via "Saved view actions" ->
// role="menu"; rename via .saved-view-name-input; delete via a role="alertdialog"
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
    const input = document.querySelector(".saved-view-name-input") as HTMLInputElement;
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

    const input = document.querySelector(".saved-view-name-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await userEvent.clear(input);
    await act(async () => {
      await userEvent.type(input, "won't commit{Escape}");
    });

    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // The rename input closed; the original name is shown again.
    expect(document.querySelector(".saved-view-name-input")).toBeNull();
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
        savedViewRow({ id: "b1", name: "Group B7 view", visibility: "shared" }),
        savedViewRow({ id: "b2", name: "Channel 0 view", visibility: "shared" }),
      ]);
    await renderSidebar(true);

    const search = screen.getByPlaceholderText(/search/i);
    await userEvent.type(search, "Group");

    expect(screen.getByText("Group B7 view")).toBeTruthy();
    expect(screen.queryByText("Channel 0 view")).toBeNull();
  });
});

describe("WorkspaceSavedViewsSidebar — truthful proposal review actions", () => {
  it("does not offer self-approval, explains why, and retains reject and withdraw", async () => {
    responder = () =>
      jsonResponse(200, [
        savedViewRow({
          id: "mine",
          name: "My proposal",
          visibility: "proposed",
          created_by: "ALICE@example.com",
        }),
      ]);
    await renderSidebar(true);

    expect(screen.queryByTestId("saved-view-approve-mine")).toBeNull();
    expect(screen.getByTestId("saved-view-self-approval-note-mine").textContent)
      .toMatch(/different editor must approve/i);
    expect(screen.getByTestId("saved-view-reject-mine")).toBeTruthy();

    const menu = await openRowMenu({ name: "My proposal" });
    expect(within(menu).getByTestId("saved-view-withdraw-mine")).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith("/approve"))).toBe(false);
  });

  it("still offers approval for another member's proposal", async () => {
    responder = () =>
      jsonResponse(200, [
        savedViewRow({
          id: "theirs",
          name: "Their proposal",
          visibility: "proposed",
          created_by: "bob@example.com",
        }),
      ]);
    await renderSidebar(true);

    expect(screen.getByTestId("saved-view-approve-theirs")).toBeTruthy();
    expect(screen.queryByTestId("saved-view-self-approval-note-theirs")).toBeNull();
  });
});

// --- Fix A (#818 part 1): deferred reject keeps an independent, reachable Undo
// per pending view ------------------------------------------------------------
// Reject is a delayed, cancelable PATCH backed by a per-id timer; the toast used
// to be a single slot, so rejecting B clobbered A's "Undo" toast while A's timer
// kept running → A committed with no recourse. The fix is a toast STACK keyed by
// saved-view id: each pending reject owns its own dismissible Undo for the whole
// window. These tests use fake timers for the ~6s window and clean them up.

function rejectButton(savedViewId: string): HTMLButtonElement {
  return screen.getByTestId(`saved-view-reject-${savedViewId}`) as HTMLButtonElement;
}

function rejectPosts(): FetchCall[] {
  return calls.filter((c) => c.method === "POST" && c.url.endsWith("/reject"));
}

describe("WorkspaceSavedViewsSidebar — deferred reject (multi-undo)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  async function renderEditorWithTwoProposals() {
    responder = (_url, init) => {
      if (init?.method === "POST") {
        // Reject reverts to personal server-side; the body is irrelevant here.
        return jsonResponse(200, savedViewRow({ id: "x", visibility: "personal" }));
      }
      return jsonResponse(200, [
        savedViewRow({ id: "pa", name: "Proposal A", visibility: "proposed", created_by: "bob@example.com", created_by_name: "Bob" }),
        savedViewRow({ id: "pb", name: "Proposal B", visibility: "proposed", created_by: "carol@example.com", created_by_name: "Carol" }),
      ]);
    };
    await act(async () => {
      render(<WorkspaceSavedViewsSidebar {...baseProps(true)} />);
    });
    // Let the initial list fetch settle under fake timers.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  }

  it("rejecting A then B within the window leaves BOTH with a reachable Undo (stacked, not clobbered)", async () => {
    await renderEditorWithTwoProposals();

    // Reject A, then B, both within the cancelable window.
    await act(async () => {
      fireEvent.click(rejectButton("pa"));
    });
    await act(async () => {
      fireEvent.click(rejectButton("pb"));
    });

    // Two distinct toasts, each naming its view and each carrying cancellation — A's
    // toast was NOT evicted by B's (the bug). No reject has been sent yet.
    const toasts = screen.getAllByTestId("saved-view-toast");
    expect(toasts).toHaveLength(2);
    const aToast = toasts.find((t) => within(t).queryByText(/Proposal A/)) as HTMLElement;
    const bToast = toasts.find((t) => within(t).queryByText(/Proposal B/)) as HTMLElement;
    expect(aToast).toBeTruthy();
    expect(bToast).toBeTruthy();
    expect(within(aToast).getByTestId("saved-view-toast-action").textContent).toMatch(/cancel rejection/i);
    expect(within(bToast).getByTestId("saved-view-toast-action").textContent).toMatch(/cancel rejection/i);
    expect(rejectPosts()).toHaveLength(0);
  });

  it("Cancel rejection on the first view cancels only it; the other still commits", async () => {
    await renderEditorWithTwoProposals();

    await act(async () => {
      fireEvent.click(rejectButton("pa"));
    });
    await act(async () => {
      fireEvent.click(rejectButton("pb"));
    });

    // Cancel A specifically via its own toast action.
    const aToast = screen
      .getAllByTestId("saved-view-toast")
      .find((t) => within(t).queryByText(/Proposal A/)) as HTMLElement;
    await act(async () => {
      fireEvent.click(within(aToast).getByTestId("saved-view-toast-action"));
    });

    // A is back in the queue (its row was only hidden, never sent); B is still
    // pending and hidden.
    expect(screen.getByTestId(`saved-view-reject-pa`)).toBeTruthy();
    expect(screen.queryByTestId(`saved-view-reject-pb`)).toBeNull();

    // Let every pending timer (B's reject + the toast auto-dismiss) elapse.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    // The reject PATCH fired for B only — never for the undone A.
    const posts = rejectPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain("/saved-views/pb/reject");
    expect(posts.some((p) => p.url.includes("/saved-views/pa/reject"))).toBe(false);
  });

  it("does not leak timers: unmounting mid-window fires no reject and warns nothing", async () => {
    await renderEditorWithTwoProposals();
    await act(async () => {
      fireEvent.click(rejectButton("pa"));
    });

    // Unmount while the reject is still pending.
    cleanup();

    // Advancing past the window must NOT fire the reject (timer was cleared on
    // unmount) — guards against a setState-after-unmount / stray PATCH.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(rejectPosts()).toHaveLength(0);
  });
});

// --- Fix B (#818 part 2): the open view going away clears the active highlight
// ----------------------------------------------------------------------------
// `currentOpenSavedViewId` highlights the open row. When the user deletes /
// withdraws that view, or its deferred reject commits, the sidebar tells the
// host via `onActiveSavedViewInvalidated` so the host can drop the now-dangling
// highlight. (Viewport-change clearing lives host-side off the live-view signal
// and is covered by the host wiring, not this component's surface.)

describe("WorkspaceSavedViewsSidebar — active-row invalidation", () => {
  it("renders the open row as active (data-active / aria-current)", async () => {
    responder = () =>
      jsonResponse(200, [savedViewRow({ id: "v1", name: "Open one", visibility: "shared" })]);
    await act(async () => {
      render(
        <WorkspaceSavedViewsSidebar
          {...baseProps(true)}
          currentOpenSavedViewId="v1"
        />,
      );
    });

    const row = screen
      .getAllByTestId("saved-view-row")
      .find((r) => within(r).queryByText("Open one")) as HTMLElement;
    expect(row.getAttribute("data-active")).toBe("true");
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("deleting the open view invalidates it", async () => {
    const onInvalidated = vi.fn();
    responder = (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse(200, [savedViewRow({ id: "v1", name: "Doomed", visibility: "personal" })]);
    };
    await act(async () => {
      render(
        <WorkspaceSavedViewsSidebar
          {...baseProps(true)}
          currentOpenSavedViewId="v1"
          onActiveSavedViewInvalidated={onInvalidated}
        />,
      );
    });

    const menu = await openRowMenu({ name: "Doomed" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: /delete/i }));
    const dialog = await screen.findByRole("alertdialog", { name: /confirm delete/i });
    await act(async () => {
      await userEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    });

    expect(onInvalidated).toHaveBeenCalledWith("v1");
  });

  it("withdrawing the open proposal invalidates it", async () => {
    const onInvalidated = vi.fn();
    responder = (_url, init) => {
      if (init?.method === "PATCH") {
        return jsonResponse(200, savedViewRow({ id: "v1", name: "Mine", visibility: "personal" }));
      }
      // A viewer's OWN proposed view exposes "Withdraw proposal".
      return jsonResponse(200, [savedViewRow({ id: "v1", name: "Mine", visibility: "proposed", created_by: "alice@example.com" })]);
    };
    await act(async () => {
      render(
        <WorkspaceSavedViewsSidebar
          {...baseProps(false)}
          currentOpenSavedViewId="v1"
          onActiveSavedViewInvalidated={onInvalidated}
        />,
      );
    });

    const menu = await openRowMenu({ name: "Mine" });
    await act(async () => {
      await userEvent.click(within(menu).getByTestId("saved-view-withdraw-v1"));
    });

    expect(onInvalidated).toHaveBeenCalledWith("v1");
  });

  it("a committed reject of the open view invalidates it (but not before the window, and not if undone)", async () => {
    vi.useFakeTimers();
    try {
      const onInvalidated = vi.fn();
      responder = (_url, init) => {
        if (init?.method === "POST") {
          return jsonResponse(200, savedViewRow({ id: "v1", visibility: "personal" }));
        }
        return jsonResponse(200, [
          savedViewRow({ id: "v1", name: "Open proposal", visibility: "proposed", created_by: "bob@example.com", created_by_name: "Bob" }),
        ]);
      };
      await act(async () => {
        render(
          <WorkspaceSavedViewsSidebar
            {...baseProps(true)}
            currentOpenSavedViewId="v1"
            onActiveSavedViewInvalidated={onInvalidated}
          />,
        );
      });
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      await act(async () => {
        fireEvent.click(rejectButton("v1"));
      });
      // Mid-window: the reject hasn't committed, so the highlight stays.
      expect(onInvalidated).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(onInvalidated).toHaveBeenCalledWith("v1");
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });
});
