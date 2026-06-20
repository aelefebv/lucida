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

describe("WorkspaceSavedViewsSidebar — save modal (editor)", () => {
  it("defaults to shared, lets the editor pick personal, and POSTs visibility", async () => {
    let postBody: Record<string, unknown> | null = null;
    responder = (_url, init) => {
      if (init?.method === "POST") {
        postBody = JSON.parse(init.body as string) as Record<string, unknown>;
        return jsonResponse(201, savedViewRow({ id: "new", visibility: "personal" }));
      }
      return jsonResponse(200, []);
    };
    await renderSidebar(true);

    await userEvent.click(screen.getByRole("button", { name: /save view/i }));

    const shared = screen.getByTestId("visibility-shared") as HTMLInputElement;
    const personal = screen.getByTestId("visibility-personal") as HTMLInputElement;
    expect(shared.disabled).toBe(false);
    expect(shared.checked).toBe(true);
    expect(personal.checked).toBe(false);

    await userEvent.click(personal);
    expect(personal.checked).toBe(true);

    await act(async () => {
      await userEvent.click(screen.getByTestId("saved-view-save-confirm"));
    });

    expect(postBody).not.toBeNull();
    expect(postBody).toMatchObject({ visibility: "personal" });
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
