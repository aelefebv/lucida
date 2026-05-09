import { describe, it, expect, vi } from "vitest";
import {
  BookmarksApiError,
  createBookmark,
  deleteBookmark,
  getBookmark,
  listBookmarks,
  patchBookmarkName,
  type FetchLike,
} from "./bookmarksApi.ts";
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

function fakeFetch(
  status: number,
  body: unknown,
  capture?: { calls: Array<{ url: string; init?: RequestInit }> },
): FetchLike {
  return async (url: string, init?: RequestInit) => {
    capture?.calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("listBookmarks", () => {
  it("encodes empty datasets as no query string", async () => {
    const calls: Array<{ url: string }> = [];
    const list = await listBookmarks([], fakeFetch(200, [], { calls }));
    expect(list).toEqual([]);
    expect(calls[0].url).toBe("/api/bookmarks");
  });

  it("encodes multiple dataset URLs as repeated dataset= params", async () => {
    const calls: Array<{ url: string }> = [];
    await listBookmarks(["gs://a.zarr", "gs://b.zarr"], fakeFetch(200, [], { calls }));
    expect(calls[0].url).toContain("dataset=gs%3A%2F%2Fa.zarr");
    expect(calls[0].url).toContain("dataset=gs%3A%2F%2Fb.zarr");
    expect(calls[0].url).toMatch(/^\/api\/bookmarks\?dataset=/);
  });

  it("returns the parsed bookmark list", async () => {
    const items = [
      {
        id: "abc",
        name: "view A",
        created_by: "alice@example.com",
        created_by_name: "Alice",
        created_at: "2026-05-08T12:00:00Z",
        datasets: ["gs://a.zarr"],
        view: emptyView(),
      },
    ];
    const out = await listBookmarks([], fakeFetch(200, items));
    expect(out).toEqual(items);
  });

  it("throws BookmarksApiError on 5xx with detail when provided", async () => {
    const fetcher = fakeFetch(500, { error: "internal" });
    await expect(listBookmarks([], fetcher)).rejects.toMatchObject({
      name: "BookmarksApiError",
      status: 500,
    });
  });

  it("throws on 401 (caller redirects through auth)", async () => {
    const fetcher = fakeFetch(401, { error: "unauthenticated" });
    const err = await listBookmarks([], fetcher).catch((e) => e);
    expect(err).toBeInstanceOf(BookmarksApiError);
    expect(err.status).toBe(401);
  });
});

describe("getBookmark", () => {
  it("returns null on 404", async () => {
    const out = await getBookmark("missing", fakeFetch(404, { error: "not_found" }));
    expect(out).toBeNull();
  });

  it("returns the parsed bookmark on 200", async () => {
    const bm = {
      id: "abc",
      name: "view A",
      created_by: "alice",
      created_by_name: "Alice",
      created_at: "2026-05-08T12:00:00Z",
      datasets: [],
      view: emptyView(),
    };
    const out = await getBookmark("abc", fakeFetch(200, bm));
    expect(out).toEqual(bm);
  });

  it("encodes the id in the URL path", async () => {
    const calls: Array<{ url: string }> = [];
    await getBookmark("a/b c", fakeFetch(200, {
      id: "a/b c",
      name: "x",
      created_by: "x",
      created_by_name: "x",
      created_at: "2026-05-08T12:00:00Z",
      datasets: [],
      view: emptyView(),
    }, { calls }));
    expect(calls[0].url).toBe("/api/bookmarks/a%2Fb%20c");
  });
});

describe("createBookmark", () => {
  it("POSTs the body with credentials and content-type", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const created = {
      id: "abc",
      name: "x",
      created_by: "alice",
      created_by_name: "Alice",
      created_at: "2026-05-08T12:00:00Z",
      datasets: ["gs://a.zarr"],
      view: emptyView(),
    };
    await createBookmark(
      { name: "x", datasets: ["gs://a.zarr"], view: emptyView() },
      fakeFetch(201, created, { calls }),
    );
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("include");
    expect((calls[0].init?.headers as Record<string, string>)?.["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({
      name: "x",
      datasets: ["gs://a.zarr"],
    });
  });
});

describe("patchBookmarkName", () => {
  it("PATCHes only the name", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const updated = {
      id: "abc",
      name: "renamed",
      created_by: "alice",
      created_by_name: "Alice",
      created_at: "2026-05-08T12:00:00Z",
      datasets: [],
      view: emptyView(),
    };
    await patchBookmarkName("abc", "renamed", fakeFetch(200, updated, { calls }));
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ name: "renamed" });
  });

  it("throws 403 on forbidden", async () => {
    await expect(
      patchBookmarkName("abc", "x", fakeFetch(403, { error: "forbidden" })),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("deleteBookmark", () => {
  it("issues a DELETE with credentials and resolves on 204", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    };
    await deleteBookmark("abc", fetcher);
    expect(calls[0].init?.method).toBe("DELETE");
    expect(calls[0].init?.credentials).toBe("include");
  });

  it("throws on 403", async () => {
    const fetcher = fakeFetch(403, { error: "forbidden" });
    await expect(deleteBookmark("abc", fetcher)).rejects.toMatchObject({ status: 403 });
  });
});

describe("BookmarksApiError", () => {
  it("includes the status code", () => {
    const err = new BookmarksApiError(500, "boom");
    expect(err.status).toBe(500);
    expect(err.message).toBe("boom");
    expect(err.name).toBe("BookmarksApiError");
  });
});

// Sanity check: the production fetch implementation isn't called in tests
// — we always inject our own. This guards against accidental coupling.
describe("default fetch", () => {
  it("can be substituted via the optional FetchLike argument", async () => {
    const spy = vi.fn(fakeFetch(200, []));
    await listBookmarks([], spy);
    expect(spy).toHaveBeenCalledOnce();
  });
});
