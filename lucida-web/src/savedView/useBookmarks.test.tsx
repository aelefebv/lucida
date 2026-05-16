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
import type { Bridge, BookmarkChangedListener } from "../bridge.ts";
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
  outRef,
  bridge,
}: {
  loadedDatasets: string[];
  email: string | null;
  outRef: Captured;
  bridge?: Bridge | null;
}) {
  const handle = useBookmarks({
    loadedDatasets,
    currentUserEmail: email,
    bridge,
  });
  useEffect(() => {
    outRef.current = handle;
  });
  // Render something so testing-library doesn't complain.
  return <div data-testid="loaded">{handle.allBookmarks.length}</div>;
}

/** Minimal Bridge stand-in exposing only the broadcast subscription
 *  surface useBookmarks consumes. Casting to `Bridge` is safe because
 *  the hook reaches for nothing else. */
function makeStubBridge() {
  const listeners: BookmarkChangedListener[] = [];
  const stub = {
    subscribeBookmarkChanged(cb: BookmarkChangedListener) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  } as unknown as Bridge;
  return {
    bridge: stub,
    /** Fire a `bookmark_changed` broadcast at every subscriber. */
    fire: (id: string, action: "created" | "updated" | "deleted", urls: string[] = []) => {
      for (const cb of listeners.slice()) cb(id, action, urls);
    },
    listenerCount: () => listeners.length,
  };
}

describe("useBookmarks — loading lifecycle", () => {
  it("fetches on mount with the loaded-datasets query", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={["gs://a.zarr"]} email="alice@example.com" outRef={outRef} />);
    });
    expect(apiSpy.calls.some((c) => c.url.includes("dataset=gs%3A%2F%2Fa.zarr"))).toBe(true);
  });

  it("re-fetches when loadedDatasets changes", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    const outRef: Captured = { current: null };
    const { rerender } = render(
      <HookHarness loadedDatasets={["gs://a.zarr"]} email="alice@example.com" outRef={outRef} />,
    );
    await act(async () => { /* flush mount */ });
    const before = apiSpy.calls.length;
    await act(async () => {
      rerender(<HookHarness loadedDatasets={["gs://a.zarr", "gs://b.zarr"]} email="alice@example.com" outRef={outRef} />);
    });
    expect(apiSpy.calls.length).toBeGreaterThan(before);
  });

  it("does NOT re-fetch when an equivalent dataset array (different identity) is passed", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    const outRef: Captured = { current: null };
    const { rerender } = render(
      <HookHarness loadedDatasets={["gs://a.zarr"]} email="alice@example.com" outRef={outRef} />,
    );
    await act(async () => { /* flush mount */ });
    const before = apiSpy.calls.length;
    // Fresh array with same contents.
    await act(async () => {
      rerender(<HookHarness loadedDatasets={["gs://a.zarr"]} email="alice@example.com" outRef={outRef} />);
    });
    expect(apiSpy.calls.length).toBe(before);
  });

  it("populates allBookmarks from the server response", async () => {
    const items = [
      makeBm({ id: "b1", name: "first" }),
      makeBm({ id: "b2", name: "second" }),
    ];
    apiSpy.responder = () => jsonResponse(200, items);
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@example.com" outRef={outRef} />);
    });
    expect(outRef.current?.allBookmarks).toHaveLength(2);
    expect(outRef.current?.bookmarks).toHaveLength(2);
  });

  it("surfaces errors via the error field", async () => {
    apiSpy.responder = () => jsonResponse(500, { error: "internal" });
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@example.com" outRef={outRef} />);
    });
    expect(outRef.current?.error).toContain("listBookmarks");
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
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} />);
    });

    await act(async () => outRef.current?.setSearch("alice"));
    expect(outRef.current?.bookmarks.map((b) => b.id)).toEqual(["b1"]);

    await act(async () => outRef.current?.setSearch("bob"));
    expect(outRef.current?.bookmarks.map((b) => b.id)).toEqual(["b2"]);

    await act(async () => outRef.current?.setSearch("apoptosis"));
    expect(outRef.current?.bookmarks.map((b) => b.id)).toEqual(["b1"]);
  });

  it("Mine only filters by current principal's email", async () => {
    const items = [
      makeBm({ id: "b1", created_by: "alice@x" }),
      makeBm({ id: "b2", created_by: "bob@x" }),
      makeBm({ id: "b3", created_by: "alice@x" }),
    ];
    apiSpy.responder = () => jsonResponse(200, items);
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} />);
    });

    await act(async () => outRef.current?.setMineOnly(true));
    expect(outRef.current?.bookmarks.map((b) => b.id).sort()).toEqual(["b1", "b3"]);

    await act(async () => outRef.current?.setMineOnly(false));
    expect(outRef.current?.bookmarks.map((b) => b.id).sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("Mine only with no resolved principal hides everything", async () => {
    apiSpy.responder = () => jsonResponse(200, [makeBm({ id: "b1", created_by: "alice@x" })]);
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email={null} outRef={outRef} />);
    });
    await act(async () => outRef.current?.setMineOnly(true));
    expect(outRef.current?.bookmarks).toEqual([]);
  });
});

