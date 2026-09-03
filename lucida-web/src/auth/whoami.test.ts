import { describe, it, expect } from "vitest";
import { fetchAuthState, type FetchLike } from "./whoami.ts";
import type { AuthPrincipal } from "./types.ts";

const STUB_PRINCIPAL: AuthPrincipal = {
  email: "dev@local",
  display_name: "Local Dev",
  picture_url: null,
  is_admin: false,
};

function fakeFetch(status: number, body: unknown): FetchLike {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("fetchAuthState", () => {
  it("returns authenticated principal on 200", async () => {
    const state = await fetchAuthState(fakeFetch(200, STUB_PRINCIPAL));
    expect(state).toEqual({ authenticated: true, principal: STUB_PRINCIPAL });
  });

  it("returns unauthenticated on 401 with signedOut: false", async () => {
    const state = await fetchAuthState(
      fakeFetch(401, { error: "unauthenticated", signedOut: false }),
    );
    expect(state).toEqual({ authenticated: false, signedOut: false });
  });

  it("propagates signedOut: true from the marker-aware 401 body", async () => {
    // Server's marker-aware middleware enriches the 401 with
    // `signedOut: true` when the lucida_signed_out cookie is present.
    // The SPA reads it to render UnauthLanding's static card instead
    // of auto-bouncing through Google.
    const state = await fetchAuthState(
      fakeFetch(401, { error: "unauthenticated", signedOut: true }),
    );
    expect(state).toEqual({ authenticated: false, signedOut: true });
  });

  it("returns unauthenticated on 5xx (body unparseable)", async () => {
    const state = await fetchAuthState(fakeFetch(500, "boom"));
    expect(state).toEqual({ authenticated: false });
  });

  it("returns unauthenticated when fetch throws", async () => {
    const failing: FetchLike = async () => {
      throw new Error("network down");
    };
    const state = await fetchAuthState(failing);
    expect(state).toEqual({ authenticated: false });
  });

  it("returns unauthenticated when 200 body is unparseable", async () => {
    const garbageJson: FetchLike = async () =>
      new Response("not-json", { status: 200 });
    const state = await fetchAuthState(garbageJson);
    expect(state).toEqual({ authenticated: false });
  });
});
