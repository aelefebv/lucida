// @vitest-environment happy-dom
//
// Hook-level tests for useBookmarks. Drives the hook with a stub fetch
// (passed via global swap) so we don't need network or React's full
// testing flow for the REST contract — bookmarksApi.test.ts covers that
// directly. Here we exercise the local list/filter/optimism layer.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import {
  defaultBookmarkName,
  relativeTimeFromIso,
  useBookmarks,
  type Bookmark,
} from "./useBookmarks.ts";
import { SAVED_VIEW_VERSION, type SavedView } from "./types.ts";

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

function makeBm(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: overrides.id ?? "id-default",
    name: overrides.name ?? "Default name",
    created_by: overrides.created_by ?? "alice@example.com",
    created_by_name: overrides.created_by_name ?? "Alice",
    created_at: overrides.created_at ?? "2026-05-08T12:00:00Z",
    datasets: overrides.datasets ?? [],
    view: overrides.view ?? emptyView(),
  };
}

// ---- Fetch stub used by all tests below ----

interface ApiSpy {
  list: typeof globalThis.fetch;
  calls: Array<{ url: string; init?: RequestInit; method: string }>;
  /** Set per test to dictate the next response. */
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

let apiSpy: ApiSpy;

beforeEach(() => {
  const calls: ApiSpy["calls"] = [];
  apiSpy = {
    calls,
    list: globalThis.fetch,
    responder: () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init, method: init?.method ?? "GET" });
    return apiSpy.responder(url, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = apiSpy.list;
  vi.useRealTimers();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Render harness: drive the hook through a tiny consumer that pushes its
// state into a callback so the test can assert on it.
interface Captured {
  current: ReturnType<typeof useBookmarks> | null;
}
function HookHarness({
  loadedDatasets,
  email,
  out,
}: {
  loadedDatasets: string[];
  email: string | null;
  out: Captured;
}) {
  const handle = useBookmarks({
    loadedDatasets,
    currentUserEmail: email,
  });
  useEffect(() => {
    out.current = handle;
  });
  // Render something so testing-library doesn't complain.
  return <div data-testid="loaded">{handle.allBookmarks.length}</div>;
}

describe("useBookmarks — loading lifecycle", () => {
  it("fetches on mount with the loaded-datasets query", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={["gs://a.zarr"]} email="alice@example.com" out={out} />);
    });
    expect(apiSpy.calls.some((c) => c.url.includes("dataset=gs%3A%2F%2Fa.zarr"))).toBe(true);
  });

  it("re-fetches when loadedDatasets changes", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    const out: Captured = { current: null };
    const { rerender } = render(
      <HookHarness loadedDatasets={["gs://a.zarr"]} email="alice@example.com" out={out} />,
    );
    await act(async () => { /* flush mount */ });
    const before = apiSpy.calls.length;
    await act(async () => {
      rerender(<HookHarness loadedDatasets={["gs://a.zarr", "gs://b.zarr"]} email="alice@example.com" out={out} />);
    });
    expect(apiSpy.calls.length).toBeGreaterThan(before);
  });

  it("does NOT re-fetch when an equivalent dataset array (different identity) is passed", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    const out: Captured = { current: null };
    const { rerender } = render(
      <HookHarness loadedDatasets={["gs://a.zarr"]} email="alice@example.com" out={out} />,
    );
    await act(async () => { /* flush mount */ });
    const before = apiSpy.calls.length;
    // Fresh array with same contents.
    await act(async () => {
      rerender(<HookHarness loadedDatasets={["gs://a.zarr"]} email="alice@example.com" out={out} />);
    });
    expect(apiSpy.calls.length).toBe(before);
  });

  it("populates allBookmarks from the server response", async () => {
    const items = [
      makeBm({ id: "b1", name: "first" }),
      makeBm({ id: "b2", name: "second" }),
    ];
    apiSpy.responder = () => jsonResponse(200, items);
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@example.com" out={out} />);
    });
    expect(out.current?.allBookmarks).toHaveLength(2);
    expect(out.current?.bookmarks).toHaveLength(2);
  });

  it("surfaces errors via the error field", async () => {
    apiSpy.responder = () => jsonResponse(500, { error: "internal" });
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@example.com" out={out} />);
    });
    expect(out.current?.error).toContain("listBookmarks");
  });
});