describe("useBookmarks — CRUD wrappers", () => {
  it("createBookmark POSTs and inserts the result optimistically", async () => {
    const created = makeBm({ id: "new", name: "fresh" });
    apiSpy.responder = (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(201, created);
      return jsonResponse(200, []);
    };
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} />);
    });
    await act(async () => {
      await outRef.current?.createBookmark("fresh", [], emptyView());
    });
    expect(outRef.current?.allBookmarks.find((b) => b.id === "new")).toBeDefined();
  });

  it("renameBookmark patches and reconciles in place", async () => {
    const original = makeBm({ id: "b1", name: "old" });
    const updated = { ...original, name: "new" };
    apiSpy.responder = (_url, init) => {
      if (init?.method === "PATCH") return jsonResponse(200, updated);
      return jsonResponse(200, [original]);
    };
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} />);
    });
    await act(async () => {
      await outRef.current?.renameBookmark("b1", "new");
    });
    expect(outRef.current?.allBookmarks.find((b) => b.id === "b1")?.name).toBe("new");
  });

  it("renameBookmark rolls back on failure", async () => {
    const original = makeBm({ id: "b1", name: "old" });
    apiSpy.responder = (_url, init) => {
      if (init?.method === "PATCH") return jsonResponse(403, { error: "forbidden" });
      return jsonResponse(200, [original]);
    };
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} />);
    });
    await expect(
      act(async () => {
        await outRef.current?.renameBookmark("b1", "new");
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(outRef.current?.allBookmarks.find((b) => b.id === "b1")?.name).toBe("old");
  });

  it("deleteBookmark removes the row and survives rollback on 403", async () => {
    const original = makeBm({ id: "b1" });
    apiSpy.responder = (_url, init) => {
      if (init?.method === "DELETE") return jsonResponse(403, { error: "forbidden" });
      return jsonResponse(200, [original]);
    };
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} />);
    });
    await expect(
      act(async () => {
        await outRef.current?.deleteBookmark("b1");
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Rolled back.
    expect(outRef.current?.allBookmarks.some((b) => b.id === "b1")).toBe(true);
  });
});

