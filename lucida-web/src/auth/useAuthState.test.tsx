// @vitest-environment happy-dom
//
// Tests for the slice-3 enhanced `useAuthState` hook (issue #459).
// Verifies the round-trip: initial whoami populates `state`,
// `signOut()` calls postLogout *then* refreshes state via whoami,
// flipping AuthGate from authed to unauth without a page reload.

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

  it("signOut posts logout, then refreshes — state flips to unauth", async () => {
    // First call (mount) returns authed. Second call (refresh after
    // signOut) returns unauth — mirrors the real server flow.
    fetchAuthState
      .mockResolvedValueOnce({ authenticated: true, principal: PRINCIPAL })
      .mockResolvedValueOnce({ authenticated: false });
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
    expect(screen.getByTestId("state").textContent).toBe("unauth");
  });
});
