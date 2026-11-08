// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  WorkspaceSavedViewsSidebar,
  type WorkspaceSavedViewsSidebarProps,
} from "./WorkspaceSavedViewsSidebar.tsx";
import { SAVED_VIEW_VERSION, type SavedView } from "../savedView/types.ts";
import { ToastRegion } from "../ui/Toast.tsx";
import { toastQueue } from "../ui/toastQueue.ts";

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
  toastQueue.clear();
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
    const promote = within(menu).getByRole("menuitem", { name: /share with team/i });
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
    expect(within(menu).queryByRole("menuitem", { name: /share with team/i })).toBeNull();
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
    expect(within(menu).queryByRole("menuitem", { name: /share with team/i })).toBeNull();
  });

  it("does not offer 'Share with team' to a viewer (cannot edit) even on their own personal view", async () => {
    responder = () =>
      jsonResponse(200, [savedViewRow({ id: "p1", name: "My layout", visibility: "personal" })]);
    await renderSidebar(false);

    const menu = await openRowMenu({ name: "My layout" });
    expect(within(menu).queryByRole("menuitem", { name: /share with team/i })).toBeNull();
  });
});

describe("WorkspaceSavedViewsSidebar — save modal (editor)", () => {
  it("defaults to personal, lets the editor pick shared, and POSTs visibility", async () => {
    // Personal for all roles, so a hurried save can't broadcast to the team; an
    // editor can still pick Shared.
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

    const shared = screen.getByRole("radio", { name: /shared with the team/i }) as HTMLInputElement;
    const personal = screen.getByRole("radio", { name: /^personal/i }) as HTMLInputElement;
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

    const shared = screen.getByRole("radio", { name: /shared with the team/i }) as HTMLInputElement;
    const personal = screen.getByRole("radio", { name: /^personal/i }) as HTMLInputElement;
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
    const input = screen.getByTestId("saved-view-rename-input") as HTMLInputElement;
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

    const input = screen.getByTestId("saved-view-rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await userEvent.clear(input);
    await act(async () => {
      await userEvent.type(input, "won't commit{Escape}");
    });

    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    // The rename input closed; the original name is shown again.
    expect(screen.queryByTestId("saved-view-rename-input")).toBeNull();
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
    const dialog = await screen.findByRole("dialog", { name: /delete saved view/i });
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

    const dialog = await screen.findByRole("dialog", { name: /delete saved view/i });
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
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

    await userEvent.click(screen.getByRole("switch", { name: /mine only/i }));

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

// Each pending reject owns its own Undo toast for the whole window, so
// rejecting B must not clobber A's Undo while A's timer runs. Fake timers cover
// the ~6s window.

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
      render(
        <>
          <WorkspaceSavedViewsSidebar {...baseProps(true)} />
          <ToastRegion />
        </>,
      );
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

    // Two toasts, each naming its view and carrying an Undo: B's did not evict
    // A's. No reject has been sent yet.
    const toasts = screen.getAllByRole("alertdialog");
    expect(toasts).toHaveLength(2);
    const aToast = toasts.find((t) => within(t).queryByText(/Proposal A/)) as HTMLElement;
    const bToast = toasts.find((t) => within(t).queryByText(/Proposal B/)) as HTMLElement;
    expect(aToast).toBeTruthy();
    expect(bToast).toBeTruthy();
    expect(within(aToast).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(bToast).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(rejectPosts()).toHaveLength(0);
  });

  it("Undo on the first reject cancels ONLY it; the other still commits its reject after the window", async () => {
    await renderEditorWithTwoProposals();

    await act(async () => {
      fireEvent.click(rejectButton("pa"));
    });
    await act(async () => {
      fireEvent.click(rejectButton("pb"));
    });

    // Undo A specifically (via A's own toast's Undo button).
    const aToast = screen
      .getAllByRole("alertdialog")
      .find((t) => within(t).queryByText(/Proposal A/)) as HTMLElement;
    await act(async () => {
      fireEvent.click(within(aToast).getByRole("button", { name: "Undo" }));
    });

    // A is back in the queue (its row was only hidden, never sent); B is still
    // pending and hidden.
    expect(screen.getByTestId(`saved-view-reject-pa`)).toBeTruthy();
    expect(screen.queryByTestId(`saved-view-reject-pb`)).toBeNull();

    // Let every pending timer (B's reject + the toast auto-dismiss) elapse.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // B's Undo goes with its window, so nothing is left to undo.
    expect(toastQueue.visibleToasts.some((t) => t.content.action)).toBe(false);

    // The reject fired for B only, never for the undone A.
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

    // Advancing past the window must not fire the reject: unmount cleared the
    // timer, and closed the Undo toast that would now undo nothing.
    expect(toastQueue.visibleToasts).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(rejectPosts()).toHaveLength(0);
  });
});

// When the open view is deleted, withdrawn, or its deferred reject commits, the
// sidebar calls `onActiveSavedViewInvalidated` so the host drops the highlight.
// Viewport-change clearing is host-side and tested there.

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
    const dialog = await screen.findByRole("dialog", { name: /delete saved view/i });
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
      // A viewer's own proposed view exposes "Withdraw proposal".
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
      await userEvent.click(within(menu).getByRole("menuitem", { name: /withdraw proposal/i }));
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
