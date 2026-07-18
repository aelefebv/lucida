// Tests for `postLogout`.
//
// Mirrors the `fetchAuthState` test pattern: hand a fake fetch in,
// assert on what the helper sends + how it tolerates failures. Pure
// network-shape tests, no DOM needed.

import { describe, it, expect } from "vitest";
import {
  LOGOUT_URL,
  LogoutRequestError,
  postLogout,
  type FetchLike,
} from "./whoami.ts";

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

  it("returns a typed retryable error when delivery is unknown", async () => {
    const failing: FetchLike = async () => {
      throw new Error("offline");
    };
    const error = await postLogout(failing).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LogoutRequestError);
    expect((error as LogoutRequestError).failure).toMatchObject({
      kind: "request_failed",
      retryable: true,
      localSession: "unknown",
    });
  });

  it("preserves the server's 503 partial-signout contract", async () => {
    const unavailable: FetchLike = async () =>
      new Response("unavailable", { status: 503 });
    const error = await postLogout(unavailable).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LogoutRequestError);
    expect((error as LogoutRequestError).failure).toMatchObject({
      kind: "partial_signout",
      retryable: true,
      localSession: "cleared",
      status: 503,
    });
  });
});
