// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BookmarkSidebar } from "./BookmarkSidebar.tsx";
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

interface ApiSpy {
  calls: Array<{ url: string; init?: RequestInit; method: string }>;
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

let apiSpy: ApiSpy;
let originalFetch: typeof globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  apiSpy = {
    calls: [],
    responder: () => jsonResponse(200, []),
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    apiSpy.calls.push({ url, init, method: init?.method ?? "GET" });
    return apiSpy.responder(url, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

const sample = (overrides: Record<string, unknown> = {}) => ({
  id: "bm-1",
  name: "My view",
  created_by: "alice@example.com",
  created_by_name: "Alice",
  created_at: "2026-05-08T12:00:00Z",
  datasets: ["gs://a.zarr"],
  view: emptyView(),
  ...overrides,
});

describe("BookmarkSidebar — rendering and empty states", () => {
  it("does not render when visible is false", async () => {
    const { container } = render(
      <BookmarkSidebar
        loadedDatasets={[]}
        currentUserEmail="alice@example.com"
        getCurrentSavedView={() => emptyView()}
        visible={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the cold-start empty message when no datasets and no bookmarks", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    expect(screen.getByText(/save the current view to get started/i)).toBeTruthy();
  });

  it("shows the loaded-but-empty message when datasets are loaded but no bookmarks match", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={["gs://a.zarr"]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    expect(screen.getByText(/no bookmarks for currently loaded datasets/i)).toBeTruthy();
  });

  it("renders bookmark rows with name and creator/created-at meta", async () => {
    apiSpy.responder = () => jsonResponse(200, [sample({ id: "b1", name: "Apoptosis B7", created_by_name: "Alice" })]);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={["gs://a.zarr"]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    expect(screen.getByText("Apoptosis B7")).toBeTruthy();
    expect(screen.getByText(/Alice/)).toBeTruthy();
  });
});

describe("BookmarkSidebar — Save current view flow", () => {
  it("opens a modal with the suggested default name and POSTs on Save", async () => {
    apiSpy.responder = (_url, init) => {
      if (init?.method === "POST") {
        return jsonResponse(201, sample({ id: "new", name: "My new bookmark" }));
      }
      return jsonResponse(200, []);
    };
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={["gs://bucket/file.zarr"]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => ({ ...emptyView(), datasets: ["gs://bucket/file.zarr"] })}
          activeLayoutName="Grid"
          visible={true}
        />,
      );
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /save current view/i }));

    // Modal opens with the default name pre-populated.
    const input = await screen.findByRole("dialog", { name: /save current view/i }).then(
      (d) => within(d).getByRole("textbox"),
    );
    expect((input as HTMLInputElement).value).toBe("file.zarr · Grid");

    // Type a custom name.
    await user.clear(input);
    await user.type(input, "Apoptosis B7");

    // Hit Save.
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // POST landed.
    expect(apiSpy.calls.some((c) => c.method === "POST" && c.url === "/api/bookmarks")).toBe(true);
    const post = apiSpy.calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(post.init?.body as string)).toMatchObject({ name: "Apoptosis B7" });
  });

  it("Esc cancels the save modal without POSTing", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /save current view/i }));
    await screen.findByRole("dialog", { name: /save current view/i });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /save current view/i })).toBeNull();
    expect(apiSpy.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("BookmarkSidebar — inline rename", () => {
  it("Enter commits the new name via PATCH", async () => {
    apiSpy.responder = (_url, init) => {
      if (init?.method === "PATCH") {
        return jsonResponse(200, sample({ id: "b1", name: "renamed" }));
      }
      return jsonResponse(200, [sample({ id: "b1", name: "old" })]);
    };
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    const user = userEvent.setup();

    // Open the actions menu.
    await user.click(screen.getByLabelText("Bookmark actions"));
    await user.click(await screen.findByRole("menuitem", { name: /rename/i }));

    // The rename input is the one rendered in place of the bookmark name —
    // pick it by class so we don't grab the search box.
    const input = document.querySelector(".bookmark-name-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await user.clear(input);
    await user.type(input, "renamed{Enter}");

    expect(apiSpy.calls.some((c) => c.method === "PATCH" && c.url === "/api/bookmarks/b1")).toBe(true);
    const patch = apiSpy.calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(patch.init?.body as string)).toEqual({ name: "renamed" });
  });

  it("Esc cancels the rename without PATCHing", async () => {
    apiSpy.responder = () => jsonResponse(200, [sample({ id: "b1", name: "old" })]);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Bookmark actions"));
    await user.click(await screen.findByRole("menuitem", { name: /rename/i }));
    const input = document.querySelector(".bookmark-name-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await user.clear(input);
    await user.type(input, "won't commit{Escape}");
    expect(apiSpy.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("BookmarkSidebar — delete confirmation", () => {
  it("requires confirmation, then DELETEs", async () => {
    apiSpy.responder = (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse(200, [sample({ id: "b1", name: "Doomed" })]);
    };
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Bookmark actions"));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));

    // Confirmation dialog appears mentioning the name.
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Doomed/)).toBeTruthy();
    // No DELETE yet.
    expect(apiSpy.calls.some((c) => c.method === "DELETE")).toBe(false);

    // Confirm.
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    expect(apiSpy.calls.some((c) => c.method === "DELETE" && c.url === "/api/bookmarks/b1")).toBe(true);
  });

  it("Cancel from the confirmation modal does NOT DELETE", async () => {
    apiSpy.responder = () => jsonResponse(200, [sample({ id: "b1" })]);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Bookmark actions"));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(apiSpy.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("BookmarkSidebar — Copy bookmark link", () => {
  it("writes the #b=<id> URL to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiSpy.responder = () => jsonResponse(200, [sample({ id: "abc-123" })]);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    // Use fireEvent so userEvent's pointer-event timing doesn't conflict
    // with the outside-click handler attached on `mousedown`.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Bookmark actions"));
    });
    const copyItem = await screen.findByRole("menuitem", { name: /copy bookmark link/i });
    await act(async () => {
      fireEvent.click(copyItem);
    });
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalled();
    const arg = writeText.mock.calls[0][0] as string;
    expect(arg).toContain("#b=abc-123");
  });
});

describe("BookmarkSidebar — filter and search", () => {
  it("Mine only filters by current principal email", async () => {
    apiSpy.responder = () => jsonResponse(200, [
      sample({ id: "b1", created_by: "alice@example.com", name: "alice 1" }),
      sample({ id: "b2", created_by: "bob@example.com", name: "bob 1" }),
    ]);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /mine only/i }));
    expect(screen.queryByText("bob 1")).toBeNull();
    expect(screen.getByText("alice 1")).toBeTruthy();
  });

  it("search input filters the list by substring", async () => {
    apiSpy.responder = () => jsonResponse(200, [
      sample({ id: "b1", name: "Apoptosis" }),
      sample({ id: "b2", name: "CYP7A1" }),
    ]);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    const user = userEvent.setup();
    const search = screen.getByPlaceholderText(/search/i);
    await user.type(search, "Apop");
    expect(screen.getByText("Apoptosis")).toBeTruthy();
    expect(screen.queryByText("CYP7A1")).toBeNull();
  });
});

describe("BookmarkSidebar — opening a bookmark", () => {
  it("clicking an entry sets window.location.hash to #b=<id> and dispatches popstate", async () => {
    apiSpy.responder = () => jsonResponse(200, [sample({ id: "abc-123", name: "Click me" })]);
    await act(async () => {
      render(
        <BookmarkSidebar
          loadedDatasets={[]}
          currentUserEmail="alice@example.com"
          getCurrentSavedView={() => emptyView()}
          visible={true}
        />,
      );
    });
    const user = userEvent.setup();
    let popstateFired = false;
    window.addEventListener("popstate", () => { popstateFired = true; });
    await user.click(screen.getByText("Click me"));
    expect(window.location.hash).toBe("#b=abc-123");
    expect(popstateFired).toBe(true);
  });
});
