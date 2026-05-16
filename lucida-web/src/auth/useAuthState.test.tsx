// @vitest-environment happy-dom
//
// Tests for the `useAuthState` hook. Verifies the round-trip: initial
// whoami populates `state`, `signOut()` calls postLogout *then*
// refreshes state via whoami, flipping AuthGate from authed to unauth
// without a page reload.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup, screen } from "@testing-library/react";
import { useAuthState } from "./useAuthState.ts";
import type { AuthPrincipal } from "./types.ts";

// Mock the network layer so we control whoami / logout responses.
const fetchAuthState = vi.fn();
const postLogout = vi.fn();

vi.mock("./whoami.ts", async () => {
  const actual = await vi.importActual<typeof import("./whoami.ts")>("./whoami.ts");
  return {
    ...actual,
    fetchAuthState: (...args: unknown[]) => fetchAuthState(...args),
    postLogout: (...args: unknown[]) => postLogout(...args),
  };
});

const PRINCIPAL: AuthPrincipal = {
  email: "dev@local",
  display_name: "Local Dev",
  picture_url: null,
  is_admin: true,
};

function Probe() {
  const { state, signOut } = useAuthState();
  const label = (() => {
    if ("status" in state && state.status === "loading") return "loading";
    if ("authenticated" in state && state.authenticated) {
      return `authed:${state.principal.email}`;
    }
    if ("signedOut" in state && state.signedOut) return "signed-out";
    return "unauth";
  })();
  return (
    <div>
      <span data-testid="state">{label}</span>
      <button data-testid="signout" onClick={() => void signOut()}>signout</button>
    </div>
  );
}

beforeEach(() => {
  fetchAuthState.mockReset();
  postLogout.mockReset();
});

afterEach(cleanup);

describe("useAuthState", () => {
  it("populates state from whoami on mount", async () => {
    fetchAuthState.mockResolvedValueOnce({ authenticated: true, principal: PRINCIPAL });
    await act(async () => {
      render(<Probe />);
    });
    expect(screen.getByTestId("state").textContent).toBe("authed:dev@local");
    expect(fetchAuthState).toHaveBeenCalledTimes(1);
  });

  it("signOut posts logout, then refreshes — state flips to signed-out from enriched whoami", async () => {
    // Mount whoami → authed. signOut → postLogout, then refresh
    // whoami which now sees the marker cookie via the enriched 401
    // body and returns `{ authenticated: false, signedOut: true }`.
    // No window.location reload — the signal travels via the whoami
    // response, so the SPA stays mounted and AuthGate flips to the
    // SignedOutCard branch of UnauthLanding.
    fetchAuthState
      .mockResolvedValueOnce({ authenticated: true, principal: PRINCIPAL })
      .mockResolvedValueOnce({ authenticated: false, signedOut: true });
    postLogout.mockResolvedValueOnce(undefined);

    await act(async () => {
      render(<Probe />);
    });
    expect(screen.getByTestId("state").textContent).toBe("authed:dev@local");

    await act(async () => {
      screen.getByTestId("signout").click();
    });

    expect(postLogout).toHaveBeenCalledTimes(1);
    // Two whoami calls total: mount + post-signOut refresh.
    expect(fetchAuthState).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("state").textContent).toBe("signed-out");
  });
});
