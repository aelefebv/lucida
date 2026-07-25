import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browse, browseUrl } from "./browseApi.ts";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let originalFetch: typeof globalThis.fetch;
let calls: FetchCall[];
let responder: (url: string) => Response;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  responder = () =>
    new Response(JSON.stringify({ path: "/", entries: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responder(url);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("browseUrl", () => {
  it("omits the query param entirely for the empty (platform-root) path", () => {
    expect(browseUrl("")).toBe("/api/browse");
  });

  it("URL-encodes a canonical-form path", () => {
    expect(browseUrl("/home/a b/set.zarr")).toBe(
      `/api/browse?path=${encodeURIComponent("/home/a b/set.zarr")}`,
    );
    // Windows drive-letter form survives encoding.
    expect(browseUrl("c:/Users/me")).toBe(
      `/api/browse?path=${encodeURIComponent("c:/Users/me")}`,
    );
  });

  it("never produces an absolute URL", () => {
    for (const p of ["", "/", "/home/me", "c:", "c:/Users/me"]) {
      expect(browseUrl(p).startsWith("/api/browse")).toBe(true);
      expect(browseUrl(p)).not.toMatch(/^[a-z]+:\/\//);
    }
  });
});

describe("browse", () => {
  it("requests the relative path with same-origin credentials", async () => {
    await browse("/home/me");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      `/api/browse?path=${encodeURIComponent("/home/me")}`,
    );
    // Load-bearing: `/api/browse` is behind the server's auth middleware,
    // so the session cookie must be attached.
    expect(calls[0].init?.credentials).toBe("same-origin");
  });

  it("returns the decoded listing", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          path: "/data",
          entries: [
            { name: "set.zarr", type: "directory" },
            { name: "notes.txt", type: "file" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const res = await browse("/data");
    expect(res.path).toBe("/data");
    expect(res.entries.map((e) => e.name)).toEqual(["set.zarr", "notes.txt"]);
  });

  it("surfaces the server's plain-text error body", async () => {
    // The handler answers `(StatusCode, String)` — plain text, not JSON.
    responder = () =>
      new Response("Path outside data directory", { status: 403 });
    await expect(browse("/etc")).rejects.toThrow(
      "Path outside data directory",
    );
  });

  it("falls back to the status line when the error body is empty", async () => {
    // Defensive branch — nothing in lucida itself answers with an empty
    // body. `browse.rs` always carries a message, and the auth middleware
    // answers a 401 with a JSON body (`{error, detail, signedOut}`), which
    // this client surfaces verbatim via the plain-text path above. An empty
    // body comes from something in between: a proxy or gateway returning a
    // bodyless status, a connection cut mid-response. Without the fallback
    // the thrown Error would carry an empty message and the modal would
    // render a blank red box. The status code here is incidental.
    responder = () => new Response("", { status: 401, statusText: "" });
    await expect(browse("")).rejects.toThrow("401");
  });
});
