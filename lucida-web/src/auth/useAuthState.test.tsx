// @vitest-environment happy-dom
//
// Tests for the `useAuthState` hook. Verifies the round-trip: initial
// whoami populates `state`, `signOut()` posts the URL the mode
// declared *then* refreshes state via whoami, flipping AuthGate from
// authed to unauth without a page reload. A mode that declares no URL
// leaves `signOut` null.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup, screen } from "@testing-library/react";
import { useAuthState } from "./useAuthState.ts";
import type { AuthPrincipal } from "./types.ts";

const fetchAuthState = vi.fn();
const fetchSignOutUrl = vi.fn();
const postSignOut = vi.fn();

vi.mock("./whoami.ts", async () => {
  const actual = await vi.importActual<typeof import("./whoami.ts")>("./whoami.ts");
  return {
    ...actual,
    fetchAuthState: (...args: unknown[]) => fetchAuthState(...args),
    fetchSignOutUrl: (...args: unknown[]) => fetchSignOutUrl(...args),
    postSignOut: (...args: unknown[]) => postSignOut(...args),
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
      <span data-testid="can-sign-out">{signOut ? "yes" : "no"}</span>
      {signOut && (
        <button data-testid="signout" onClick={() => void signOut()}>signout</button>
      )}
    </div>
  );
}

beforeEach(() => {
  fetchAuthState.mockReset();
  fetchSignOutUrl.mockReset();
  fetchSignOutUrl.mockResolvedValue("/auth/logout");
  postSignOut.mockReset();
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

  it("signOut posts the mode's URL, then refreshes — state flips to signed-out from enriched whoami", async () => {
    // No `window.location` reload: the signal travels in the refreshed
    // whoami response, which sees the marker cookie via the enriched
    // 401 body. The SPA stays mounted and AuthGate flips to the
    // SignedOutCard branch of UnauthLanding.
    fetchAuthState
      .mockResolvedValueOnce({ authenticated: true, principal: PRINCIPAL })
      .mockResolvedValueOnce({ authenticated: false, signedOut: true });
    postSignOut.mockResolvedValueOnce(undefined);

    await act(async () => {
      render(<Probe />);
    });
    expect(screen.getByTestId("state").textContent).toBe("authed:dev@local");

    await act(async () => {
      screen.getByTestId("signout").click();
    });

    expect(postSignOut).toHaveBeenCalledWith("/auth/logout");
    // Two whoami calls total: mount + post-signOut refresh.
    expect(fetchAuthState).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("state").textContent).toBe("signed-out");
  });

  it("leaves signOut null when the mode declares no sign-out URL", async () => {
    fetchAuthState.mockResolvedValue({ authenticated: true, principal: PRINCIPAL });
    fetchSignOutUrl.mockResolvedValue(null);

    await act(async () => {
      render(<Probe />);
    });

    expect(screen.getByTestId("can-sign-out").textContent).toBe("no");
    expect(postSignOut).not.toHaveBeenCalled();
  });

  it("leaves the app usable when the sign-out probe never answers", async () => {
    fetchAuthState.mockResolvedValue({ authenticated: true, principal: PRINCIPAL });
    fetchSignOutUrl.mockRejectedValue(new Error("offline"));

    await act(async () => {
      render(<Probe />);
    });

    expect(screen.getByTestId("state").textContent).toBe("authed:dev@local");
    expect(screen.getByTestId("can-sign-out").textContent).toBe("no");
  });
});
