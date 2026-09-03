// Mirrors the `fetchAuthState` test pattern: hand a fake fetch in,
// assert on what the helper sends and how it tolerates failures. Pure
// network-shape tests, no DOM needed.

import { describe, it, expect, vi } from "vitest";
import {
  AUTH_MODE_URL,
  fetchSignOutUrl,
  postSignOut,
  type FetchLike,
} from "./whoami.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchSignOutUrl", () => {
  it("returns the URL the mode declares", async () => {
    const calls: string[] = [];
    const fakeFetch: FetchLike = async (url) => {
      calls.push(url);
      return jsonResponse({ sign_out_url: "/auth/logout" });
    };

    expect(await fetchSignOutUrl(fakeFetch)).toBe("/auth/logout");
    expect(calls).toEqual([AUTH_MODE_URL]);
  });

  it("returns null when the mode declares no sign-out", async () => {
    const fakeFetch: FetchLike = async () => jsonResponse({ sign_out_url: null });
    expect(await fetchSignOutUrl(fakeFetch)).toBeNull();
  });

  // A call that didn't land has to stay distinguishable from "this
  // mode has no sign-out", or one blip retires a control that works.
  it("rejects on a non-200", async () => {
    const fakeFetch: FetchLike = async () => new Response("nope", { status: 404 });
    await expect(fetchSignOutUrl(fakeFetch)).rejects.toThrow("404");
  });

  it("rejects on network failure", async () => {
    const failing: FetchLike = async () => {
      throw new Error("offline");
    };
    await expect(fetchSignOutUrl(failing)).rejects.toThrow("offline");
  });

  it("rejects when the body is not the shape we expect", async () => {
    const fakeFetch: FetchLike = async () => new Response("<html>", { status: 200 });
    await expect(fetchSignOutUrl(fakeFetch)).rejects.toThrow();
  });
});

describe("postSignOut", () => {
  it("POSTs the given URL with credentials and manual redirect", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      // The real server replies 302 + Set-Cookie, which `redirect:
      // "manual"` turns into an opaqueredirect. Any resolved Response
      // stands in for that here.
      return new Response(null, { status: 302 });
    };

    await postSignOut("/auth/logout", fakeFetch);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/auth/logout");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("include");
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("does not throw on network failure", async () => {
    const failing: FetchLike = async () => {
      throw new Error("offline");
    };
    // Sign-out's user-visible promise doesn't depend on the network
    // call landing.
    await expect(postSignOut("/auth/logout", failing)).resolves.toBeUndefined();
  });

  it("does not throw on a 5xx response", async () => {
    const fiveHundred: FetchLike = async () =>
      new Response("boom", { status: 500 });
    // The follow-up whoami probe is the source of truth for "are we
    // still signed in", so this helper never inspects the status.
    const spy = vi.fn();
    await postSignOut("/auth/logout", fiveHundred).catch(spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
