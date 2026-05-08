// Tests for `postLogout` (slice 3, issue #459).
//
// Mirrors the `fetchAuthState` test pattern: hand a fake fetch in,
// assert on what the helper sends + how it tolerates failures. Pure
// network-shape tests, no DOM needed.

import { describe, it, expect, vi } from "vitest";
import { LOGOUT_URL, postLogout, type FetchLike } from "./whoami.ts";

describe("postLogout", () => {
  it("POSTs to the logout endpoint with credentials and manual redirect", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      // The real server replies 302 + Set-Cookie. With redirect:"manual"
      // fetch resolves with an opaqueredirect response; for our purposes
      // any resolved Response is fine.
      return new Response(null, { status: 302 });
    };

    await postLogout(fakeFetch);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(LOGOUT_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("include");
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("does not throw on network failure", async () => {
    const failing: FetchLike = async () => {
      throw new Error("offline");
    };
    // Should resolve, not reject — logout's user-visible promise
    // doesn't depend on the network call landing.
    await expect(postLogout(failing)).resolves.toBeUndefined();
  });

  it("does not throw on a 5xx response", async () => {
    const fiveHundred: FetchLike = async () =>
      new Response("boom", { status: 500 });
    // postLogout doesn't inspect status — the follow-up whoami probe
    // is the source of truth for "are we still logged in." We just
    // don't want this helper to throw.
    const spy = vi.fn();
    await postLogout(fiveHundred).catch(spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