describe("useBookmarks — filter logic", () => {
  it("substring matches against name + created_by_name + created_by", async () => {
    const items = [
      makeBm({ id: "b1", name: "Apoptosis well B7", created_by_name: "Alice", created_by: "alice@x" }),
      makeBm({ id: "b2", name: "CYP7A1 stain", created_by_name: "Bob", created_by: "bob@x" }),
      makeBm({ id: "b3", name: "Random", created_by_name: "Carol", created_by: "carol@x" }),
    ];
    apiSpy.responder = () => jsonResponse(200, items);
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" out={out} />);
    });

    await act(async () => out.current?.setSearch("alice"));
    expect(out.current?.bookmarks.map((b) => b.id)).toEqual(["b1"]);

    await act(async () => out.current?.setSearch("bob"));
    expect(out.current?.bookmarks.map((b) => b.id)).toEqual(["b2"]);

    await act(async () => out.current?.setSearch("apoptosis"));
    expect(out.current?.bookmarks.map((b) => b.id)).toEqual(["b1"]);
  });

  it("Mine only filters by current principal's email", async () => {
    const items = [
      makeBm({ id: "b1", created_by: "alice@x" }),
      makeBm({ id: "b2", created_by: "bob@x" }),
      makeBm({ id: "b3", created_by: "alice@x" }),
    ];
    apiSpy.responder = () => jsonResponse(200, items);
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" out={out} />);
    });

    await act(async () => out.current?.setMineOnly(true));
    expect(out.current?.bookmarks.map((b) => b.id).sort()).toEqual(["b1", "b3"]);

    await act(async () => out.current?.setMineOnly(false));
    expect(out.current?.bookmarks.map((b) => b.id).sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("Mine only with no resolved principal hides everything", async () => {
    apiSpy.responder = () => jsonResponse(200, [makeBm({ id: "b1", created_by: "alice@x" })]);
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email={null} out={out} />);
    });
    await act(async () => out.current?.setMineOnly(true));
    expect(out.current?.bookmarks).toEqual([]);
  });
});

describe("useBookmarks — CRUD wrappers", () => {
  it("createBookmark POSTs and inserts the result optimistically", async () => {
    const created = makeBm({ id: "new", name: "fresh" });
    apiSpy.responder = (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(201, created);
      return jsonResponse(200, []);
    };
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" out={out} />);
    });
    await act(async () => {
      await out.current?.createBookmark("fresh", [], emptyView());
    });
    expect(out.current?.allBookmarks.find((b) => b.id === "new")).toBeDefined();
  });

  it("renameBookmark patches and reconciles in place", async () => {
    const original = makeBm({ id: "b1", name: "old" });
    const updated = { ...original, name: "new" };
    apiSpy.responder = (_url, init) => {
      if (init?.method === "PATCH") return jsonResponse(200, updated);
      return jsonResponse(200, [original]);
    };
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" out={out} />);
    });
    await act(async () => {
      await out.current?.renameBookmark("b1", "new");
    });
    expect(out.current?.allBookmarks.find((b) => b.id === "b1")?.name).toBe("new");
  });

  it("renameBookmark rolls back on failure", async () => {
    const original = makeBm({ id: "b1", name: "old" });
    apiSpy.responder = (_url, init) => {
      if (init?.method === "PATCH") return jsonResponse(403, { error: "forbidden" });
      return jsonResponse(200, [original]);
    };
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" out={out} />);
    });
    await expect(
      act(async () => {
        await out.current?.renameBookmark("b1", "new");
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(out.current?.allBookmarks.find((b) => b.id === "b1")?.name).toBe("old");
  });

  it("deleteBookmark removes the row and survives rollback on 403", async () => {
    const original = makeBm({ id: "b1" });
    apiSpy.responder = (_url, init) => {
      if (init?.method === "DELETE") return jsonResponse(403, { error: "forbidden" });
      return jsonResponse(200, [original]);
    };
    const out: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" out={out} />);
    });
    await expect(
      act(async () => {
        await out.current?.deleteBookmark("b1");
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Rolled back.
    expect(out.current?.allBookmarks.some((b) => b.id === "b1")).toBe(true);
  });
});

describe("relativeTimeFromIso", () => {
  it("renders 'just now' for sub-minute deltas", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    const out = relativeTimeFromIso("2026-05-08T11:59:50Z", now);
    expect(out.toLowerCase()).toMatch(/now|second/);
  });

  it("renders 'X days ago' for multi-day deltas", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    const out = relativeTimeFromIso("2026-05-05T12:00:00Z", now);
    expect(out.toLowerCase()).toMatch(/3.*day/);
  });

  it("returns empty string for invalid ISO", () => {
    expect(relativeTimeFromIso("not-a-date")).toBe("");
  });
});

describe("defaultBookmarkName", () => {
  it("returns 'Untitled' when no datasets", () => {
    expect(defaultBookmarkName([], null)).toBe("Untitled");
    expect(defaultBookmarkName([], "Grid")).toBe("Untitled");
  });

  it("uses dataset basenames joined", () => {
    expect(defaultBookmarkName(["gs://bucket/a.zarr"], null)).toBe("a.zarr");
    expect(defaultBookmarkName(["gs://b/c.zarr", "gs://d/e.zarr"], null)).toBe("c.zarr, e.zarr");
  });

  it("appends ' · layout' when a layout name is provided", () => {
    expect(defaultBookmarkName(["gs://b/c.zarr"], "Grid")).toBe("c.zarr · Grid");
  });

  it("truncates to 60 chars with an ellipsis", () => {
    const longName = "x".repeat(80);
    const out = defaultBookmarkName([`gs://b/${longName}`], null);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });
});