// Live BookmarkChanged subscription. Verifies the hook reconciles
// local state in response to bridge-dispatched broadcasts: refetch
// + merge on Created/Updated, drop on Deleted.
describe("useBookmarks — BookmarkChanged subscription", () => {
  it("subscribes when a bridge is supplied and unsubscribes on unmount", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    const stub = makeStubBridge();
    const outRef: Captured = { current: null };
    const { unmount } = render(
      <HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} bridge={stub.bridge} />,
    );
    await act(async () => { /* flush mount */ });
    expect(stub.listenerCount()).toBe(1);
    unmount();
    expect(stub.listenerCount()).toBe(0);
  });

  it("ignores broadcasts when bridge is null", async () => {
    apiSpy.responder = () => jsonResponse(200, []);
    const outRef: Captured = { current: null };
    await act(async () => {
      render(<HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} bridge={null} />);
    });
    // No bridge → never subscribes; no crash on null.
    expect(outRef.current?.allBookmarks).toEqual([]);
  });

  it("on Created: refetches the bookmark by id and inserts it", async () => {
    const created = makeBm({ id: "fresh", name: "freshly created" });
    let getCalls = 0;
    apiSpy.responder = (url, init) => {
      if (init?.method === "GET" || init?.method === undefined) {
        if (url.endsWith("/api/bookmarks/fresh")) {
          getCalls++;
          return jsonResponse(200, created);
        }
        return jsonResponse(200, []); // initial list
      }
      return jsonResponse(500, {});
    };
    const stub = makeStubBridge();
    const outRef: Captured = { current: null };
    await act(async () => {
      render(
        <HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} bridge={stub.bridge} />,
      );
    });
    expect(outRef.current?.allBookmarks).toEqual([]);
    await act(async () => {
      stub.fire("fresh", "created", ["gs://b/a.zarr"]);
    });
    // Wait a tick for the apiGet then setState to flush.
    await act(async () => { /* flush microtasks */ });
    expect(getCalls).toBe(1);
    expect(outRef.current?.allBookmarks.find((b) => b.id === "fresh")).toBeDefined();
  });

  it("on Updated: refetches and replaces existing entry in place", async () => {
    const original = makeBm({ id: "b1", name: "v1" });
    const updated = { ...original, name: "v2 (updated by peer)" };
    apiSpy.responder = (url, init) => {
      if (init?.method === "GET" || init?.method === undefined) {
        if (url.endsWith("/api/bookmarks/b1")) {
          return jsonResponse(200, updated);
        }
        return jsonResponse(200, [original]); // initial list
      }
      return jsonResponse(500, {});
    };
    const stub = makeStubBridge();
    const outRef: Captured = { current: null };
    await act(async () => {
      render(
        <HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} bridge={stub.bridge} />,
      );
    });
    expect(outRef.current?.allBookmarks.find((b) => b.id === "b1")?.name).toBe("v1");
    await act(async () => {
      stub.fire("b1", "updated");
    });
    await act(async () => { /* flush microtasks */ });
    const merged = outRef.current?.allBookmarks.find((b) => b.id === "b1");
    expect(merged?.name).toBe("v2 (updated by peer)");
    // Doesn't double the row.
    expect(outRef.current?.allBookmarks.filter((b) => b.id === "b1")).toHaveLength(1);
  });

  it("on Deleted: removes the row from local state without refetching", async () => {
    const bm = makeBm({ id: "doomed" });
    let getCalls = 0;
    apiSpy.responder = (url, init) => {
      if (init?.method === "GET" || init?.method === undefined) {
        if (url.endsWith("/api/bookmarks/doomed")) {
          getCalls++;
          return jsonResponse(404, {});
        }
        return jsonResponse(200, [bm]); // initial list
      }
      return jsonResponse(500, {});
    };
    const stub = makeStubBridge();
    const outRef: Captured = { current: null };
    await act(async () => {
      render(
        <HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} bridge={stub.bridge} />,
      );
    });
    expect(outRef.current?.allBookmarks.some((b) => b.id === "doomed")).toBe(true);
    await act(async () => {
      stub.fire("doomed", "deleted");
    });
    expect(outRef.current?.allBookmarks.some((b) => b.id === "doomed")).toBe(false);
    expect(getCalls).toBe(0); // no refetch on delete
  });

  it("self-broadcast Created after optimistic insert reconciles without duplicating", async () => {
    const created = makeBm({ id: "self", name: "my fresh" });
    apiSpy.responder = (url, init) => {
      if (init?.method === "POST") return jsonResponse(201, created);
      if (init?.method === "GET" || init?.method === undefined) {
        if (url.endsWith("/api/bookmarks/self")) return jsonResponse(200, created);
        return jsonResponse(200, []);
      }
      return jsonResponse(500, {});
    };
    const stub = makeStubBridge();
    const outRef: Captured = { current: null };
    await act(async () => {
      render(
        <HookHarness loadedDatasets={[]} email="alice@x" outRef={outRef} bridge={stub.bridge} />,
      );
    });
    await act(async () => {
      await outRef.current?.createBookmark("my fresh", [], emptyView());
    });
    expect(outRef.current?.allBookmarks.filter((b) => b.id === "self")).toHaveLength(1);
    // Self-broadcast arrives next.
    await act(async () => {
      stub.fire("self", "created");
    });
    await act(async () => { /* flush refetch */ });
    // Still exactly one entry — broadcast-driven refetch matches on id and replaces.
    expect(outRef.current?.allBookmarks.filter((b) => b.id === "self")).toHaveLength(1);
  });
});

describe("relativeTimeFromIso", () => {
  it("renders 'just now' for sub-minute deltas", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    const outRef = relativeTimeFromIso("2026-05-08T11:59:50Z", now);
    expect(outRef.toLowerCase()).toMatch(/now|second/);
  });

  it("renders 'X days ago' for multi-day deltas", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    const outRef = relativeTimeFromIso("2026-05-05T12:00:00Z", now);
    expect(outRef.toLowerCase()).toMatch(/3.*day/);
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
    const outRef = defaultBookmarkName([`gs://b/${longName}`], null);
    expect(outRef.length).toBeLessThanOrEqual(60);
    expect(outRef.endsWith("…")).toBe(true);
  });
});
